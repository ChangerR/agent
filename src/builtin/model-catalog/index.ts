import { definePlugin } from '../../sdk/index.js';
import type { ModelCatalog } from '../../sdk/runtime-capabilities.js';
import type { ModelInfo } from '../../core/config.js';
import { MODEL_PRESETS } from './presets.js';
export { MODEL_PRESETS } from './presets.js';
export function createModelCatalog(overrides: Readonly<Record<string, ModelInfo>> = {}): ModelCatalog {
  const models = Object.freeze(Object.fromEntries(Object.entries({ ...MODEL_PRESETS, ...overrides }).map(([name, info]) => [name, Object.freeze({ ...info })])));
  return { get: (name) => models[name], list: () => models };
}
export function createModelCatalogPlugin(overrides: Readonly<Record<string, ModelInfo>> = {}) {
  return definePlugin({
    manifest: { id: 'agentlab.model-catalog', version: '1.0.0', apiVersion: 1 },
    setup(ctx) { ctx.provide.modelCatalog('presets', createModelCatalog(overrides)); },
  });
}
