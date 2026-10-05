/**
 * 会话文件的读写。只认路径，不认 loop。
 * 校验失败一律不碰磁盘。load 返回 JSON.parse 的原对象，不用 zod 的输出。
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { enqueueWrite, writeFileAtomic } from './atomic.js';
import { errnoCode, invalidIdMessage, SessionError } from './errors.js';
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

export async function saveSession(file: SessionFile): Promise<string> {
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
  const data = JSON.stringify(file, null, 2) + '\n';
  await enqueueWrite(path, () => writeFileAtomic(path, data));
  return path;
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
  try {
    await fs.unlink(path);
    return true;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw new SessionError('io', `删除会话失败: ${path}（${errnoCode(err)}）。`, { cause: err, path });
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
