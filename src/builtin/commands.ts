/** 领域命令由能力插件贡献；CLI 仅负责交互和呈现。 */
import { definePlugin, type CommandContext, type CommandResult, type PermissionController, type SettingsSection } from '../sdk/index.js';
import type { ThinkingLevel } from '../core/provider.js';
import type { SessionManager } from '../core/session/coordinator.js';
import { resolveAgentPaths } from '../core/paths.js';
export interface BuiltinCommandServices {
  model(): string;
  setModel(value: string): void;
  thinking(): ThinkingLevel;
  setThinking(value: ThinkingLevel): void;
  models(): Array<{ name: string; info?: { contextWindow: number; maxOutputTokens: number } }>;
  permission(): PermissionController;
  session(): SessionManager;
}
const text = (text: string): CommandResult => ({ type: 'text', text });
const args = (input: Record<string, unknown>) => typeof input.args === 'string' ? input.args.trim() : '';
async function pick(id: string, prompt: string, choices: Array<{ id: string; label: string }>, context: CommandContext): Promise<string | CommandResult> {
  const request = { type: 'interaction' as const, id, prompt, choices };
  return context.interact ? (await context.interact(request)) ?? text('已取消') : request;
}
export function modelCommandsPlugin(services: BuiltinCommandServices) {
  return definePlugin({ manifest: { id: 'agentlab.model-commands', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.command('model', { description: '查看/切换模型', async handler(input, context) {
      const selected = args(input) || await pick('model', '选择模型', services.models().map(m => ({ id: m.name, label: m.name })), context);
      if (typeof selected !== 'string') return selected;
      services.setModel(selected); return text(`模型已切换: ${selected}`);
    } });
    ctx.provide.command('think', { description: '查看/设置思考等级', async handler(input, context) {
      const selected = args(input) || await pick('think', '思考等级', ['off', 'low', 'medium', 'high'].map(id => ({ id, label: id })), context);
      if (typeof selected !== 'string') return selected;
      if (!['off', 'low', 'medium', 'high'].includes(selected)) throw new Error('用法: /think off|low|medium|high');
      services.setThinking(selected as ThinkingLevel); return text(`思考等级: ${selected}`);
    } });
    for (const [id, title, read] of [['model', '模型', services.model], ['think', '思考', services.thinking]] as const) {
      ctx.provide.settings(id, { title, order: id === 'model' ? 0 : 1, description: '本次会话；下一次请求生效，不修改全局或项目默认。', scopeTargets: [{ scope: 'session' }], schema: { type: 'string' }, applyMode: 'nextRequest', read });
    }
  } });
}
export function permissionCommandsPlugin(services: BuiltinCommandServices, cwd = process.cwd()) {
  const paths = resolveAgentPaths(cwd);
  return definePlugin({ manifest: { id: 'agentlab.permission-commands', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.command('mode', { description: '查看/切换权限模式', async handler(input, context) {
      const selected = args(input) || await pick('mode', '选择权限模式', ['ask', 'auto', 'yolo'].map(id => ({ id, label: id })), context);
      if (typeof selected !== 'string') return selected;
      if (!['ask', 'auto', 'yolo'].includes(selected)) throw new Error('用法: /mode ask|auto|yolo');
      if (selected === 'yolo') {
        const confirmation = { type: 'interaction' as const, id: 'mode-yolo', kind: 'confirm' as const, prompt: 'yolo 会自动执行未被规则拦截的写入和命令，确认切换？', requireSelection: true, choices: [{ id: 'cancel', label: '取消' }, { id: 'confirm', label: '确认' }] };
        if (!context.interact) return confirmation;
        if (await context.interact(confirmation) !== 'confirm') return text('已取消');
      }
      services.permission().setMode(selected as 'ask' | 'auto' | 'yolo'); return text(`权限模式: ${selected}`);
    } });
    ctx.provide.command('permissions', { description: '权限设置与决策日志', handler(input) {
      return args(input) === 'audit' ? { type: 'data', data: services.permission().getAuditLog() } : { type: 'data', data: { mode: services.permission().mode, sessionRules: services.permission().getSessionRules() } };
    } });
    ctx.provide.settings('permissions', { title: '权限', order: 2, description: '本次会话规则即时生效；本项目/全局默认需明确选择并保存，重启生效。', schema: { type: 'object' }, applyMode: 'new-session',
      scopeTargets: [{ scope: 'session' }, { scope: 'project', path: paths.projectConfigPath }, { scope: 'global', path: paths.globalConfigPath }],
      read: () => ({ mode: services.permission().mode, rules: services.permission().getSessionRules() }) });
  } });
}
export function sessionCommandsPlugin(services: BuiltinCommandServices) {
  return definePlugin({ manifest: { id: 'agentlab.session', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.command('save', { description: '保存当前会话', async handler(_input, context) {
      const saved = await services.session().save(context.signal);
      return text(saved ? `已保存会话 ${saved.id}（${saved.messageCount} 条消息）→ ${saved.path}` : '当前会话还没有内容，未保存');
    } });
    ctx.provide.command('sessions', { description: '列出会话，rm 删除', async handler(input, context) {
      const arg = args(input);
      if (arg.startsWith('rm ')) { const id = arg.slice(3).trim(); return text(await services.session().delete(id, context.signal) ? `已删除会话 ${id}` : `会话 ${id} 不存在`); }
      if (arg) throw new Error('用法: /sessions 或 /sessions rm <id>');
      return { type: 'data', data: await services.session().list(context.signal) };
    } });
    ctx.provide.command('resume', { description: '恢复会话', async handler(input, context) {
      let arg = args(input);
      if (!arg) {
        const listing = await services.session().list(context.signal);
        if (!listing.sessions.length) return text('(本项目还没有已保存的会话)');
        const selected = await pick('resume', '恢复会话', listing.sessions.map(s => ({ id: s.id, label: s.title })), context);
        if (typeof selected !== 'string') return selected;
        arg = selected;
      }
      const [id, flag, ...extra] = arg.split(/\s+/);
      if (extra.length || (flag && flag !== '--legacy')) throw new Error('用法: /resume <id> [--legacy]');
      await services.session().resume(id, { allowLegacyProvider: flag === '--legacy', signal: context.signal }); return text(`已恢复会话 ${id}`);
    } });
  } });
}
