/** 纯数据命令与可选终端入口；此模块不会载入终端实现。 */
import { definePlugin, type CommandContext } from '../sdk/index.js';
const inspection = (context: CommandContext) => { if (!context.inspect) throw new Error('当前前端不提供能力目录'); return context.inspect(); };
export function uiPlugin() {
  return definePlugin({ manifest: { id: 'agentlab.host-commands', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.command('help', { description: '显示已注册命令', handler(_input, context) {
      return { type: 'text', text: `命令：\n${inspection(context).commands.map(command => `  /${command.id}  ${command.description}`).join('\n')}` };
    } });
    ctx.provide.command('settings', { description: '查看插件设置与生效时机', handler(_input, context) { return { type: 'data', data: inspection(context).settings }; } });
    ctx.provide.command('plugins', { description: '查看已加载插件与版本', handler(_input, context) {
      return { type: 'text', text: inspection(context).plugins.map(plugin => `${plugin.id}@${plugin.version}`).join('\n') || '(无已加载插件)' };
    } });
    ctx.provide.command('tools', { description: '列出已注册工具', handler(_input, context) {
      return { type: 'text', text: inspection(context).tools.map(tool => `${tool.name} [${tool.risk}]`).join('\n') || '(无已注册工具)' };
    } });
    for (const [id, description] of [
      ['details', '展开/收起详情或查看指定消息'], ['stats', '查看 token、缓存和日志'], ['queue', '查看或清空排队消息'], ['redraw', '强制终端全屏重绘'], ['exit', '退出交互前端'],
    ] as const) ctx.provide.command(id, { description, handler: input => ({ type: 'interaction', id: `ui:${id}`, prompt: description, body: typeof input.args === 'string' ? input.args : undefined }) });
    ctx.provide.tui('default-ui', { entry: 'agentlab:builtin-ui', kind: 'editor', title: '默认终端交互' });
  } });
}
