/** 权限设置的独立持久化边界：保留未知字段，不把运行时配置重新序列化。 */
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentConfigSchema, PermissionModeSchema, type PermissionMode } from '../../core/config.js';
import { getGlobalConfigPath, resolveAgentPaths } from '../../core/paths.js';
import { parseRule, type SessionRules } from './engine.js';

export interface PermissionConfigDraft {
  /** undefined 表示继承全局/内置默认。 */
  permissionMode?: PermissionMode;
  /** undefined 继承全局；空字符串明确跟随当前主模型。 */
  judgeModel?: string;
  permissions: SessionRules;
}

/** 原始配置只留在模块内部，UI 不会拿到凭据或其他未知字段。 */
export interface PermissionConfigSnapshot extends PermissionConfigDraft {
  readonly path: string;
  readonly exists: boolean;
  readonly scope: PermissionConfigScope;
}

export type PermissionConfigScope = 'project' | 'global';

type FileState = { bytes: Buffer; dev: number; ino: number; mode: number };
const snapshots = new WeakMap<PermissionConfigSnapshot, { state?: FileState; raw: Record<string, unknown> }>();

export class PermissionConfigError extends Error {
  constructor(readonly code: 'invalid' | 'unsafe' | 'conflict' | 'io', message: string) {
    super(message);
    this.name = 'PermissionConfigError';
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function readFileState(path: string): FileState | undefined {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new PermissionConfigError('unsafe', '配置不是普通文件；为保护原文件，已停止读取或保存。');
    fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new PermissionConfigError('conflict', '配置文件已变化，请重新打开对应范围的设置。');
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || stat.dev !== after.dev || stat.ino !== after.ino) throw new PermissionConfigError('conflict', '配置文件已变化，请重新打开对应范围的设置。');
    return { bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 };
  } catch (error) {
    if (errorCode(error) === 'ENOENT' && fd === undefined) return undefined;
    if (error instanceof PermissionConfigError) throw error;
    throw new PermissionConfigError('io', '无法读取权限配置，请检查文件权限后重试。');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 读取错误不泄露原始配置 */ } }
  }
}

function decode(state: FileState | undefined): Record<string, unknown> {
  if (!state) return {};
  try {
    const value: unknown = JSON.parse(state.bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const raw = value as Record<string, unknown>;
    const permissionMode = fieldValue(raw, 'permissionMode');
    const judgeModel = fieldValue(raw, 'judgeModel');
    const permissions = fieldValue(raw, 'permissions');
    AgentConfigSchema.parse({ ...raw, permissionMode, judgeModel, permissions });
    const rules = permissions as Partial<SessionRules> | undefined;
    for (const kind of ['allow', 'ask', 'deny'] as const) for (const rule of rules?.[kind] ?? []) parseRule(rule);
    return raw;
  } catch {
    // JSON / schema 错误可能包含配置值，禁止把原始错误透传给终端。
    throw new PermissionConfigError('invalid', '配置不是有效的 AgentLab JSON 配置，未修改文件。请先修复原文件。');
  }
}

const fieldNamespaces = { permissionMode: 'agentlab.policy-legacy', permissions: 'agentlab.policy-legacy', judgeModel: 'agentlab.reviewer-model' } as const;
type PermissionField = keyof typeof fieldNamespaces;
function namespace(raw: Record<string, unknown>, field: PermissionField): Record<string, unknown> | undefined {
  return (raw.pluginConfig as Record<string, Record<string, unknown>> | undefined)?.[fieldNamespaces[field]];
}
/** 只解释当前文件中的别名，不读取另一层或把 schema 默认值放入草稿。 */
function fieldValue(raw: Record<string, unknown>, field: PermissionField): unknown {
  const namespaced = namespace(raw, field)?.[field];
  if (namespaced !== undefined && Object.hasOwn(raw, field) && !isDeepStrictEqual(raw[field], namespaced)) throw new Error('conflicting permission aliases');
  return namespaced !== undefined ? namespaced : raw[field];
}

export function readPermissionConfig(path: string, scope: PermissionConfigScope = 'project'): PermissionConfigSnapshot {
  path = resolve(path);
  const state = readFileState(path);
  const raw = decode(state);
  const rules = fieldValue(raw, 'permissions') as Partial<SessionRules> | undefined;
  const snapshot: PermissionConfigSnapshot = Object.freeze({
    path,
    exists: state !== undefined,
    scope,
    permissionMode: fieldValue(raw, 'permissionMode') as PermissionMode | undefined,
    judgeModel: fieldValue(raw, 'judgeModel') as string | undefined,
    permissions: { allow: [...(rules?.allow ?? [])], ask: [...(rules?.ask ?? [])], deny: [...(rules?.deny ?? [])] },
  });
  snapshots.set(snapshot, { state, raw });
  return snapshot;
}

export function readProjectPermissionConfig(cwd: string): PermissionConfigSnapshot {
  return readPermissionConfig(resolveAgentPaths(cwd).projectConfigPath, 'project');
}

export function readGlobalPermissionConfig(path = getGlobalConfigPath()): PermissionConfigSnapshot {
  return readPermissionConfig(path, 'global');
}

export function copyPermissionDraft(source: PermissionConfigDraft): PermissionConfigDraft {
  return { permissionMode: source.permissionMode, judgeModel: source.judgeModel,
    permissions: { allow: [...source.permissions.allow], ask: [...source.permissions.ask], deny: [...source.permissions.deny] } };
}

export function validatePermissionRule(value: string): string | undefined {
  if (!value.trim()) return '规则不能为空，例如 read_file 或 bash(npm test*)。';
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return '规则必须是单行文本；特殊字符请使用 JSON 精确匹配语法。';
  try { parseRule(value); } catch { return '规则格式无效。示例：read_file、edit_file(src/**)、bash(="npm test")。'; }
  return undefined;
}

function assertUnchanged(path: string, expected: FileState | undefined): void {
  const actual = readFileState(path);
  if ((!actual !== !expected) || (actual && expected &&
    (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mode !== expected.mode || !actual.bytes.equals(expected.bytes)))) {
    throw new PermissionConfigError('conflict', '配置在打开设置后已被其他程序修改。更改未保存；请返回并重新打开对应范围的设置后重做更改。');
  }
}

/** 无更改提交也必须检查原始文件身份，防止陈旧面板绕过 CAS。 */
export function assertPermissionConfigUnchanged(snapshot: PermissionConfigSnapshot): void {
  const original = snapshots.get(snapshot);
  if (!original) throw new PermissionConfigError('invalid', '配置快照无效，请重新打开对应范围的设置。');
  assertUnchanged(snapshot.path, original.state);
}

/** 同目录临时文件 + fsync + rename；提交前重读快照，失败不删除或截断目标文件。 */
export function savePermissionConfig(snapshot: PermissionConfigSnapshot, draft: PermissionConfigDraft): PermissionConfigSnapshot {
  const original = snapshots.get(snapshot);
  if (!original) throw new PermissionConfigError('invalid', '配置快照无效，请重新打开对应范围的设置。');
  const next = { ...original.raw };
  if (draft.permissionMode !== undefined) {
    const parsed = PermissionModeSchema.safeParse(draft.permissionMode);
    if (!parsed.success) throw new PermissionConfigError('invalid', '权限模式无效，未修改文件。');
  }
  if (draft.judgeModel !== undefined) {
    if (typeof draft.judgeModel !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(draft.judgeModel)) throw new PermissionConfigError('invalid', '审批模型名称必须是单行文本。');
  }
  for (const kind of ['allow', 'ask', 'deny'] as const) {
    if (!Array.isArray(draft.permissions[kind]) || draft.permissions[kind].some(rule => typeof rule !== 'string' || validatePermissionRule(rule))) throw new PermissionConfigError('invalid', '权限规则无效，未修改文件。');
  }
  const writeField = (field: PermissionField, value: unknown): void => {
    const priorNamespace = namespace(original.raw, field);
    const hasNamespace = priorNamespace !== undefined && Object.hasOwn(priorNamespace, field);
    const hasLegacy = Object.hasOwn(original.raw, field);
    const update = (container: Record<string, unknown>) => {
      if (value === undefined) delete container[field];
      else container[field] = field === 'permissions' ? { ...(container[field] as object ?? {}), ...value as object } : value;
    };
    // 已有写法保持原位；同值双写同步更新。删除可选字段不留下旧别名。
    if (hasLegacy || !hasNamespace) update(next);
    if (hasNamespace) {
      const all = { ...(next.pluginConfig as Record<string, unknown> ?? {}) };
      const id = fieldNamespaces[field];
      const layer = { ...all[id] as object };
      update(layer); all[id] = layer; next.pluginConfig = all;
    }
  };
  writeField('permissionMode', draft.permissionMode);
  writeField('judgeModel', draft.judgeModel);
  // 全局首次编辑只保存用户实际设置的规则，不把空默认列表提升成全局配置。
  if (snapshot.scope === 'project' || !isDeepStrictEqual(draft.permissions, snapshot.permissions)) writeField('permissions', copyPermissionDraft(draft).permissions);
  const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
  const tmp = `${snapshot.path}.${process.pid}-${randomUUID()}.tmp`;
  let fd: number | undefined;
  let created = false;
  const lock = `${snapshot.path}.settings.lock`;
  let lockFd: number | undefined;
  try {
    // 打开、查看、取消均无副作用；只在提交全局字段修改时创建配置目录。
    if (snapshot.scope === 'global') fs.mkdirSync(dirname(snapshot.path), { recursive: true, mode: 0o700 });
    try { lockFd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') throw new PermissionConfigError('conflict', '另一个设置保存正在进行（或遗留了保存锁），更改未保存。请稍后重试；确认无其他保存任务后可人工检查锁文件。');
      throw error;
    }
    assertUnchanged(snapshot.path, original.state);
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, original.state?.mode ?? 0o600);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    fs.closeSync(fd); fd = undefined;
    // 锁串行化本程序的设置保存；外部编辑器不遵守此锁，重读只能尽量缩小竞争窗口。
    assertUnchanged(snapshot.path, original.state);
    fs.renameSync(tmp, snapshot.path);
    created = false;
    // 提交后无需再次读取；避免磁盘已提交却因后续读取失败误报保存失败。
    const saved = Object.freeze({ path: snapshot.path, exists: true, scope: snapshot.scope, ...copyPermissionDraft(draft) });
    snapshots.set(saved, { raw: next, state: { bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 } });
    return saved;
  } catch (error) {
    if (error instanceof PermissionConfigError) throw error;
    throw new PermissionConfigError('io', '权限配置保存失败，原文件未被覆盖，更改未保存。请检查文件权限或磁盘空间后重试。');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 保留原始错误 */ } }
    if (created) { try { fs.unlinkSync(tmp); } catch { /* 清理失败不覆盖保存错误 */ } }
    if (lockFd !== undefined) {
      try { fs.closeSync(lockFd); } catch { /* 保留原始错误 */ }
      try { fs.unlinkSync(lock); } catch { /* 下次保存会提示遗留锁，不误报未提交 */ }
    }
  }
}

/** 保留旧入口；新调用应使用带 scope 的快照与 savePermissionConfig。 */
export function saveProjectPermissionConfig(snapshot: PermissionConfigSnapshot, draft: PermissionConfigDraft): PermissionConfigSnapshot {
  if (snapshot.scope !== 'project') throw new PermissionConfigError('invalid', '保存范围不匹配，请重新打开项目设置。');
  return savePermissionConfig(snapshot, draft);
}
