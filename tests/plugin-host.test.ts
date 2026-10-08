import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentConfigSchema } from '../src/core/config.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { adaptLegacyPlugin } from '../src/compat/legacy-plugin.js';
import { CapabilityRegistry } from '../src/runtime/capability-registry.js';
import { PluginHost, satisfiesPluginVersion } from '../src/runtime/plugin-host.js';
import { definePlugin, type Plugin, type PluginSetupContext, type Policy, type Tool } from '../src/sdk/index.js';

const tool = (name = 'demo'): Tool => ({ name, description: name, inputSchema: { type: 'object' }, risk: 'read', async execute() { return { content: 'ok' }; } });
const plugin = (id: string, setup: Plugin['setup'] = () => {}): Plugin => definePlugin({ manifest: { id, version: '1.0.0', apiVersion: 1 }, setup });
const policy: Policy = { decide() { return { kind: 'deny', source: 'config', reason: 'test' }; } };

describe('PluginHost transactional lifecycle', () => {
  it('publishes a frozen owned graph only when initialization succeeds', async () => {
    const host = new PluginHost();
    let retained!: PluginSetupContext;
    await host.load([plugin('a', (ctx) => { retained = ctx; ctx.provide.tool('demo', tool(), { aliases: ['d'], version: '2.0.0' }); expect(host.get('tool', 'demo')).toBeUndefined(); })]);
    expect(host.get('tool', 'd')).toBe(host.get('tool', 'demo'));
    expect(host.getRecord('tool', 'demo')).toMatchObject({ ownerPlugin: 'a', capabilityId: 'demo', version: '2.0.0' });
    expect(host.frozen).toBe(true);
    expect(Object.isFrozen(host.capabilities)).toBe(true);
    expect(Object.isFrozen(host.capabilities[0])).toBe(true);
    expect(() => retained.provide.tool('late', tool('late'))).toThrow('closed');
    await host.dispose();
  });
  it('rolls back all earlier and failed setup registrations and resources in reverse order', async () => {
    const host = new PluginHost(); const order: string[] = [];
    await expect(host.load([
      plugin('a', (ctx) => { ctx.provide.tool('first', tool('first')); ctx.onDispose(() => { order.push('a'); }); }),
      plugin('b', (ctx) => { ctx.provide.tool('second', tool('second')); ctx.onDispose(() => { order.push('b1'); }); ctx.onDispose(() => { order.push('b2'); }); throw new Error('setup fail'); }),
    ])).rejects.toThrow('setup fail');
    expect(host.capabilities).toEqual([]); expect(order).toEqual(['b2', 'b1', 'a']);
    await host.dispose(); expect(order).toEqual(['b2', 'b1', 'a']);
  });
  it('rolls back activation failure including subscriptions and activation-owned resources', async () => {
    const events = new EventBus(); const host = new PluginHost({ events }); const seen = vi.fn(); const clean: string[] = [];
    await expect(host.load([
      plugin('a', (ctx) => { ctx.events.on('notice', seen); ctx.onDispose(() => { clean.push('a'); }); ctx.onActivate(() => { events.emit({ type: 'notice', text: 'active' }); }); }),
      plugin('b', (ctx) => { ctx.onActivate(() => { ctx.onDispose(() => { clean.push('b'); }); throw new Error('activate fail'); }); }),
    ])).rejects.toThrow('activate fail');
    events.emit({ type: 'notice', text: 'after rollback' });
    expect(seen).toHaveBeenCalledTimes(1); expect(host.capabilities).toEqual([]); expect(clean).toEqual(['b', 'a']);
  });
  it('registers cleanup before resource initialization can fail', async () => {
    const dispose = vi.fn(); const resource = { connected: false };
    await expect(new PluginHost().load([plugin('mcp', async (ctx) => {
      await ctx.withResource(resource, dispose, async () => { throw new Error('connection fail'); });
    })])).rejects.toThrow('connection fail');
    expect(dispose).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledWith(resource);
  });
  it('shares one dispose task and attempts every cleanup even after an error', async () => {
    const order: string[] = []; const host = new PluginHost();
    await host.load([plugin('a', (ctx) => { ctx.onDispose(() => { order.push('first'); }); ctx.onDispose(() => { order.push('last'); throw new Error('cleanup'); }); })]);
    const first = host.dispose(); expect(host.dispose()).toBe(first);
    await expect(first).rejects.toThrow('Plugin cleanup failed'); expect(order).toEqual(['last', 'first']);
  });
  it('does not start event subscriptions before all setup transactions succeed', async () => {
    const events = new EventBus(); const seen = vi.fn(); const host = new PluginHost({ events });
    await expect(host.load([
      plugin('a', (ctx) => { ctx.events.on('notice', seen); }),
      plugin('b', () => { events.emit({ type: 'notice', text: 'setup' }); throw new Error('bad'); }),
    ])).rejects.toThrow('bad');
    events.emit({ type: 'notice', text: 'after' }); expect(seen).not.toHaveBeenCalled();
  });
  it('freezes isolated observations and removes permission resolvers', async () => {
    const events = new EventBus(); const host = new PluginHost({ events }); let observed: unknown;
    await host.load([plugin('a', (ctx) => { ctx.events.on('permission_request', (event) => { observed = event; }); })]);
    const input = { nested: { value: 1 } }; const resolve = vi.fn();
    events.emit({ type: 'permission_request', request: { toolName: 'demo', input, reason: 'test', summary: 'test' }, resolve, signal: new AbortController().signal });
    expect(observed).not.toHaveProperty('resolve'); expect(observed).not.toHaveProperty('signal');
    const snapshot = observed as { request: { input: typeof input } };
    expect(Object.isFrozen(snapshot.request.input.nested)).toBe(true);
    input.nested.value = 2; expect(snapshot.request.input.nested.value).toBe(1);
    expect(resolve).not.toHaveBeenCalled(); await host.dispose();
  });
  it('isolates observer errors from successful runtime events and records diagnostics', async () => {
    const events = new EventBus(); const host = new PluginHost({ events });
    await host.load([plugin('a', (ctx) => { ctx.events.on('notice', () => { throw new Error('telemetry fail'); }); })]);
    expect(() => events.emit({ type: 'notice', text: 'done' })).not.toThrow();
    expect(host.diagnostics).toContainEqual({ pluginId: 'a', code: 'observer_failed', message: 'telemetry fail' }); await host.dispose();
  });
  it('allows a staged observer to unsubscribe before activation', async () => {
    const events = new EventBus(); const host = new PluginHost({ events }); const seen = vi.fn();
    await host.load([plugin('a', (ctx) => { const off = ctx.events.on('notice', seen); void off(); })]);
    events.emit({ type: 'notice', text: 'event' }); expect(seen).not.toHaveBeenCalled(); await host.dispose();
  });
});

describe('PluginHost manifests, dependencies and configuration', () => {
  it('sorts dependencies stably and exposes only explicitly declared owned capabilities', async () => {
    const order: string[] = []; const a = plugin('a', (ctx) => { order.push('a'); ctx.provide.tool('demo', tool()); });
    const b = plugin('b', (ctx) => {
      order.push('b'); expect(ctx.dependencies.get('a').get('tool', 'demo').name).toBe('demo');
      expect(() => ctx.dependencies.get('c')).toThrow('did not declare');
      expect(() => ctx.dependencies.get('a').get('tool', 'c')).toThrow('does not provide');
    }); b.manifest.requires = { a: '^1.0.0' };
    const host = new PluginHost(); await host.load([b, plugin('c', () => { order.push('c'); }), a]);
    expect(order).toEqual(['c', 'a', 'b']); expect(host.manifests.map((manifest) => manifest.id)).toEqual(order); await host.dispose();
  });
  it.each([
    ['missing', () => { const a = plugin('a'); a.manifest.requires = { absent: '*' }; return [a]; }, 'missing dependency'],
    ['incompatible', () => { const a = plugin('a'); a.manifest.requires = { b: '^2.0.0' }; return [a, plugin('b')]; }, 'requires b@'],
    ['cycle', () => { const a = plugin('a'); a.manifest.requires = { b: '*' }; const b = plugin('b'); b.manifest.requires = { a: '*' }; return [a, b]; }, 'cycle'],
    ['duplicate', () => [plugin('a'), plugin('a')], 'Duplicate plugin'],
    ['api', () => { const a = plugin('a'); (a.manifest as { apiVersion: number }).apiVersion = 2; return [a]; }, 'unsupported API'],
  ])('rejects %s before any setup', async (_name, make, message) => {
    const plugins = (make as () => Plugin[])(); const setup = vi.fn(); for (const entry of plugins) entry.setup = setup;
    await expect(new PluginHost().load(plugins)).rejects.toThrow(message as string); expect(setup).not.toHaveBeenCalled();
  });
  it('reports missing optional dependencies and never substitutes another dependency', async () => {
    const a = plugin('a', (ctx) => { expect(ctx.dependencies.optional('absent')).toBeUndefined(); expect(() => ctx.dependencies.get('absent')).toThrow('unavailable'); });
    a.manifest.optional = { absent: '~1.0.0' }; const host = new PluginHost(); await host.load([a]);
    expect(host.diagnostics[0]?.code).toBe('optional_dependency_missing'); await host.dispose();
  });
  it('validates plugin config, replaces arrays by default and freezes independent snapshots', async () => {
    const raw = { a: { names: ['project'], nested: { value: 1 } } }; const config = AgentConfigSchema.parse({}); const host = new PluginHost({ config, pluginConfig: raw, configRevision: 4 });
    const a = plugin('a', (ctx) => {
      expect(ctx.config.revision).toBe(4); expect(ctx.config.value).toEqual({ names: ['project'], nested: { value: 1 } });
      expect(Object.isFrozen(ctx.config.value.names)).toBe(true); expect(Object.isFrozen(ctx.config.core.permissions)).toBe(true);
    }); a.config = { defaults: { names: ['default'] }, schema: z.object({ names: z.array(z.string()), nested: z.object({ value: z.number() }) }) };
    raw.a.nested.value = 2; await host.load([a]); await host.dispose();
  });
  it('rejects invalid configuration before setup and cleans previous resources', async () => {
    const cleanup = vi.fn(); const second = vi.fn(); const a = plugin('a', (ctx) => { ctx.onDispose(cleanup); }); const b = plugin('b', second);
    b.config = { schema: z.object({ enabled: z.boolean() }) };
    await expect(new PluginHost({ pluginConfig: { b: { enabled: 'yes' } } }).load([a, b])).rejects.toThrow();
    expect(second).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
  });
  it('captures manifest ownership before plugin code mutates its source manifest', async () => {
    const a = plugin('a', (ctx) => { a.manifest.id = 'changed'; ctx.provide.tool('demo', tool()); }); const host = new PluginHost();
    await host.load([a]); expect(host.getRecord('tool', 'demo')?.ownerPlugin).toBe('a'); expect(host.manifests[0]?.id).toBe('a'); await host.dispose();
  });
  it.each([
    ['1.2.3', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.2.4', '^0.2.3', true], ['0.3.0', '^0.2.3', false],
    ['1.3.0', '~1.2.3', false], ['1.2.4', '>=1.2.0 <2.0.0', true], ['2.0.0', '1.x || 2.0.0', true], ['1.0.0-beta', '*', false],
  ])('validates %s against %s', (version, range, expected) => { expect(satisfiesPluginVersion(version, range)).toBe(expected); });
});

describe('CapabilityRegistry ownership and selection', () => {
  it('rejects duplicate IDs and aliases instead of last registration winning', async () => {
    const host = new PluginHost(); const cleanup = vi.fn();
    await expect(host.load([
      plugin('a', (ctx) => { ctx.onDispose(cleanup); ctx.provide.tool('demo', tool(), { aliases: ['alias'] }); }),
      plugin('b', (ctx) => { ctx.provide.tool('alias', tool('alias')); }),
    ])).rejects.toThrow('Duplicate tool ID or alias'); expect(host.capabilities).toEqual([]); expect(cleanup).toHaveBeenCalledOnce();
  });
  it('validates an entire commit before any registry write', () => {
    const registry = new CapabilityRegistry();
    const record = { kind: 'tool' as const, capabilityId: 'demo', ownerPlugin: 'a', version: '1.0.0', source: 'test', aliases: [], implementation: tool() };
    expect(() => registry.commit([record, record])).toThrow('Duplicate'); expect(registry.all()).toEqual([]);
    registry.commit([record]); registry.freeze(); expect(() => registry.commit([])).toThrow('frozen');
  });
  it('requires an explicit alternative when several singleton implementations exist', async () => {
    const p = plugin('a', (ctx) => { ctx.provide.policy('legacy', policy); ctx.provide.policy('v2', policy); });
    await expect(new PluginHost().load([p])).rejects.toThrow('select one explicitly');
    const host = new PluginHost({ selections: { policy: 'v2' } }); await host.load([p]); expect(host.selected('policy')).toBe(policy); await host.dispose();
    const disabled = new PluginHost({ selections: { policy: false } }); await disabled.load([p]); expect(disabled.selected('policy')).toBeUndefined(); await disabled.dispose();
  });
  it('rejects a missing selected implementation and missing command capability', async () => {
    await expect(new PluginHost({ selections: { policy: 'missing' } }).load([])).rejects.toThrow('not found');
    await expect(new PluginHost().load([plugin('a', (ctx) => { ctx.provide.command('test', { description: 'test', requiredCapabilities: [{ kind: 'tool', id: 'missing' }], handler() {} }); })])).rejects.toThrow('requires missing capability');
  });
});

describe('legacy plugin adapter', () => {
  it('preserves old tool names, command hooks and cleanup through the transaction', async () => {
    const cleanup = vi.fn(); const host = new PluginHost();
    await host.load([adaptLegacyPlugin({ name: 'old', register(ctx) {
      ctx.tools.register(tool()); expect(ctx.tools.get('demo')?.name).toBe('demo');
      ctx.hooks.register('PreToolUse', (payload) => ({ input: { ...payload.input, legacy: true } })); return cleanup;
    } })]);
    const hooks = new HookRunner(); host.installHooks(hooks);
    expect(await hooks.runPreToolUse({ toolName: 'demo', input: {} })).toEqual({ input: { legacy: true } });
    expect(host.get('tool', 'demo')?.name).toBe('demo'); await host.dispose(); expect(cleanup).toHaveBeenCalledOnce();
  });
  it('never leaves partial tool, provider or hook writes after a legacy failure', async () => {
    const host = new PluginHost(); const hooks = new HookRunner(); const handler = vi.fn();
    await expect(host.load([adaptLegacyPlugin({ name: 'bad', register(ctx) {
      ctx.tools.register(tool()); ctx.providers.register({ name: 'demo', capabilities: { streaming: true, thinking: false }, async *stream() {} });
      ctx.hooks.register('PreToolUse', handler); throw new Error('legacy fail');
    } })])).rejects.toThrow('legacy fail');
    expect(host.capabilities).toEqual([]); expect(() => host.installHooks(hooks)).toThrow('must be loaded');
    await hooks.runPreToolUse({ toolName: 'demo', input: {} }); expect(handler).not.toHaveBeenCalled();
  });
});

 it('cleanup timeout reports failure, still releases other resources, and never claims disposed', async () => {
  let released = false;
  const host = new PluginHost({ cleanupTimeoutMs: 5 });
  await host.load([
    { manifest: { id: 'good.cleanup', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.onDispose(() => { released = true; }); } },
    { manifest: { id: 'stuck.cleanup', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.onDispose(() => new Promise<void>(() => {})); } },
  ]);
  await expect(host.dispose()).rejects.toBeInstanceOf(AggregateError);
  expect(released).toBe(true);
  expect(host.status).toBe('failed');
  expect(host.diagnostics.some(d => d.code === 'cleanup_timeout')).toBe(true);
 });

it('config layers honor scope, merge, source, schema version and secret references', async () => {
  let snapshot: unknown;
  const configured = definePlugin({ manifest: { id: 'configured', version: '1.0.0', apiVersion: 1, configVersion: 2 }, config: { defaults: { rules: ['default'], value: 0 }, scopes: ['global', 'project'] as const, merge: { rules: 'append' as const }, sensitiveFields: ['key'] }, setup(ctx) { snapshot = ctx.config; } });
  const host = new PluginHost({ pluginConfigLayers: { global: { configured: { rules: ['global'], value: 1 } }, project: { configured: { $version: 2, rules: ['project'], value: 2, key: 'env:TEST_KEY' } } } });
  await host.load([configured]);
  expect(snapshot).toMatchObject({ value: { rules: ['default', 'global', 'project'], value: 2, key: 'env:TEST_KEY' }, sources: { rules: 'project', value: 'project', key: 'project' } });
  await host.dispose();
  await expect(new PluginHost({ pluginConfigLayers: { session: { configured: { value: 3 } } } }).load([configured])).rejects.toThrow('not allowed');
  await expect(new PluginHost({ pluginConfig: { configured: { $version: 1 } } }).load([configured])).rejects.toThrow('explicit migration');
  await expect(new PluginHost({ pluginConfig: { configured: { key: 'secret' } } }).load([configured])).rejects.toThrow('env:NAME');
});
it('invalid capability methods fail before activation', async () => {
  const activate = vi.fn();
  const invalid = plugin('invalid', ctx => { ctx.onActivate(activate); ctx.provide.compactor('broken', {} as never); });
  await expect(new PluginHost().load([invalid])).rejects.toThrow('missing compact');
  expect(activate).not.toHaveBeenCalled();
});
