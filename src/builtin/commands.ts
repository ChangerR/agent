/** 领域命令由能力插件贡献；CLI 仅负责交互和呈现。 */
import { definePlugin, type CommandContext, type CommandResult, type PermissionController, type SettingsSection } from '../sdk/index.js';
import type { ThinkingLevel } from '../core/provider.js';
import type { SessionManager } from '../core/session/coordinator.js';
import { resolveAgentPaths } from '../core/paths.js';
import { assertPermissionConfigUnchanged, copyPermissionDraft, readPermissionConfig, savePermissionConfig } from './policy/config.js';
import { createScopedConfigStores, settingsErrorMessage } from '../runtime/config-store.js';
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
export function modelCommandsPlugin(services: BuiltinCommandServices, cwd = process.cwd()) {
  const stores = createScopedConfigStores(cwd);
  return definePlugin({ manifest: { id: 'agentlab.model-commands', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    for (const id of ['model', 'think'] as const) {
      const field = id === 'model' ? 'model' : 'thinking';
      const title = id === 'model' ? '模型' : '思考等级';
      ctx.provide.command(id, { description: `选择${title}，立即保存本项目并应用`, async handler(input, context) {
        const store = stores.store('project');
        const sessionId = services.session().id;
        // 在打开选择器前固定基线；等待选择期间的外部修改必须通过 CAS 检测。
        let base;
        try { base = store.readFields([field]); } catch (error) { throw new Error(settingsErrorMessage(error)); }
        const selected = args(input) || await pick(id, id === 'model' ? '选择模型 · 本项目' : '思考等级 · 本项目',
          id === 'model' ? services.models().map(m => ({ id: m.name, label: m.name })) : ['off', 'low', 'medium', 'high'].map(id => ({ id, label: id })), context);
        if (typeof selected !== 'string') return selected;
        if (id === 'think' && !['off', 'low', 'medium', 'high'].includes(selected)) throw new Error('用法: /think off|low|medium|high');
        if (id === 'model' && (!selected.trim() || /[\s\u0000-\u001f\u007f-\u009f]/u.test(selected))) throw new Error('用法: /model <模型 ID>');
        context.signal.throwIfAborted();
        if (services.session().id !== sessionId) throw new Error('会话已变化，请重新选择设置。');
        try { store.commitFields(base, { [field]: selected }); } catch (error) { throw new Error(settingsErrorMessage(error)); }
        // 持久化成功后才修改运行值；恢复会话的 loop setter 不会写启动默认。
        try { if (id === 'model') services.setModel(selected); else services.setThinking(selected as ThinkingLevel); }
        catch { throw new Error('设置已保存，但当前运行值应用失败，请检查插件并重新启动。'); }
        return text(`${title}切换为 ${selected}；已保存本项目（${store.path}）。下一次模型请求生效（可能在本轮内）${id === 'model' ? '；当前 provider、endpoint 和凭据引用保持不变' : ''}。`);
      } });
    }
    for (const [id, title, read] of [['model', '模型', services.model], ['think', '思考', services.thinking]] as const) {
      ctx.provide.settings(id, { title, order: id === 'model' ? 0 : 1, description: '选择即保存本项目并应用；下一次模型请求生效。模型仅切换当前 provider / endpoint 下的模型 ID。', scopeTargets: stores.scopeTargets.filter(target => target.scope === 'project'), schema: { type: 'string' }, applyMode: 'nextRequest', read });
    }
  } });
}
export function permissionCommandsPlugin(services: BuiltinCommandServices, cwd = process.cwd()) {
  const paths = resolveAgentPaths(cwd);
  return definePlugin({ manifest: { id: 'agentlab.permission-commands', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.command('mode', { description: '选择权限模式，自动保存本项目并立即应用', async handler(input, context) {
      const snapshot = readPermissionConfig(paths.projectConfigPath, 'project');
      const permission = services.permission();
      const currentMode = permission.mode;
      const sessionId = services.session().id;
      const selected = args(input) || await pick('mode', '选择本项目权限模式 · 自动保存并应用', ['ask', 'auto', 'yolo'].map(id => ({ id, label: id })), context);
      if (typeof selected !== 'string') return selected;
      if (!['ask', 'auto', 'yolo'].includes(selected)) throw new Error('用法: /mode ask|auto|yolo');
      context.signal.throwIfAborted();
      if (permission !== services.permission() || currentMode !== permission.mode || sessionId !== services.session().id) throw new Error('当前会话已变化，请重新选择模式；未保存更改。');
      const mode = selected as 'ask' | 'auto' | 'yolo';
      permission.validateMode?.(mode);
      const next = copyPermissionDraft(snapshot); next.permissionMode = mode;
      if (snapshot.permissionMode === mode) assertPermissionConfigUnchanged(snapshot);
      else savePermissionConfig(snapshot, next);
      try { permission.setMode(mode); }
      catch { throw new Error(`权限配置已保存，但当前策略应用失败；当前模式为 ${permission.mode}。请重新选择或重启后核对。`); }
      return text(`权限模式: ${selected}；已保存本项目并应用到后续检查，已有审批仍需处理。通用 permissionMode 默认已保存，插件重启时是否采用由该插件决定。`);
    } });
    ctx.provide.command('permissions', { description: '权限设置与决策日志', handler(input) {
      return args(input) === 'audit' ? { type: 'data', data: services.permission().getAuditLog() } : { type: 'data', data: { mode: services.permission().mode, sessionRules: services.permission().getSessionRules() } };
    } });
    ctx.provide.settings('permissions', { title: '权限', order: 2, description: '默认编辑本项目，选择或 Enter 自动保存。模式立即应用；规则与审批模型重启后生效。全局范围可选。', schema: { type: 'object' }, applyMode: 'newSession',
      scopeTargets: [{ scope: 'project', path: paths.projectConfigPath }, { scope: 'global', path: paths.globalConfigPath }, { scope: 'session' }],
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
      const [id, ...extra] = arg.split(/\s+/);
      if (extra.length) throw new Error('用法: /resume <id>');
      await services.session().resume(id, { signal: context.signal }); return text(`已恢复会话 ${id}`);
    } });
  } });
}
