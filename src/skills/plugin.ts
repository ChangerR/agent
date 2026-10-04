/**
 * Skill 插件：注册 use_skill 工具 —— 渐进式披露的另一半。
 *
 * system prompt 里只有 skill 的 name+description 清单；
 * 模型判断需要某个 skill 时调用 use_skill(name)，全文才进入上下文。
 */
import type { Plugin } from '../core/plugin.js';
import type { Tool } from '../core/registry.js';
import type { SkillLoader } from './loader.js';

export function skillPlugin(loader: SkillLoader): Plugin {
  return {
    name: 'skills',
    register(ctx) {
      const useSkillTool: Tool = {
        name: 'use_skill',
        description:
          'Load the full instructions of a skill into context. Call this BEFORE doing work that matches a skill\'s description.',
        risk: 'read',
        isConcurrencySafe: true,
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Skill name' } },
          required: ['name'],
        },
        analyzeInput: (input) => ({
          patternTarget: String(input.name ?? ''),
          summary: `use_skill: ${input.name}`,
        }),
        execute: async (input) => {
          const skill = loader.get(String(input.name));
          if (!skill) {
            return {
              content: `Skill not found: ${input.name}. Available: ${loader.list().map((s) => s.name).join(', ') || '(none)'}`,
              isError: true,
            };
          }
          return { content: `<skill name="${skill.name}">\n${skill.body}\n</skill>` };
        },
      };
      ctx.tools.register(useSkillTool);
    },
  };
}
