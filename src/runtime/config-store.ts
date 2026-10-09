/** 设置提交边界：快照、草稿、schema、文件身份/CAS 与原子提交。未知字段原样保留。 */
import * as fs from 'node:fs';
import { constants } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { PluginConfigDefinition } from '../sdk/plugin.js';
import type { SettingsScope, SettingsScopeTarget } from '../sdk/capabilities.js';
import { resolveAgentPaths } from '../core/paths.js';

export type PersistentSettingsScope = Exclude<SettingsScope, 'session'>;
/** 只解析路径，不创建目录；打开设置与放弃草稿不能产生磁盘副作用。 */
export function createScopedConfigStores(cwd: string) {
  const paths = resolveAgentPaths(cwd);
  const stores = { project: new PluginConfigStore(paths.projectConfigPath), global: new PluginConfigStore(paths.globalConfigPath) };
  const scopeTargets: readonly SettingsScopeTarget[] = Object.freeze([
    Object.freeze({ scope: 'project' as const, path: stores.project.path }),
    Object.freeze({ scope: 'global' as const, path: stores.global.path }),
  ]);
  return { scopeTargets, store(scope: SettingsScope = 'project'): PluginConfigStore {
    if (scope !== 'project' && scope !== 'global') throw new Error('此设置仅支持本项目或全局配置。');
    return stores[scope];
  } };
}

export interface ConfigSnapshot { readonly path: string; readonly revision: string; readonly value: Readonly<Record<string, unknown>> }
interface State { raw: Record<string, unknown>; bytes?: Buffer; dev?: number; ino?: number; mode?: number }
export class ConfigConflictError extends Error { constructor(message = '配置已变化，请重新打开草稿。') { super(message); this.name = 'ConfigConflictError'; } }
const records = new WeakMap<ConfigSnapshot, State>();
const fieldSelections = new WeakMap<ConfigSnapshot, readonly string[]>();
/** 不把 JSON 片段、插件抛出的原文或凭据带入 UI。 */
export function settingsErrorMessage(error: unknown): string {
  if (error instanceof ConfigConflictError) return '配置已变化或另一个设置正在保存，请重新打开设置。';
  if (error instanceof SyntaxError) return '配置不是合法 JSON，请修正后重试。';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && Object.hasOwn(constants.errno, code)) return `配置读写失败（${code}）。`;
  return '设置验证或保存失败，请检查配置格式、字段和值后重试。';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
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
    if (!isRecord(raw)) throw new Error('配置必须为 JSON 对象。');
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
function snapshot(path: string, state: State, selector?: string | readonly string[]): ConfigSnapshot {
  const all = state.raw.pluginConfig;
  if (all !== undefined && !isRecord(all)) throw new Error('pluginConfig 必须为 JSON 对象。');
  const configured = Array.isArray(selector)
    ? Object.fromEntries(selector.filter(field => Object.hasOwn(state.raw, field)).map(field => [field, state.raw[field]]))
    : selector === undefined ? state.raw.capabilities ?? {} : all && Object.hasOwn(all, selector as string) ? all[selector as string] : {};
  if (!isRecord(configured)) throw new Error('配置命名空间必须为 JSON 对象。');
  const value = structuredClone(configured);
  const result = Object.freeze({ path, revision: createHash('sha256').update(state.bytes ?? '').digest('hex'), value: Object.freeze(value) });
  records.set(result, state);
  if (Array.isArray(selector)) fieldSelections.set(result, [...selector]);
  return result;
}
export class PluginConfigStore {
  constructor(readonly path: string) { this.path = resolve(path); }
  read(pluginId: string): ConfigSnapshot { return snapshot(this.path, read(this.path), pluginId); }
  readFields(fields: readonly string[]): ConfigSnapshot { return snapshot(this.path, read(this.path), fields); }
  /** 仅修改快照声明的顶层字段；其他字段与命名空间保持原样。 */
  commitFields(base: ConfigSnapshot, patch: Record<string, unknown>): ConfigSnapshot {
    const fields = fieldSelections.get(base);
    if (base.path !== this.path || !records.has(base) || !fields || !isRecord(patch) || Object.keys(patch).some(field => !fields.includes(field))) throw new Error('无效配置快照或字段。');
    const raw = { ...records.get(base)!.raw };
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined) delete raw[field]; else raw[field] = structuredClone(value);
    }
    return this.write(base, raw, fields);
  }
  readCapabilities(): ConfigSnapshot { return snapshot(this.path, read(this.path)); }
  commitCapabilities(base: ConfigSnapshot, selections: Record<string, string | false>): ConfigSnapshot {
    if (base.path !== this.path || !records.has(base)) throw new Error('无效配置快照。');
    return this.write(base, { ...records.get(base)!.raw, capabilities: structuredClone(selections) });
  }
  commit(pluginId: string, base: ConfigSnapshot, draft: unknown, definition: PluginConfigDefinition = {}): ConfigSnapshot {
    if (base.path !== this.path || !records.has(base)) throw new Error('无效配置快照。');
    const original = records.get(base)!;
    const parsed = definition.schema ? definition.schema.parse(draft) : draft;
    if (!isRecord(parsed)) throw new Error('插件配置必须是普通对象。');
    for (const field of definition.sensitiveFields ?? []) {
      const value = (parsed as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error(`敏感字段 ${field} 只允许 env:NAME 引用。`);
    }
    const previous = (original.raw.pluginConfig as Record<string, Record<string, unknown>> | undefined)?.[pluginId] ?? {};
    const next = { ...previous, ...structuredClone(parsed) };
    // schema 只承诺 parse；显式字段所有权区分“删除可选值”和“未知字段被 schema 丢弃”。
    for (const field of definition.ownedFields ?? []) {
      if (!Object.hasOwn(parsed, field) || (parsed as Record<string, unknown>)[field] === undefined) delete next[field];
    }
    const raw = { ...original.raw, pluginConfig: { ...(original.raw.pluginConfig as object ?? {}), [pluginId]: next } };
    return this.write(base, raw, pluginId);
  }
  private write(base: ConfigSnapshot, raw: Record<string, unknown>, selector?: string | readonly string[]): ConfigSnapshot {
    const original = records.get(base)!;
    const bytes = Buffer.from(JSON.stringify(raw, null, 2) + '\n');
    const lock = this.path + '.settings.lock';
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    let lockFd: number | undefined; let fd: number | undefined; let created = false;
    try {
      fs.mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigConflictError('另一个设置保存正在进行。'); throw error; }
      unchanged(this.path, original);
      fd = fs.openSync(temporary, 'wx', 0o600); created = true;
      fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, original.mode ?? 0o600); fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd); fs.closeSync(fd); fd = undefined;
      unchanged(this.path, original);
      fs.renameSync(temporary, this.path); created = false;
      return snapshot(this.path, { raw, bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 }, selector);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) { try { fs.unlinkSync(temporary); } catch {} }
      if (lockFd !== undefined) { fs.closeSync(lockFd); try { fs.unlinkSync(lock); } catch {} }
    }
  }
}
