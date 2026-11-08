/** 跨工具的资源规则：路径与 effect 是授权语义，工具名只作为可选收窄条件。 */
import { isAbsolute, relative, resolve } from 'node:path';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import type { PolicyInput, ToolAnalysis } from '../../sdk/capabilities.js';

export const ResourceRuleSchema = z
  .object({
    id: z.string().min(1).max(128),
    action: z.enum(['allow', 'ask', 'deny']),
    effects: z.array(z.enum(['read', 'write'])).min(1),
    resource: z
      .object({
        kind: z.literal('file'),
        glob: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              !isAbsolute(value) &&
              !value.includes('\\') &&
              !value.split('/').includes('..') &&
              !/^[!#]/.test(value),
            '资源范围必须是项目内相对 glob',
          ),
      })
      .strict(),
    tools: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type ResourceRule = z.infer<typeof ResourceRuleSchema>;

export function resourceRuleMatch(
  rule: ResourceRule,
  input: PolicyInput,
  analysis: ToolAnalysis,
  every = false,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (rule.tools && !rule.tools.includes(input.tool.name)) return false;
  // 未知程序不能证明不访问被禁止的资源；没有 OS 资源过滤证明时拒绝这次执行。
  if (analysis.completeness !== 'complete') return !every && rule.action !== 'allow';
  const matches = (effect: ToolAnalysis['effects'][number]) => {
    if (!effect.target || !rule.effects.includes(effect.kind as 'read' | 'write')) return false;
    const path = relative(resolve(input.cwd), resolve(effect.target)).replace(/\\/g, '/');
    if (!path || path === '..' || path.startsWith('../') || isAbsolute(path)) return false;
    return minimatch(path, rule.resource.glob, {
      dot: true,
      nocase: platform === 'win32' && rule.action !== 'allow',
    });
  };
  return (
    analysis.effects.length > 0 &&
    (every ? analysis.effects.every(matches) : analysis.effects.some(matches))
  );
}
