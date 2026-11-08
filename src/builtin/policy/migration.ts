/** 一次性、显式的会话权限迁移；不在加载路径保留旧策略兼容层。 */
import { loadSession, saveSessionVersioned } from '../session-file/implementation.js';
import { parseRule } from './controller.js';

export async function migrateSessionPermissions(
  cwd: string,
  id: string,
  apply: boolean,
  signal: AbortSignal,
) {
  const file = await loadSession(cwd, id, signal);
  if (file.policy.id !== 'deterministic' || file.agents?.owner)
    throw new Error('仅支持默认策略的独立根会话权限迁移');
  const report = {
    id,
    from: file.policy.version,
    to: '3.0.0',
    revision: file.revision,
    droppedTemporaryAllows: file.sessionRules.allow.length,
    nextMode: 'ask',
    historyMessages: file.messages.length,
    applied: false,
  };
  if (file.policy.version === '3.0.0') return { ...report, nextMode: file.permissionMode };
  if (file.policy.version !== '2.0.0') throw new Error('不支持此策略版本，请先导出历史并人工审查');
  for (const rule of [...file.sessionRules.ask, ...file.sessionRules.deny]) parseRule(rule);
  if (!apply) return report;
  const saved = await saveSessionVersioned(
    {
      ...file,
      policy: { ...file.policy, version: '3.0.0' },
      permissionMode: 'ask',
      sessionRules: { ...file.sessionRules, allow: [] },
      updatedAt: new Date().toISOString(),
    },
    {},
    signal,
  );
  return { ...report, revision: saved.revision, applied: true };
}
