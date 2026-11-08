/** 一次性、显式的会话树权限迁移；不在加载路径保留旧策略兼容层。 */
import { loadSession, saveSessionVersioned } from '../session-file/implementation.js';
import { parseRule } from './controller.js';
import { canonicalPath, resolveAgentPaths } from '../../core/paths.js';
import { isValidSessionId } from '../../core/session/identity.js';
import type { SessionFile } from '../../core/session/types.js';

function validatePolicy(file: SessionFile): void {
  if (
    file.policy.id !== 'deterministic' ||
    !['2.0.0', '3.0.0'].includes(file.policy.version) ||
    file.policy.stateSchemaVersion !== 1
  )
    throw new Error('不支持此策略版本，请先导出历史并人工审查');
  for (const rule of [...file.sessionRules.ask, ...file.sessionRules.deny]) parseRule(rule);
}
function report(file: SessionFile) {
  const legacy = file.policy.version === '2.0.0';
  return {
    id: file.id,
    from: file.policy.version,
    to: '3.0.0',
    revision: file.revision,
    droppedTemporaryAllows: legacy ? file.sessionRules.allow.length : 0,
    nextMode: legacy ? 'ask' : file.permissionMode,
    historyMessages: file.messages.length,
    applied: false,
  };
}

export async function migrateSessionPermissions(
  cwd: string,
  id: string,
  apply: boolean,
  signal: AbortSignal,
) {
  const root = await loadSession(cwd, id, signal);
  if (root.policy.id !== 'deterministic' || root.agents?.owner)
    throw new Error('仅支持默认策略的独立根会话权限迁移');
  if (root.id !== id || canonicalPath(root.cwd) !== resolveAgentPaths(cwd).projectRoot)
    throw new Error('会话项目或身份不一致，未迁移');
  validatePolicy(root);
  const children: SessionFile[] = [];
  const seen = new Set<string>([root.id, 'root']);
  // 与 supervisor 的单层委派契约一致；先检查所有归属与版本，再进行任何写入。
  for (const record of root.agents?.children ?? []) {
    if (
      record.rootSessionId !== root.id ||
      record.parentAgentId !== 'root' ||
      record.depth !== 1 ||
      !isValidSessionId(record.sessionId) ||
      seen.has(record.agentId) ||
      seen.has(record.sessionId) ||
      record.agentId === record.sessionId
    )
      throw new Error('子会话树身份或归属不合法，未迁移');
    seen.add(record.agentId);
    seen.add(record.sessionId);
    const file = await loadSession(cwd, record.sessionId, signal);
    const owner = file.agents?.owner,
      saved = file.agents?.agent;
    if (
      file.id !== record.sessionId ||
      canonicalPath(file.cwd) !== canonicalPath(root.cwd) ||
      file.provider !== root.provider ||
      file.endpointKey !== root.endpointKey ||
      owner?.rootSessionId !== root.id ||
      owner?.agentId !== record.agentId ||
      owner?.parentAgentId !== record.parentAgentId ||
      !saved ||
      file.agents?.children?.length ||
      (
        [
          'agentId',
          'sessionId',
          'rootSessionId',
          'parentAgentId',
          'name',
          'depth',
          'context',
          'readOnly',
          'allowedTools',
        ] as const
      ).some((key) => JSON.stringify(saved[key]) !== JSON.stringify(record[key]))
    )
      throw new Error('子会话身份或归属不一致，未迁移');
    validatePolicy(file);
    children.push(file);
  }
  const result = { ...report(root), children: children.map(report) };
  if (!apply) return result;
  // 子会话先提交，根最后提交；每份文件保留 CAS，冲突/取消后允许重试混合 v2/v3 树。
  for (const [file, summary] of [
    ...children.map((file, index) => [file, result.children[index]] as const),
    [root, result] as const,
  ]) {
    signal.throwIfAborted();
    if (file.policy.version === '3.0.0') continue;
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
    summary.revision = saved.revision;
    summary.applied = true;
  }
  result.applied ||= result.children.some((child) => child.applied);
  return result;
}
