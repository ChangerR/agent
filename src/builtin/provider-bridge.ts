import { definePlugin } from '../sdk/index.js';
import { BridgeProvider } from '../providers/bridge.js';
import type { ProviderDescription } from '../providers/semantics.js';
import type { BridgeTransport } from '../providers/bridge.js';

/** 宿主注入已授权清单，所有模型角色仍经同一 provider 注册表。 */
export function providerBridgePlugin(
  channel: BridgeTransport,
  descriptions: ProviderDescription[],
) {
  return definePlugin({
    manifest: { id: 'agentlab.provider-bridge', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      for (const d of descriptions) ctx.provide.provider(d.name, new BridgeProvider(channel, d));
    },
  });
}
/** 只向远程目录提供本机授权的规格，避免模型选择器展示无法调用的模型。 */
export function bridgeModelCatalogPlugin(descriptions: ProviderDescription[]) {
  return definePlugin({
    manifest: { id: 'agentlab.bridge-model-catalog', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.modelCatalog('presets', {
        get: (model, route) =>
          descriptions.find(
            (d) => (!route || d.name === route || d.routeId === route) && d.models[model],
          )?.models[model],
        list: () => Object.fromEntries(descriptions.flatMap((d) => Object.entries(d.models))),
      });
    },
  });
}
