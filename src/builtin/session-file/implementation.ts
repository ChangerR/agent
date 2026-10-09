/**
 * 会话文件的读写。只认路径，不认 loop。
 * 校验失败一律不碰磁盘。load 返回 JSON.parse 的原对象，不用 zod 的输出。
 */
import { resolveAgentPaths } from '../../core/paths.js';
import { isValidSessionId } from '../../core/session/identity.js';
export { isValidSessionId, newSessionId } from '../../core/session/identity.js';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { enqueueWrite, writeFileAtomic } from '../../core/session/atomic.js';
import { errnoCode, invalidIdMessage, SessionError } from '../../core/session/errors.js';
import { withSessionLock } from '../../core/session/locking.js';
import { assertSafeHistory } from '../../core/session/history.js';
import { formatInvalidSchema, SessionFileSchema, SessionMetaSchema } from '../../core/session/schema.js';
import { SESSION_SCHEMA_VERSION, type SessionFile, type SessionListing, type SessionSummary } from '../../core/session/types.js';

export function sessionsDir(cwd: string): string {
  return resolveAgentPaths(cwd).sessionsDir;
}

export function sessionPath(cwd: string, id: string): string {
  if (!isValidSessionId(id)) throw new SessionError('invalid_id', invalidIdMessage(id));
  const dir = resolve(sessionsDir(cwd));
  const path = join(dir, `${id}.json`);
  if (dirname(resolve(path)) !== dir) throw new SessionError('invalid_id', invalidIdMessage(id));
  return path;
}

export type { SaveSessionOptions } from '../../sdk/runtime-capabilities.js';
import type { SaveSessionOptions } from '../../sdk/runtime-capabilities.js';

export async function saveSession(file: SessionFile, options: SaveSessionOptions = {}, signal?: AbortSignal): Promise<string> {
  return (await saveSessionVersioned(file, options, signal)).path;
}

/** 返回提交版本供 SessionManager 跟踪；不修改调用方传入的快照。 */
export async function saveSessionVersioned(file: SessionFile, options: SaveSessionOptions = {}, signal?: AbortSignal): Promise<{ path: string; revision: number }> {
  signal?.throwIfAborted();
  if (!isValidSessionId(file.id)) throw new SessionError('invalid_id', invalidIdMessage(file.id));
  if (!isAbsolute(file.cwd)) {
    throw new SessionError('invalid_schema', `会话文件结构不合法: ${file.cwd} cwd 必须是绝对路径`);
  }
  const path = sessionPath(file.cwd, file.id);
  const parsed = SessionFileSchema.safeParse(file);
  if (!parsed.success) {
    throw new SessionError('invalid_schema', formatInvalidSchema(path, parsed.error), { path });
  }
  assertSafeHistory(file.messages);
  const snapshot = JSON.parse(JSON.stringify(file)) as SessionFile;
  const recreate = options.recreate === true;
  const recreateRevision = options.recreateRevision;
  return enqueueWrite(path, () => withSessionLock(path, async () => {
    signal?.throwIfAborted();
    const state = await diskRevision(snapshot.cwd, snapshot.id, signal);
    const expected = snapshot.revision;
    // 重建只能针对已知的那次删除，不能越过其他写入者后续的重建 / 删除。
    const canRecreate = recreate && !state.exists && state.deleted
      && state.revision === (recreateRevision ?? expected + 1);
    if (expected !== state.revision && !canRecreate) {
      throw new SessionError('conflict', `会话 ${file.id} 已被其他进程更新或删除（当前版本 ${state.revision}，本地版本 ${expected}）。未覆盖磁盘历史；请先保留内存历史，再恢复最新会话。`, { path });
    }
    if (!state.exists && state.deleted && !canRecreate) {
      throw new SessionError('conflict', `会话 ${file.id} 已删除，旧写入不能重建。请显式发起新的保存。`, { path });
    }
    const revision = state.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new SessionError('conflict', '会话版本超出安全整数范围，未覆盖历史。', { path });
    signal?.throwIfAborted();
    // 提交边界：从原子写开始不再用取消覆盖成功结果。
    await writeFileAtomic(path, JSON.stringify({ ...snapshot, revision }, null, 2) + '\n');
    return { path, revision };
  }, signal));
}

export async function loadSession(cwd: string, id: string, signal?: AbortSignal): Promise<SessionFile> {
  signal?.throwIfAborted();
  const path = sessionPath(cwd, id);
  let text: string;
  try {
    text = await fs.readFile(path, { encoding: 'utf8', signal });
  } catch (err) {
    signal?.throwIfAborted();
    if (errnoCode(err) === 'ENOENT') {
      throw new SessionError(
        'not_found',
        `找不到会话 ${id}（${path}）。用 /sessions 查看本项目已保存的会话。`,
        { cause: err, path },
      );
    }
    throw new SessionError('io', `读取会话失败: ${path}（${errnoCode(err)}）。`, { cause: err, path });
  }
  signal?.throwIfAborted();
  const raw = parseSessionJson(text, path);
  assertSupportedVersion(raw, path);
  const parsed = SessionFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SessionError('invalid_schema', formatInvalidSchema(path, parsed.error), { path });
  }
  const file = raw as SessionFile;
  assertSafeHistory(file.messages);
  return file;
}

export async function listSessions(cwd: string, signal?: AbortSignal): Promise<SessionListing> {
  signal?.throwIfAborted();
  const dir = sessionsDir(cwd);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { sessions: [], broken: [] };
    throw new SessionError('io', `读取会话目录失败: ${dir}（${errnoCode(err)}）。`, { cause: err, path: dir });
  }

  const sessions: SessionSummary[] = [];
  const broken: SessionListing['broken'] = [];
  signal?.throwIfAborted();
  for (const name of names) {
    signal?.throwIfAborted();
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isValidSessionId(id)) continue;
    const path = join(dir, name);
    try {
      const text = await fs.readFile(path, { encoding: 'utf8', signal });
      const raw = parseSessionJson(text, path);
      assertSupportedVersion(raw, path);
      const meta = SessionMetaSchema.safeParse(raw);
      if (!meta.success) {
        broken.push({ id, path, error: new SessionError('invalid_schema', formatInvalidSchema(path, meta.error), { path }) });
        continue;
      }
      const obj = raw as {
        title: string;
        createdAt: string;
        updatedAt: string;
        model: string;
        stats?: { messages?: number };
        messages?: unknown[];
      };
      sessions.push({
        id,
        title: obj.title,
        createdAt: obj.createdAt,
        updatedAt: obj.updatedAt,
        model: obj.model,
        messageCount: obj.stats?.messages ?? obj.messages?.length ?? 0,
        path,
      });
    } catch (err) {
      signal?.throwIfAborted();
      const error = err instanceof SessionError
        ? err
        : new SessionError('io', `读取会话失败: ${path}（${errnoCode(err)}）。`, { cause: err, path });
      broken.push({ id, path, error });
    }
  }

  sessions.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });
  return { sessions, broken };
}

export async function deleteSession(cwd: string, id: string, signal?: AbortSignal): Promise<boolean> {
  return (await deleteSessionVersioned(cwd, id, signal)).deleted;
}

/** 在删除锁内返回实际删除版本，避免读取墓碑时已被其他写入者推进。 */
export async function deleteSessionVersioned(cwd: string, id: string, signal?: AbortSignal): Promise<{ deleted: boolean; revision: number }> {
  signal?.throwIfAborted();
  const path = sessionPath(cwd, id);
  // 同进程删除排在已提交的写入后，跨进程用锁与删除版本防止旧写入复活。
  return enqueueWrite(path, () => withSessionLock(path, async () => {
    signal?.throwIfAborted();
    const state = await diskRevision(cwd, id, signal);
    if (!state.exists) return { deleted: false, revision: state.revision };
    signal?.throwIfAborted();
    // 墓碑 + 删除是同一次提交，开始后必须完成并返回真实结果。
    try {
      await writeFileAtomic(`${path}.deleted`, JSON.stringify({ revision: state.revision + 1 }) + '\n');
      await fs.unlink(path);
      return { deleted: true, revision: state.revision + 1 };
    } catch (err) {
      if (err instanceof SessionError) throw err;
      throw new SessionError('io', `删除会话失败: ${path}（${errnoCode(err)}）。`, { cause: err, path });
    }
  }, signal));
}

async function diskRevision(cwd: string, id: string, signal?: AbortSignal): Promise<{ exists: boolean; deleted: boolean; revision: number }> {
  const path = sessionPath(cwd, id);
  try {
    const current = await loadSession(cwd, id, signal);
    return { exists: true, deleted: false, revision: current.revision };
  } catch (error) {
    if (!(error instanceof SessionError) || error.code !== 'not_found') throw error;
  }
  try {
    const marker: unknown = JSON.parse(await fs.readFile(`${path}.deleted`, 'utf8'));
    const revision = (marker as { revision?: unknown })?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid revision');
    return { exists: false, deleted: true, revision };
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return { exists: false, deleted: false, revision: 0 };
    throw new SessionError('corrupt', `会话删除标记不合法，未覆盖: ${path}.deleted`, { cause: error, path });
  }
}

export async function latestSessionId(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const listing = await listSessions(cwd, signal);
  return listing.sessions[0]?.id;
}

function parseSessionJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SessionError(
      'corrupt',
      `会话文件不是合法 JSON，已保留原文件不作修改: ${path}（${detail}）`,
      { cause: err, path },
    );
  }
}

function assertSupportedVersion(raw: unknown, path: string): void {
  if (!raw || typeof raw !== 'object') return;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === 'number' && Number.isInteger(version) && version !== SESSION_SCHEMA_VERSION) {
    throw new SessionError(
      'unsupported_version',
      `会话文件的 schemaVersion 是 ${version}，当前仅支持 schemaVersion=${SESSION_SCHEMA_VERSION} 且带完整身份和 runtime envelope 的会话，无法加载此格式: ${path}`,
      { path },
    );
  }
}
