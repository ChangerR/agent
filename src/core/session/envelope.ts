/** 会话格式/策略/插件状态的恢复协议。未知可选状态只保留，永不执行。 */
import { SessionError } from './errors.js';
import { SessionFileSchema } from './schema.js';
import { assertSafeHistory } from './history.js';
import type { SessionFile, SessionPluginState, SessionPolicyIdentity } from './types.js';

export interface SessionRestoreRequirements {
  policy: SessionPolicyIdentity;
  plugins?: Readonly<Record<string, { schemaVersion: number; requiredForSafety?: boolean }>>;
}
export function validateSessionSnapshot(raw: unknown): SessionFile {
  const parsed = SessionFileSchema.safeParse(raw);
  if (!parsed.success) throw new SessionError('invalid_schema', `会话文件结构不合法: ${parsed.error.message}`);
  // 不能使用 zod 输出：保留 provider 扩展字段和未知插件状态。
  const file = structuredClone(raw) as SessionFile;
  file.sessionRules.allow ??= [];
  file.sessionRules.ask ??= [];
  file.sessionRules.deny ??= [];
  assertSafeHistory(file.messages);
  return file;
}
export function assertCompatibleEnvelope(file: SessionFile, requirements: SessionRestoreRequirements): void {
  if (file.schemaVersion === 1) {
    if (requirements.policy.id !== 'legacy-v1' || requirements.policy.stateSchemaVersion !== 1) throw new SessionError('unsupported_version', '旧 v1 会话的权限规则只能由兼容的 legacy 策略导入，不能自动迁移到其他策略。');
    if (Object.values(requirements.plugins ?? {}).some((state) => state.requiredForSafety)) throw new SessionError('unsupported_version', '旧 v1 会话缺少当前必需的安全相关插件状态。');
    return;
  }
  const policy = file.policy!;
  if (policy.id !== requirements.policy.id || policy.version !== requirements.policy.version || policy.stateSchemaVersion !== requirements.policy.stateSchemaVersion) {
    throw new SessionError('unsupported_version', '会话的策略或策略状态版本与当前实现不同，未恢复权限规则。');
  }
  const states = file.pluginStates!;
  for (const [id, expected] of Object.entries(requirements.plugins ?? {})) {
    const saved = states[id];
    if (expected.requiredForSafety && (!saved || saved.schemaVersion !== expected.schemaVersion)) {
      throw new SessionError('unsupported_version', `缺少兼容的安全相关插件状态: ${id}，未恢复会话。`);
    }
  }
  for (const [id, saved] of Object.entries(states)) {
    if (saved.requiredForSafety && requirements.plugins?.[id]?.schemaVersion !== saved.schemaVersion) {
      throw new SessionError('unsupported_version', `无法解释安全相关插件状态: ${id}，未恢复会话。`);
    }
  }
}
export function copyPluginStates(states: Record<string, SessionPluginState> = {}): Record<string, SessionPluginState> { return structuredClone(states); }
