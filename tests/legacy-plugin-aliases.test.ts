import { mkdtempProject as mkdtemp } from './helpers/project.js';
import { describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptLegacyPlugin } from '../src/compat/legacy-plugin.js';
import { createAgent } from '../src/index.js';
import { HookRunner } from '../src/core/hooks.js';
import { AgentConfigSchema } from '../src/core/config.js';
import { loadPlugins, type PluginContext } from '../src/core/plugin.js';
import { ToolRegistry, ProviderRegistry } from '../src/core/registry.js';
import { PluginHost } from '../src/runtime/plugin-host.js';
import { definePlugin, type Tool } from '../src/sdk/index.js';

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' }, risk: 'read', async execute() { return { content: 'ok' }; } });
const legacyContext = (): PluginContext => ({ tools: new ToolRegistry(), providers: new ProviderRegistry(), hooks: { register() {} }, config: AgentConfigSchema.parse({}) });

describe('旧插件工具别名事务', () => {
  it('实际运行时别名进入统一授权门并保留原始工具身份', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'legacy-alias-'));
    const execute = vi.fn(async () => ({ content: 'allowed' }));
    const plugin = adaptLegacyPlugin({ name: 'legacy', register(ctx) { ctx.tools.register({ ...tool('original'), execute }); ctx.tools.alias('short', 'original'); } });
    const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: { provider: 'fake', permissionMode: 'auto' } });
    try {
      expect(agent.tools.get('short')).toMatchObject({ name: 'original', ownerPlugin: 'legacy' });
      expect(await agent.invokeTool('short', {})).toEqual({ content: 'allowed' }); expect(execute).toHaveBeenCalledOnce();
      agent.permission.addSessionRule('deny', 'original');
      expect(await agent.invokeTool('short', {})).toMatchObject({ isError: true }); expect(execute).toHaveBeenCalledOnce();
    } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
  it('注册期间解析完整别名，在成功后一次提交并关闭注册入口', async () => {
    const host = new PluginHost(); const cleanup = vi.fn(); let tools!: ToolRegistry;
    const own = tool('demo');
    await host.load([adaptLegacyPlugin({ name: 'legacy', register(ctx) {
      tools = ctx.tools; ctx.tools.register(own); ctx.tools.alias('short', 'demo'); ctx.tools.alias('another', 'demo');
      expect(ctx.tools.get('short')).toBe(own); expect(ctx.tools.get('another')).toBe(own);
      expect(ctx.tools.aliasesFor('demo')).toEqual(['short', 'another']);
      expect(Object.isFrozen(ctx.tools.aliasesFor('demo'))).toBe(true);
      expect(ctx.tools.list()).toEqual([own]); expect(ctx.tools.definitions().map(value => value.name)).toEqual(['demo']);
      expect(host.capabilities).toEqual([]); return cleanup;
    } })]);
    expect(host.get('tool', 'short')).toBe(host.get('tool', 'demo'));
    expect(host.getRecord('tool', 'demo')).toMatchObject({ ownerPlugin: 'legacy', aliases: ['short', 'another'] });
    expect(() => tools.register(tool('late'))).toThrow(/closed/); expect(() => tools.alias('late', 'demo')).toThrow(/closed/);
    await host.dispose(); expect(cleanup).toHaveBeenCalledOnce();
  });

  it('保留依赖别名只读视图，拒绝本地别名/工具碰撞且不污染暂存区', async () => {
    const dependency = definePlugin({ manifest: { id: 'dependency', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.tool('dep', tool('dep'), { aliases: ['dep-short'] }); } });
    const host = new PluginHost();
    await host.load([dependency, adaptLegacyPlugin({ name: 'legacy', register(ctx) {
      expect(ctx.tools.get('dep-short')?.name).toBe('dep'); expect(ctx.tools.aliasesFor('dep')).toEqual(['dep-short']);
      ctx.tools.register(tool('own')); ctx.tools.alias('short', 'own');
      for (const [alias, target] of [['short', 'own'], ['own', 'own'], ['dep-short', 'own'], ['missing', 'absent'], ['borrowed', 'dep']]) {
        expect(() => ctx.tools.alias(alias!, target!)).toThrow(/alias/);
      }
      expect(() => ctx.tools.register(tool('short'))).toThrow(/Duplicate/);
      expect(() => ctx.tools.register(tool('dep-short'))).toThrow(/Duplicate/);
      expect(ctx.tools.aliasesFor('own')).toEqual(['short']); expect(ctx.tools.get('missing')).toBeUndefined();
    } }, { requires: { dependency: '^1.0.0' } })]);
    expect(host.getRecord('tool', 'dep-short')?.ownerPlugin).toBe('dependency');
    expect(host.getRecord('tool', 'short')?.ownerPlugin).toBe('legacy'); await host.dispose();
  });

  it('别名与未声明插件冲突时回滚全部能力及返回的清理函数', async () => {
    const cleanup = vi.fn(); const host = new PluginHost();
    await expect(host.load([
      definePlugin({ manifest: { id: 'first', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.tool('taken', tool('taken')); } }),
      adaptLegacyPlugin({ name: 'legacy', register(ctx) { ctx.tools.register(tool('own')); ctx.tools.alias('taken', 'own'); return cleanup; } }),
    ])).rejects.toThrow(/Duplicate tool ID or alias/);
    expect(host.capabilities).toEqual([]); expect(cleanup).toHaveBeenCalledOnce();
  });

  it('register 在别名和资源暂存后失败时不发布任何工具或钩子', async () => {
    const host = new PluginHost(); const hooks = new HookRunner(); const handler = vi.fn(); const cleanup = vi.fn();
    await expect(host.load([adaptLegacyPlugin({ name: 'legacy', register(ctx) {
      ctx.tools.register(tool('own')); ctx.tools.alias('short', 'own');
      ctx.hooks.register('PreToolUse', handler);
      // 兼容上下文额外提供可提前登记的事务资源清理。
      ctx.onDispose!(cleanup);
      throw new Error('legacy registration failed');
    } })])).rejects.toThrow('legacy registration failed');
    expect(host.capabilities).toEqual([]); expect(host.get('tool', 'short')).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce(); expect(() => host.installHooks(hooks)).toThrow('must be loaded');
    await hooks.runPreToolUse({ toolName: 'own', input: {} }); expect(handler).not.toHaveBeenCalled();
  });
});

describe('旧加载器别名投影', () => {
  it('注册批次不会覆盖准备后或提交后新增的并发别名', () => {
    const registry = new ToolRegistry(); registry.register(tool('seed'));
    const pending = registry.prepareBatch([tool('own')], [{ name: 'short', target: 'own' }]);
    registry.alias('concurrent', 'seed');
    expect(() => pending.commit()).toThrow('target changed');
    expect(registry.get('own')).toBeUndefined(); expect(registry.get('concurrent')?.name).toBe('seed');
    const committed = registry.prepareBatch([tool('own')], [{ name: 'short', target: 'own' }]); committed.commit();
    registry.alias('later', 'seed');
    expect(() => committed.rollback()).toThrow('target changed');
    expect(registry.get('short')?.name).toBe('own'); expect(registry.get('later')?.name).toBe('seed');
  });
  it('提交新别名并保留旧别名，后续插件可按依赖查询', async () => {
    const context = legacyContext(); context.tools.register(tool('seed')); context.tools.alias('seed-short', 'seed');
    const dispose = await loadPlugins([
      { name: 'first', register(ctx) { ctx.tools.register(tool('own')); ctx.tools.alias('short', 'own'); expect(context.tools.get('short')).toBeUndefined(); } },
      { name: 'second', register(ctx) { expect(ctx.tools.get('short')?.name).toBe('own'); expect(ctx.tools.aliasesFor('own')).toEqual(['short']); } },
    ], context);
    expect(context.tools.get('short')).toBe(context.tools.get('own'));
    expect(context.tools.aliasesFor('own')).toEqual(['short']); expect(context.tools.get('seed-short')?.name).toBe('seed');
    await dispose();
  });

  it('投影时的新别名冲突保留已有和并发注册，不写入部分能力', async () => {
    const context = legacyContext(); const cleanup = vi.fn();
    await expect(loadPlugins([{ name: 'legacy', register(ctx) {
      ctx.tools.register(tool('own')); ctx.tools.alias('late', 'own');
      ctx.providers.register({ name: 'own', capabilities: { streaming: true, thinking: false }, async *stream() {} });
      // 模拟加载期间其他调用方改变目标注册表；宿主种子未包含这次注册。
      context.tools.register(tool('concurrent')); context.tools.alias('late', 'concurrent');
      return cleanup;
    } }], context)).rejects.toThrow(/alias/);
    expect(context.tools.list().map(value => value.name)).toEqual(['concurrent']);
    expect(context.tools.get('late')?.name).toBe('concurrent'); expect(context.providers.list()).toEqual([]);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('后续 hook 提交失败时一起撤销新工具和别名，保留原注册', async () => {
    const context = legacyContext(); const hooks = new HookRunner(); const sink = hooks.registrationSink(); const cleanup = vi.fn();
    context.tools.register(tool('seed')); context.tools.alias('seed-short', 'seed');
    context.hooks = { ...sink, prepareBatch(values) { const batch = sink.prepareBatch(values); return { ...batch, commit() { throw new Error('hook commit failed'); } }; } };
    await expect(loadPlugins([{ name: 'legacy', register(ctx) {
      ctx.tools.register(tool('own')); ctx.tools.alias('short', 'own'); ctx.hooks.register('TurnEnd', () => {}); return cleanup;
    } }], context)).rejects.toThrow('hook commit failed');
    expect(context.tools.list().map(value => value.name)).toEqual(['seed']);
    expect(context.tools.get('short')).toBeUndefined(); expect(context.tools.aliasesFor('own')).toEqual([]);
    expect(context.tools.get('seed-short')?.name).toBe('seed'); expect(cleanup).toHaveBeenCalledOnce();
  });
});
