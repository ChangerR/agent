import { definePlugin } from '../sdk/index.js';
import { SkillLoader } from '../skills/loader.js';
import { createUseSkillTool } from '../skills/plugin.js';
export function skillsLocalPlugin(cwd: string) {
  return definePlugin({ manifest: { id: 'agentlab.skills-local', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    const loader = new SkillLoader(cwd); loader.load();
    ctx.provide.skillSource('local', loader);
    ctx.provide.tool('use_skill', createUseSkillTool(loader));
    ctx.provide.command('skills', { description: '列出可用 skill', handler: () => ({ type: 'text', text: loader.list().map(s => `${s.name}: ${s.description}`).join('\n') || '(无可用 skill)' }) });
  } });
}
