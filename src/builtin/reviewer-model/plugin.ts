/** 模型审批员的独立配置与状态。 */
import { z } from 'zod';
import { definePlugin, type SettingsScope } from '../../sdk/index.js';
import { createScopedConfigStores, type ConfigSnapshot } from '../../runtime/config-store.js';
import type { PresetContext } from '../../runtime/preset.js';
import { createModelReviewer } from './index.js';
const schema = z.object({
  provider: z.string().min(1).optional(), model: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(300000).default(30000),
  maxRequestBytes: z.number().int().min(1).max(1048576).default(32768),
  maxResponseBytes: z.number().int().min(1).max(65536).default(8192),
  maxOutputTokens: z.number().int().min(1).max(8192).default(256),
  prefixCache: z.object({ enabled: z.boolean().default(false), ttl: z.enum(['5m', '1h']).default('5m') }).default({ enabled: false, ttl: '5m' }),
});
const configDefinition = {
  schema, ownedFields: ['provider', 'model', 'timeoutMs', 'maxRequestBytes', 'maxResponseBytes', 'maxOutputTokens', 'prefixCache'],
  defaults: {}, applyMode: 'newSession' as const,
};
// 编辑某一层时，省略字段代表继承；运行时 schema 的默认值不能被回填到这一层。
const editSchema = schema.partial();
const editDefinition = { ...configDefinition, schema: editSchema };
export function modelReviewerPlugin(input: PresetContext) {
  return definePlugin({ manifest: { id: 'agentlab.reviewer-model', version: '2.0.0', apiVersion: 1 },
    config: configDefinition,
    setup(ctx) {
      const value = schema.parse(ctx.config.value);
      const configuredModel = value.model ?? input.config.judgeModel;
      const reviewer = createModelReviewer({ provider: () => input.provider(value.provider), providerSource: value.provider ? 'explicit' : 'current',
        model: configuredModel?.trim() || input.services.model, modelInfo: input.modelInfo,
        timeoutMs: value.timeoutMs, maxRequestBytes: value.maxRequestBytes, maxResponseBytes: value.maxResponseBytes, maxOutputTokens: value.maxOutputTokens, prefixCache: value.prefixCache });
      ctx.provide.reviewer('model', reviewer);
      ctx.provide.settings('reviewer-model-status', { title: '严格审批模型状态', description: '只有 capabilities.reviewer=model 时使用；模型用途为 judge，决策缓存始终关闭。', applyMode: 'newSession', schema: { type: 'object' }, read: () => ({ status: reviewer.getStatus(), metrics: reviewer.getMetrics(), selected: input.capabilityChoices().reviewer?.selected === 'model' }) });
      const stores = createScopedConfigStores(input.cwd); const bases = new Map<SettingsScope, ConfigSnapshot>();
      const drafts = new WeakMap<object, { scope: SettingsScope; base: ConfigSnapshot }>();
      ctx.provide.settings('reviewer-model-config', {
        title: '严格审批模型配置', description: '只编辑所选层的原始配置；省略字段即删除该层覆盖并继承。provider/model 可独立指定。保存仅下次启动生效，实际加载状态见严格审批模型状态。空 model 跟随当前主模型。', applyMode: 'newSession', schema: { type: 'object' },
        scopeTargets: stores.scopeTargets,
        read(signal, scope = 'project') { signal.throwIfAborted(); const base = stores.store(scope).read('agentlab.reviewer-model'); bases.set(scope, base); return structuredClone(base.value); },
        draft(raw, signal, scope = 'project') { signal.throwIfAborted(); stores.store(scope); const base = bases.get(scope); if (!base) throw new Error('请先打开此作用域设置'); const draft = Object.freeze(editSchema.parse(raw)); drafts.set(draft, { scope, base }); return draft; },
        commit(draft, signal, scope = 'project') { signal.throwIfAborted(); if (!draft || typeof draft !== 'object' || !drafts.has(draft)) throw new Error('无效配置草稿'); const saved = drafts.get(draft)!;
          if (saved.scope !== scope) throw new Error('草稿作用域不匹配，请重新打开设置。');
          bases.set(scope, stores.store(scope).commit('agentlab.reviewer-model', saved.base, draft, editDefinition)); drafts.delete(draft); },
      });
    },
  });
}
