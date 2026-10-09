import { mkdtempProject as mkdtemp } from './helpers/project.js';
import { describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../src/index.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry } from '../src/core/registry.js';
import { PluginHost } from '../src/runtime/plugin-host.js';
import { definePlugin, type Plugin, type PluginSetupContext, type Tool } from '../src/sdk/index.js';

const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: 'object' }, risk: 'read', async execute() { return { content: 'ok' }; } });
const plugin = (id: string, setup: Plugin['setup']): Plugin => definePlugin({ manifest: { id, version: '1.0.0', apiVersion: 1 }, setup });

describe('插件工具别名事务', () => {
  it('运行时别名进入统一授权门并保留原始工具身份', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'plugin-alias-')); const execute = vi.fn(async () => ({ content: 'allowed' }));
    const entry = plugin('example', ctx => { ctx.provide.tool('original', { ...tool('original'), execute }, { aliases: ['short'] }); });
    const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [entry], config: { provider: 'fake', permissionMode: 'auto' } });
    const approve = vi.fn(({ resolve }: { resolve: (answer: { allow: boolean }) => void }) => resolve({ allow: true }));
    agent.events.on('permission_request', approve);
    try {
      expect(agent.tools.get('short')).toMatchObject({ name: 'original', ownerPlugin: 'example' });
      expect(await agent.invokeTool('short', {})).toEqual({ content: 'allowed' }); expect(execute).toHaveBeenCalledOnce();
      agent.permission.addSessionRule('deny', 'original');
      expect(await agent.invokeTool('short', {})).toMatchObject({ isError: true }); expect(execute).toHaveBeenCalledOnce(); expect(approve).toHaveBeenCalledOnce();
    } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });
  it('完整别名在成功后一次提交并关闭注册入口', async () => {
    const host = new PluginHost(); const cleanup = vi.fn(); let retained!: PluginSetupContext;
    await host.load([plugin('example', ctx => {
      retained = ctx; ctx.onDispose(cleanup); ctx.provide.tool('demo', tool('demo'), { aliases: ['short', 'another'] });
      expect(host.capabilities).toEqual([]);
    })]);
    expect(host.get('tool', 'short')).toBe(host.get('tool', 'demo'));
    expect(host.getRecord('tool', 'demo')).toMatchObject({ ownerPlugin: 'example', aliases: ['short', 'another'] });
    expect(Object.isFrozen(host.getRecord('tool', 'demo')?.aliases)).toBe(true);
    expect(() => retained.provide.tool('late', tool('late'))).toThrow(/closed/);
    await host.dispose(); expect(cleanup).toHaveBeenCalledOnce();
  });
  it('依赖工具只提供声明的只读元数据及别名，不能直接执行', async () => {
    const dependency = plugin('dependency', ctx => { ctx.provide.tool('dep', tool('dep'), { aliases: ['dep-short'] }); });
    const dependent = plugin('dependent', ctx => {
      const dep = ctx.dependencies.get('dependency');
      expect(dep.get('tool', 'dep-short').name).toBe('dep');
      expect(dep.get('tool', 'dep-short')).not.toHaveProperty('execute');
      expect(dep.list('tool')[0]?.aliases).toEqual(['dep-short']);
      ctx.provide.tool('own', tool('own'), { aliases: ['short'] });
    }); dependent.manifest.requires = { dependency: '^1.0.0' };
    const host = new PluginHost(); await host.load([dependent, dependency]);
    expect(host.getRecord('tool', 'dep-short')?.ownerPlugin).toBe('dependency');
    expect(host.getRecord('tool', 'short')?.ownerPlugin).toBe('dependent'); await host.dispose();
  });
  it('别名冲突回滚全部能力及提前登记的清理函数', async () => {
    const cleanup = vi.fn(); const host = new PluginHost();
    await expect(host.load([
      plugin('first', ctx => { ctx.provide.tool('taken', tool('taken')); }),
      plugin('second', ctx => { ctx.onDispose(cleanup); ctx.provide.tool('own', tool('own'), { aliases: ['taken'] }); }),
    ])).rejects.toThrow(/Duplicate tool ID or alias/);
    expect(host.capabilities).toEqual([]); expect(cleanup).toHaveBeenCalledOnce();
  });
  it('setup 在别名和资源暂存后失败时不发布任何工具或钩子', async () => {
    const host = new PluginHost(); const hooks = new HookRunner(); const handler = vi.fn(); const cleanup = vi.fn();
    await expect(host.load([plugin('failed', ctx => {
      ctx.onDispose(cleanup); ctx.provide.tool('own', tool('own'), { aliases: ['short'] });
      ctx.hooks.register('PreToolUse', handler); throw new Error('setup failed');
    })])).rejects.toThrow('setup failed');
    expect(host.capabilities).toEqual([]); expect(host.get('tool', 'short')).toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce(); expect(() => host.installHooks(hooks)).toThrow('must be loaded');
    await hooks.runPreToolUse({ toolName: 'own', input: {} }); expect(handler).not.toHaveBeenCalled();
  });
  it('注册批次不会覆盖准备后或提交后新增的并发别名', () => {
    const registry = new ToolRegistry(); registry.register(tool('seed'));
    const pending = registry.prepareBatch([tool('own')], [{ name: 'short', target: 'own' }]);
    registry.alias('concurrent', 'seed'); expect(() => pending.commit()).toThrow('target changed');
    expect(registry.get('own')).toBeUndefined(); expect(registry.get('concurrent')?.name).toBe('seed');
    const committed = registry.prepareBatch([tool('own')], [{ name: 'short', target: 'own' }]); committed.commit();
    registry.alias('later', 'seed'); expect(() => committed.rollback()).toThrow('target changed');
    expect(registry.get('short')?.name).toBe('own'); expect(registry.get('later')?.name).toBe('seed');
  });
});
