/** 设置提交边界：快照、草稿、schema、文件身份/CAS 与原子提交。未知字段原样保留。 */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { PluginConfigDefinition } from '../sdk/plugin.js';

export interface ConfigSnapshot { readonly path: string; readonly revision: string; readonly value: Readonly<Record<string, unknown>> }
interface State { raw: Record<string, unknown>; bytes?: Buffer; dev?: number; ino?: number; mode?: number }
export class ConfigConflictError extends Error { constructor(message = '配置已变化，请重新打开草稿。') { super(message); this.name = 'ConfigConflictError'; } }
const records = new WeakMap<ConfigSnapshot, State>();
function read(path: string): State {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('配置必须是普通文件，不能是符号链接。');
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile()) throw new ConfigConflictError();
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(path);
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw new ConfigConflictError();
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须为 JSON 对象。');
    return { raw: raw as Record<string, unknown>, bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 };
  } catch (error) {
    if (fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return { raw: {} };
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function unchanged(path: string, old: State): void {
  const now = read(path);
  if (now.dev !== old.dev || now.ino !== old.ino || now.mode !== old.mode || Boolean(now.bytes) !== Boolean(old.bytes) || (now.bytes && old.bytes && !now.bytes.equals(old.bytes))) throw new ConfigConflictError();
}
function snapshot(path: string, state: State, pluginId?: string): ConfigSnapshot {
  const all = state.raw.pluginConfig as Record<string, unknown> | undefined;
  const value = structuredClone(pluginId === undefined ? state.raw.capabilities ?? {} : all?.[pluginId] ?? {}) as Record<string, unknown>;
  const result = Object.freeze({ path, revision: createHash('sha256').update(state.bytes ?? '').digest('hex'), value: Object.freeze(value) });
  records.set(result, state);
  return result;
}
export class PluginConfigStore {
  constructor(readonly path: string) { this.path = resolve(path); }
  read(pluginId: string): ConfigSnapshot { return snapshot(this.path, read(this.path), pluginId); }
  readCapabilities(): ConfigSnapshot { return snapshot(this.path, read(this.path)); }
  commitCapabilities(base: ConfigSnapshot, selections: Record<string, string | false>): ConfigSnapshot {
    if (base.path !== this.path || !records.has(base)) throw new Error('无效配置快照。');
    return this.write(base, { ...records.get(base)!.raw, capabilities: structuredClone(selections) });
  }
  commit(pluginId: string, base: ConfigSnapshot, draft: unknown, definition: PluginConfigDefinition = {}): ConfigSnapshot {
    if (base.path !== this.path || !records.has(base)) throw new Error('无效配置快照。');
    const original = records.get(base)!;
    const parsed = definition.schema ? definition.schema.parse(draft) : draft;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('插件配置必须是对象。');
    for (const field of definition.sensitiveFields ?? []) {
      const value = (parsed as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error(`敏感字段 ${field} 只允许 env:NAME 引用。`);
    }
    const raw = { ...original.raw, pluginConfig: { ...(original.raw.pluginConfig as object ?? {}), [pluginId]: { ...((original.raw.pluginConfig as Record<string, object> | undefined)?.[pluginId] ?? {}), ...structuredClone(parsed) } } };
    return this.write(base, raw, pluginId);
  }
  private write(base: ConfigSnapshot, raw: Record<string, unknown>, pluginId?: string): ConfigSnapshot {
    const original = records.get(base)!;
    const bytes = Buffer.from(JSON.stringify(raw, null, 2) + '\n');
    const lock = this.path + '.settings.lock';
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let lockFd: number | undefined; let fd: number | undefined; let created = false;
    try {
      try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigConflictError('另一个设置保存正在进行。'); throw error; }
      unchanged(this.path, original);
      fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, original.mode ?? 0o600); fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd); fs.closeSync(fd); fd = undefined;
      unchanged(this.path, original);
      fs.renameSync(temporary, this.path); created = false;
      return snapshot(this.path, { raw, bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 }, pluginId);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) { try { fs.unlinkSync(temporary); } catch {} }
      if (lockFd !== undefined) { fs.closeSync(lockFd); try { fs.unlinkSync(lock); } catch {} }
    }
  }
}
