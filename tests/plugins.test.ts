import { describe, expect, it, vi } from 'vitest';
import { HookRunner } from '../src/core/hooks.js';
import { ProviderRegistry, ToolRegistry } from '../src/core/registry.js';
import { PluginHost } from '../src/runtime/plugin-host.js';
import { definePlugin, type Plugin, type Tool, type Provider, type TypedHookRegistrar } from '../src/sdk/index.js';

const plugin = (id: string, setup: Plugin['setup']): Plugin => definePlugin({ manifest: { id, version: '1.0.0', apiVersion: 1 }, setup });
const exampleTool = (name: string): Tool => ({ name, description: name, risk: 'read', inputSchema: { type: 'object' }, async execute() { return { content: name }; } });
const exampleProvider = (name: string): Provider => ({ name, capabilities: { thinking: false, streaming: true }, async *stream() {} });

describe('插件生命周期与注册事务', () => {
  it('按逆序等待异步清理，重复清理不会执行第二次', async () => {
    const order: string[] = []; const host = new PluginHost();
    await host.load([
      plugin('a', ctx => { ctx.onDispose(async () => { await Promise.resolve(); order.push('a'); }); }),
      plugin('b', ctx => { ctx.onDispose(() => { order.push('b'); }); }),
    ]);
    await Promise.all([host.dispose(), host.dispose()]); expect(order).toEqual(['b', 'a']);
  });
  it('后续 setup 抛错时，所有 provider、tool、hook 与资源一起回滚', async () => {
    const host = new PluginHost(); const hooks = new HookRunner(); const handler = vi.fn(); const release = vi.fn();
    await expect(host.load([
      plugin('first', ctx => { ctx.onDispose(release); ctx.provide.tool('first', exampleTool('first')); ctx.provide.provider('first', exampleProvider('first')); ctx.hooks.register('PreToolUse', handler); }),
      plugin('failed', ctx => { ctx.provide.tool('failed', exampleTool('failed')); ctx.hooks.register('TurnEnd', handler); throw new Error('failed setup'); }),
    ])).rejects.toThrow('failed setup');
    expect(host.capabilities).toEqual([]); expect(release).toHaveBeenCalledOnce();
    expect(() => host.installHooks(hooks)).toThrow('must be loaded');
    await hooks.notify('TurnEnd', {}); expect(handler).not.toHaveBeenCalled();
  });
  it('一个清理失败仍继续清理其余插件，并报告失败', async () => {
    const release = vi.fn(); const host = new PluginHost();
    await host.load([plugin('a', ctx => { ctx.onDispose(release); }), plugin('b', ctx => { ctx.onDispose(() => { throw new Error('cleanup failed'); }); })]);
    await expect(host.dispose()).rejects.toBeInstanceOf(AggregateError); expect(release).toHaveBeenCalledOnce();
  });
  it('资源初始化失败仍会释放提前登记的资源', async () => {
    const release = vi.fn(); const host = new PluginHost();
    await expect(host.load([plugin('resource', async ctx => {
      await ctx.withResource({ connected: false }, release, () => { throw new Error('connect failed'); });
    })])).rejects.toThrow('connect failed');
    expect(release).toHaveBeenCalledOnce(); expect(host.capabilities).toEqual([]);
  });
  it('冻结后不能用之前准备的批次提交或回滚', () => {
    const tools = new ToolRegistry(); const batch = tools.prepareBatch([exampleTool('new')]); tools.freeze();
    expect(() => batch.commit()).toThrow('frozen'); expect(tools.list()).toEqual([]);
    const providers = new ProviderRegistry(); const committed = providers.prepareBatch([exampleProvider('new')]); committed.commit(); providers.freeze();
    expect(() => committed.rollback()).toThrow('frozen'); expect(providers.list()).toHaveLength(1);
  });
  it('SDK 按 hook 阶段推断 payload 和返回值', () => {
    if (false) {
      const hooks = {} as TypedHookRegistrar;
      hooks.register('PreToolUse', payload => ({ input: { ...payload.input, tool: payload.toolName } }));
      hooks.register('PostToolUse', payload => { const content: string = payload.result.content; void content; });
      hooks.register('UserPromptSubmit', payload => { const input: string = payload.input; void input; });
      hooks.register('TurnEnd', payload => { const turns: number = payload.turn; void turns; });
      hooks.register('PreToolUse', payload => {
        // @ts-expect-error PreToolUse 没有执行结果
        return { veto: payload.result.content };
      });
      // @ts-expect-error 通知型钩子不能返回审批/改写结果
      hooks.register('PostToolUse', () => ({ veto: 'deny' }));
    }
    expect(true).toBe(true);
  });
});
