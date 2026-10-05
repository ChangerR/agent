import { describe, expect, it } from 'vitest';
import { loadPlugins, type PluginContext } from '../src/core/plugin.js';
import { ToolRegistry, ProviderRegistry } from '../src/core/registry.js';
import { AgentConfigSchema } from '../src/core/config.js';

const context = (): PluginContext => ({ providers: new ProviderRegistry(), tools: new ToolRegistry(), hooks: { register() {} }, config: AgentConfigSchema.parse({}) });

describe('插件生命周期', () => {
  it('按逆序等待异步清理，重复清理不会执行第二次', async () => {
    const order: string[] = [];
    const dispose = await loadPlugins([
      { name: 'a', register: () => async () => { await Promise.resolve(); order.push('a'); } },
      { name: 'b', register: () => () => { order.push('b'); } },
    ], context());
    await Promise.all([dispose(), dispose()]);
    expect(order).toEqual(['b', 'a']);
  });

  it('后续插件初始化失败时，释放已注册插件的资源', async () => {
    let released = false;
    await expect(loadPlugins([
      { name: 'a', register: () => () => { released = true; } },
      { name: 'bad', register: () => { throw new Error('registration failed'); } },
    ], context())).rejects.toThrow('registration failed');
    expect(released).toBe(true);
  });

  it('一个清理失败仍继续清理其余插件，并报告失败', async () => {
    let released = false;
    const dispose = await loadPlugins([
      { name: 'a', register: () => () => { released = true; } },
      { name: 'b', register: () => () => { throw new Error('cleanup failed'); } },
    ], context());
    await expect(dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(released).toBe(true);
  });
});
