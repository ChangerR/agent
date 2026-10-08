import { definePlugin } from '../sdk/index.js';
import { SkillLoader } from '../skills/loader.js';
import { skillPlugin } from '../skills/plugin.js';
import { ToolRegistry } from '../core/registry.js';
export function skillsLocalPlugin(cwd: string) {
  return definePlugin({ manifest: { id: 'agentlab.skills-local', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    const loader = new SkillLoader(cwd); loader.load();
    ctx.provide.skillSource('local', loader);
    // 复用原工具定义，注册仍通过宿主事务。
    const capture = { register: (tool: Parameters<ToolRegistry['register']>[0]) => ctx.provide.tool(tool.name, tool) };
    skillPlugin(loader).register({ tools: capture as ToolRegistry, providers: undefined!, hooks: ctx.hooks, config: ctx.config.core as never });
    ctx.provide.command('skills', { description: '列出可用 skill', handler: () => ({ type: 'text', text: loader.list().map(s => `${s.name}: ${s.description}`).join('\n') || '(无可用 skill)' }) });
  } });
}
