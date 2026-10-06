/**
 * 会话文件的读写。只认路径，不认 loop。
 * 校验失败一律不碰磁盘。load 返回 JSON.parse 的原对象，不用 zod 的输出。
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { enqueueWrite, writeFileAtomic } from './atomic.js';
import { errnoCode, invalidIdMessage, SessionError } from './errors.js';
import { withSessionLock } from './locking.js';
import { assertSafeHistory } from './history.js';
import { formatInvalidSchema, SessionFileSchema, SessionMetaSchema } from './schema.js';
import { SESSION_SCHEMA_VERSION, type SessionFile, type SessionListing, type SessionSummary } from './types.js';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function sessionsDir(cwd: string): string {
  return join(cwd, '.agentlab', 'sessions');
}

export function isValidSessionId(id: string): boolean {
  return ID_RE.test(id);
}

export function newSessionId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `s-${stamp}-${randomBytes(2).toString('hex')}`;
}

export function sessionPath(cwd: string, id: string): string {
  if (!isValidSessionId(id)) throw new SessionError('invalid_id', invalidIdMessage(id));
  const dir = resolve(sessionsDir(cwd));
  const path = join(dir, `${id}.json`);
  if (dirname(resolve(path)) !== dir) throw new SessionError('invalid_id', invalidIdMessage(id));
  return path;
}

export interface SaveSessionOptions {
  /** 删除成功后显式发起的新保存可以重建；旧排队写入不能带此授权。 */
  recreate?: boolean;
}

export async function saveSession(file: SessionFile, options: SaveSessionOptions = {}): Promise<string> {
  return (await saveSessionVersioned(file, options)).path;
}

/** 返回提交版本供 SessionManager 跟踪；不修改调用方传入的快照。 */
export async function saveSessionVersioned(file: SessionFile, options: SaveSessionOptions = {}): Promise<{ path: string; revision: number }> {
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
  return enqueueWrite(path, () => withSessionLock(path, async () => {
    const state = await diskRevision(snapshot.cwd, snapshot.id);
    const expected = snapshot.revision ?? 0;
    if (expected !== state.revision && !(recreate && !state.exists)) {
      throw new SessionError('conflict', `会话 ${file.id} 已被其他进程更新或删除（当前版本 ${state.revision}，本地版本 ${expected}）。未覆盖磁盘历史；请先保留内存历史，再恢复最新会话。`, { path });
    }
    if (!state.exists && state.deleted && !recreate) {
      throw new SessionError('conflict', `会话 ${file.id} 已删除，旧写入不能重建。请显式发起新的保存。`, { path });
    }
    const revision = state.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new SessionError('conflict', '会话版本超出安全整数范围，未覆盖历史。', { path });
    await writeFileAtomic(path, JSON.stringify({ ...snapshot, revision }, null, 2) + '\n');
    return { path, revision };
  }));
}

export async function loadSession(cwd: string, id: string): Promise<SessionFile> {
  const path = sessionPath(cwd, id);
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new SessionError(
        'not_found',
        `找不到会话 ${id}（${path}）。用 /sessions 查看本项目已保存的会话。`,
        { cause: err, path },
      );
    }
    throw new SessionError('io', `读取会话失败: ${path}（${errnoCode(err)}）。`, { cause: err, path });
  }
  const raw = parseSessionJson(text, path);
  assertSupportedVersion(raw, path);
  const parsed = SessionFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SessionError('invalid_schema', formatInvalidSchema(path, parsed.error), { path });
  }
  const file = hydrate(raw as SessionFile);
  assertSafeHistory(file.messages);
  return file;
}

export async function listSessions(cwd: string): Promise<SessionListing> {
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
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isValidSessionId(id)) continue;
    const path = join(dir, name);
    try {
      const text = await fs.readFile(path, 'utf8');
      const raw = parseSessionJson(text, path);
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

export async function deleteSession(cwd: string, id: string): Promise<boolean> {
  const path = sessionPath(cwd, id);
  // 同进程删除排在已提交的写入后，跨进程用锁与删除版本防止旧写入复活。
  return enqueueWrite(path, () => withSessionLock(path, async () => {
    const state = await diskRevision(cwd, id);
    if (!state.exists) return false;
    try {
      await writeFileAtomic(`${path}.deleted`, JSON.stringify({ revision: state.revision + 1 }) + '\n');
      await fs.unlink(path);
      return true;
    } catch (err) {
      if (err instanceof SessionError) throw err;
      throw new SessionError('io', `删除会话失败: ${path}（${errnoCode(err)}）。`, { cause: err, path });
    }
  }));
}

async function diskRevision(cwd: string, id: string): Promise<{ exists: boolean; deleted: boolean; revision: number }> {
  const path = sessionPath(cwd, id);
  try {
    const current = await loadSession(cwd, id);
    return { exists: true, deleted: false, revision: current.revision ?? 0 };
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

export async function latestSessionId(cwd: string): Promise<string | undefined> {
  const listing = await listSessions(cwd);
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
  if (typeof version === 'number' && Number.isInteger(version) && version > SESSION_SCHEMA_VERSION) {
    throw new SessionError(
      'unsupported_version',
      `会话文件的 schemaVersion 是 ${version}，当前版本只认 1。请升级 AgentLab 后再加载: ${path}`,
      { path },
    );
  }
}

/** 把规则数组的缺省补到原对象上，不替换 messages，避免 zod 默认值另造一份历史。 */
function hydrate(raw: SessionFile): SessionFile {
  raw.sessionRules ??= { allow: [], ask: [], deny: [] };
  raw.sessionRules.allow ??= [];
  raw.sessionRules.ask ??= [];
  raw.sessionRules.deny ??= [];
  return raw;
}
