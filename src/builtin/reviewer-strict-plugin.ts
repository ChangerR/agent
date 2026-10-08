/** 可选严格 reviewer 独立配置；注册不等于启用，默认选择仍为 model-v1。 */
import { join } from 'node:path';
import { z } from 'zod';
import { definePlugin } from '../sdk/index.js';
import { PluginConfigStore, type ConfigSnapshot } from '../runtime/config-store.js';
import type { PresetContext } from '../runtime/preset.js';
import { createStrictModelReviewer } from './reviewer-model/index.js';
const schema = z.object({
  provider: z.string().min(1).optional(), model: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(300000).default(30000),
  maxRequestBytes: z.number().int().min(1).max(1048576).default(32768),
  maxResponseBytes: z.number().int().min(1).max(65536).default(8192),
  maxOutputTokens: z.number().int().min(1).max(8192).default(256),
  prefixCache: z.object({ enabled: z.boolean().default(false), ttl: z.enum(['5m', '1h']).default('5m') }).default({ enabled: false, ttl: '5m' }),
});
export function strictReviewerPlugin(input: PresetContext) {
  return definePlugin({ manifest: { id: 'agentlab.reviewer-strict', version: '2.0.0', apiVersion: 1, configVersion: 1 },
    config: { schema, defaults: {}, applyMode: 'new-session' },
    setup(ctx) {
      const value = schema.parse(ctx.config.value);
      const configuredModel = value.model ?? input.config.judgeModel;
      const reviewer = createStrictModelReviewer({ provider: () => input.provider(value.provider), providerSource: value.provider ? 'explicit' : 'current',
        model: configuredModel?.trim() || input.services.model, modelInfo: input.modelInfo,
        timeoutMs: value.timeoutMs, maxRequestBytes: value.maxRequestBytes, maxResponseBytes: value.maxResponseBytes, maxOutputTokens: value.maxOutputTokens, prefixCache: value.prefixCache });
      ctx.provide.reviewer('model-v2', reviewer);
      ctx.provide.settings('reviewer-strict-status', { title: '严格审批模型状态', description: '只有 capabilities.reviewer=model-v2 时使用；模型用途为 judge，决策缓存始终关闭。', applyMode: 'newSession', schema: { type: 'object' }, read: () => ({ status: reviewer.getStatus(), metrics: reviewer.getMetrics(), selected: input.capabilityChoices().reviewer?.selected === 'model-v2' }) });
      const store = new PluginConfigStore(join(input.cwd, 'agent.config.json')); let base: ConfigSnapshot | undefined;
      const drafts = new WeakMap<object, ConfigSnapshot>();
      ctx.provide.settings('reviewer-strict-config', {
        title: '严格审批模型配置', description: 'provider/model 可独立指定。这里显示下次启动配置；保存不热更新，实际加载状态见严格审批模型状态。空 model 跟随当前主模型。', applyMode: 'newSession', schema: { type: 'object' },
        read(signal) { signal.throwIfAborted(); base = store.read('agentlab.reviewer-strict'); return { ...value, ...base.value }; },
        draft(raw, signal) { signal.throwIfAborted(); if (!base) throw new Error('请先打开设置'); const draft = Object.freeze(schema.parse(raw)); drafts.set(draft, base); return draft; },
        commit(draft, signal) { signal.throwIfAborted(); if (!draft || typeof draft !== 'object' || !drafts.has(draft)) throw new Error('无效配置草稿'); base = store.commit('agentlab.reviewer-strict', drafts.get(draft)!, draft, { schema }); drafts.delete(draft); },
      });
    },
  });
}
