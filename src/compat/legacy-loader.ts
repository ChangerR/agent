/** 旧加载入口同样先完整启动事务，成功后才原子写入调用方的启动期注册表。 */
import type { Plugin as LegacyPlugin, PluginContext } from '../core/plugin.js';
import type { RegisteredHook } from '../core/hooks.js';
import type { RegistrationBatch } from '../core/registration.js';
import { definePlugin } from '../sdk/plugin.js';
import { PluginHost } from '../runtime/plugin-host.js';
import { adaptLegacyPlugin } from './legacy-plugin.js';

const SEED_ID = 'agentlab.compat-seed';
export async function loadPlugins(plugins: LegacyPlugin[], context: PluginContext): Promise<() => Promise<void>> {
  const providerSeed = context.providers.list();
  const toolSeed = context.tools.list();
  const seed = definePlugin({ manifest: { id: SEED_ID, version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    for (const provider of providerSeed) ctx.provide.provider(provider.name, provider);
    for (const tool of toolSeed) ctx.provide.tool(tool.name, tool, { aliases: context.tools.aliasesFor(tool.name) });
  } });
  const prior = [SEED_ID];
  const adapted = plugins.map(plugin => {
    const result = adaptLegacyPlugin(plugin, { config: context.config, requires: Object.fromEntries(prior.map(id => [id, '*'])) });
    prior.push(result.manifest.id); return result;
  });
  const host = new PluginHost({ config: context.config });
  await host.load([seed, ...adapted]);
  const batches: RegistrationBatch[] = [];
  try {
    const hooks: RegisteredHook[] = [];
    host.installHooks({ register(point, handler) { hooks.push({ point, handler }); } });
    // 对不可回滚的外部注册回调，无法兑现原子提交；明确报错而非留下半个插件。
    if (hooks.length && !context.hooks.prepareBatch) {
      throw new Error('Transactional legacy hook registration requires hooks.prepareBatch; pass hookRunner.registrationSink() or the HookRunner instance to loadPlugins');
    }
    batches.push(context.providers.prepareBatch(host.list('provider').filter(record => record.ownerPlugin !== SEED_ID).map(record => record.implementation)));
    batches.push(context.tools.prepareBatch(host.list('tool').filter(record => record.ownerPlugin !== SEED_ID).map(record => record.implementation)));
    if (hooks.length) batches.push(context.hooks.prepareBatch!(hooks));
    for (const batch of batches) batch.validate();
    for (const batch of batches) batch.commit();
    for (const batch of batches) batch.seal();
  } catch (error) {
    const errors: unknown[] = [error];
    for (const batch of [...batches].reverse()) { try { batch.rollback(); } catch (rollbackError) { errors.push(rollbackError); } }
    try { await host.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, 'Legacy plugin commit and cleanup failed');
    throw error;
  }
  return () => host.dispose();
}
