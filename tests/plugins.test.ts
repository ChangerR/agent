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

// 旧入口也必须与新宿主共享事务和资源清理，不能作为绕过回滚的第二条加载路径。
import { vi } from 'vitest';
import { HookRunner } from '../src/core/hooks.js';
import type { Tool } from '../src/core/registry.js';
import type { Provider } from '../src/core/provider.js';
import type { TypedHookRegistrar } from '../src/sdk/index.js';
const exampleTool = (name: string): Tool => ({ name, description: name, risk: 'read', inputSchema: { type: 'object' }, async execute() { return { content: name }; } });
const exampleProvider = (name: string): Provider => ({ name, capabilities: { thinking: false, streaming: true }, async *stream() {} });

describe('旧加载入口的完整注册事务', () => {
  it('后续 setup 抛错时，所有新 provider、tool、hook 都不进入已有注册表', async () => {
    const ctx = context(); const hooks = new HookRunner(); ctx.hooks = hooks.registrationSink();
    const beforeTool = exampleTool('existing'); const beforeProvider = exampleProvider('existing');
    ctx.tools.register(beforeTool); ctx.providers.register(beforeProvider);
    hooks.register('PreToolUse', () => ({ input: { existing: true } }));
    const addedHook = vi.fn();
    await expect(loadPlugins([
      { name: 'first', register(ctx) { ctx.tools.register(exampleTool('first')); ctx.providers.register(exampleProvider('first')); ctx.hooks.register('PreToolUse', addedHook); } },
      { name: 'failed', register(ctx) { ctx.tools.register(exampleTool('failed')); ctx.providers.register(exampleProvider('failed')); ctx.hooks.register('TurnEnd', addedHook); throw new Error('failed setup'); } },
    ], ctx)).rejects.toThrow('failed setup');
    expect(ctx.tools.list()).toEqual([beforeTool]); expect(ctx.providers.list()).toEqual([beforeProvider]);
    expect(await hooks.runPreToolUse({ toolName: 'existing', input: {} })).toEqual({ input: { existing: true } });
    await hooks.notify('TurnEnd', {}); expect(addedHook).not.toHaveBeenCalled();
  });
  it('失败插件可通过 onDispose 扩展立即登记清理，无需等 register 返回', async () => {
    const released = vi.fn(); const ctx = context();
    await expect(loadPlugins([{ name: 'resource', register(ctx) {
      ctx.onDispose!(released); ctx.tools.register(exampleTool('partial')); throw new Error('connect failed');
    } }], ctx)).rejects.toThrow('connect failed');
    expect(released).toHaveBeenCalledOnce(); expect(ctx.tools.list()).toEqual([]);
  });
  it('种子注册与明确的前序依赖保持旧注册表可见性，成功才一次性提交', async () => {
    const ctx = context(); const hooks = new HookRunner(); ctx.hooks = hooks.registrationSink();
    ctx.tools.register(exampleTool('existing')); ctx.tools.alias('old_alias', 'existing'); ctx.providers.register(exampleProvider('existing'));
    const dispose = await loadPlugins([
      { name: 'first', register(staged) {
        expect(staged.tools.get('existing')?.name).toBe('existing'); expect(staged.tools.get('old_alias')?.name).toBe('existing');
        expect(staged.providers.get('existing').name).toBe('existing'); staged.tools.register(exampleTool('first'));
        expect(ctx.tools.get('first')).toBeUndefined();
      } },
      { name: 'second', register(staged) {
        expect(staged.tools.get('first')?.name).toBe('first'); staged.providers.register(exampleProvider('second'));
        staged.hooks.register('PreToolUse', payload => ({ input: { ...payload.input, committed: true } }));
      } },
    ], ctx);
    expect(ctx.tools.list().map(tool => tool.name)).toEqual(['existing', 'first']);
    expect(ctx.providers.list().map(provider => provider.name)).toEqual(['existing', 'second']);
    expect(await hooks.runPreToolUse({ toolName: 'first', input: {} })).toEqual({ input: { committed: true } });
    expect(ctx.tools.get('old_alias')?.name).toBe('existing'); await dispose();
  });
  it('重复 ID 或冻结目标在任何目标写入前失败并释放资源', async () => {
    for (const frozen of [false, true]) {
      const ctx = context(); const release = vi.fn(); ctx.tools.register(exampleTool('existing'));
      if (frozen) ctx.tools.freeze();
      await expect(loadPlugins([{ name: 'conflict', register(staged) {
        staged.onDispose!(release); staged.providers.register(exampleProvider('new'));
        staged.tools.register(exampleTool(frozen ? 'new' : 'existing'));
      } }], ctx)).rejects.toThrow(frozen ? 'frozen' : 'Duplicate');
      expect(ctx.providers.list()).toEqual([]); expect(ctx.tools.list().map(tool => tool.name)).toEqual(['existing']); expect(release).toHaveBeenCalledOnce();
    }
  });
  it('不可回滚的 hook sink 明确拒绝，不能写入任何一部分能力', async () => {
    const register = vi.fn(); const ctx = context(); ctx.hooks = { register }; const dispose = vi.fn();
    await expect(loadPlugins([{ name: 'hooks', register(staged) {
      staged.onDispose!(dispose); staged.tools.register(exampleTool('new')); staged.providers.register(exampleProvider('new')); staged.hooks.register('TurnEnd', () => {});
    } }], ctx)).rejects.toThrow('registrationSink');
    expect(register).not.toHaveBeenCalled(); expect(ctx.tools.list()).toEqual([]); expect(ctx.providers.list()).toEqual([]); expect(dispose).toHaveBeenCalledOnce();
  });
  it('已准备的其他注册表也会在后续原子提交失败时撤销', async () => {
    const ctx = context(); const runner = new HookRunner(); const sink = runner.registrationSink();
    ctx.hooks = { ...sink, prepareBatch(hooks) {
      const batch = sink.prepareBatch(hooks);
      return { ...batch, commit() { throw new Error('hook commit failed'); } };
    } };
    await expect(loadPlugins([{ name: 'hooks', register(staged) {
      staged.tools.register(exampleTool('new')); staged.providers.register(exampleProvider('new')); staged.hooks.register('TurnEnd', () => {});
    } }], ctx)).rejects.toThrow('hook commit failed');
    expect(ctx.tools.list()).toEqual([]); expect(ctx.providers.list()).toEqual([]);
  });
  it('冻结后不能用之前准备的批次提交或回滚', () => {
    const tools = new ToolRegistry(); const batch = tools.prepareBatch([exampleTool('new')]); tools.freeze();
    expect(() => batch.commit()).toThrow('frozen'); expect(tools.list()).toEqual([]);
    const providers = new ProviderRegistry(); const committed = providers.prepareBatch([exampleProvider('new')]); committed.commit(); providers.freeze();
    expect(() => committed.rollback()).toThrow('frozen'); expect(providers.list()).toHaveLength(1);
  });
  it('SDK 按 hook 阶段推断 payload 和返回值', () => {
    // 以下分支只参与 tsc 类型回归，不注册实际运行时钩子。
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
