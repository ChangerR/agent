/** 默认策略的授权候选与持久化格式；具体工具语义留在 builtin。 */
import { randomUUID } from 'node:crypto';
import { dirname, relative } from 'node:path';
import { z } from 'zod';
import type {
  GrantOption,
  PermissionGrant,
  PolicyDecision,
  PolicyInput,
} from '../../sdk/capabilities.js';
import { permissionDefinition, permissionHash } from '../../core/permission/grants.js';

export const PermissionGrantSchema = z
  .object({
    id: z.string().uuid(),
    scope: z.enum(['task', 'session', 'project']),
    cwd: z.string().min(1),
    sessionId: z.string().optional(),
    permissionScope: z.string().optional(),
    ownerPlugin: z.string().min(1),
    toolVersion: z.string().min(1),
    boundary: z.string().min(1),
    tools: z.array(z.string().min(1)).min(1),
    createdAt: z.number().nonnegative(),
    selector: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('call'),
          inputHash: z.string().regex(/^[a-f0-9]{64}$/),
          definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
      z
        .object({
          kind: z.literal('directory'),
          root: z.string().min(1),
          effects: z.array(z.enum(['read', 'write'])).min(1),
        })
        .strict(),
    ]),
  })
  .strict();

export function grantOptions(
  input: PolicyInput,
  decision: PolicyDecision,
  persistent: boolean,
): GrantOption[] {
  const eligible = [
    'ask_mode',
    'review_uncertain',
    'unknown_ask',
    'unknown_operation',
    'platform_write_review',
    'powershell_write_review',
    'platform_write_ask',
  ];
  if (
    !eligible.includes(decision.reasonCode ?? '') ||
    !input.sessionId ||
    !input.permissionScope ||
    input.analysis?.reasonCode === 'unverified_tool_implementation'
  )
    return [];
  const base = {
    cwd: input.cwd,
    ownerPlugin: input.tool.ownerPlugin ?? 'unowned',
    toolVersion: input.tool.version ?? 'unversioned',
    tools: [input.tool.name],
    createdAt: Date.now(),
    boundary: input.executionBoundary?.revision ?? 'host',
  };
  const scopes = ['task', 'session', ...(persistent ? ['project' as const] : [])] as const;
  const result: GrantOption[] = scopes.map((scope) => ({
    label:
      scope === 'task'
        ? '本任务允许相同完整调用'
        : scope === 'session'
          ? '本会话允许相同完整调用'
          : '保存相同完整调用为项目授权',
    description: `绑定全部参数、工具身份和项目目录；${
      input.executionBoundary?.description ??
      (input.tool.name === 'bash'
        ? '宿主执行，无操作系统隔离，可访问当前用户资源'
        : '每次重新验证实际资源和已知工具约束')
    }。敏感、危险和明确 ask 继续优先。`,
    grant: {
      ...base,
      id: randomUUID(),
      scope,
      ...(scope !== 'project' ? { sessionId: input.sessionId } : {}),
      ...(scope === 'task' ? { permissionScope: input.permissionScope } : {}),
      selector: {
        kind: 'call',
        inputHash: permissionHash(input.input),
        definitionHash: permissionDefinition(input),
      },
    },
  }));
  const analysis = input.analysis;
  if (
    input.tool.ownerPlugin === 'agentlab.local-tools' &&
    ['write_file', 'edit_file'].includes(input.tool.name) &&
    analysis?.completeness === 'complete' &&
    analysis.reasonCode !== 'native_windows_write_unverified' &&
    analysis.effects.length === 1 &&
    analysis.effects[0].kind === 'write' &&
    analysis.effects[0].scope === 'project' &&
    analysis.effects[0].target
  ) {
    const root = dirname(analysis.effects[0].target);
    // 项目根授权必须显式在设置中建立，弹窗不顺带扩大到整项目。
    if (root !== input.cwd)
      result.push({
        label: `本任务允许修改 ${relative(input.cwd, root)}/`,
        description:
          '允许内置文件工具在此目录内创建和修改普通文件；不包含 Shell、敏感文件和项目外路径。',
        grant: {
          ...base,
          id: randomUUID(),
          scope: 'task',
          sessionId: input.sessionId,
          permissionScope: input.permissionScope,
          tools: ['write_file', 'edit_file'],
          selector: { kind: 'directory', root, effects: ['write'] },
        },
      });
  }
  return result;
}
