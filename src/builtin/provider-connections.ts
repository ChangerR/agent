/** 命名连接仍通过既有适配器和插件注册；只有用户显式配置才创建，不发送探测请求。 */
import { z } from 'zod';
import type { Provider } from '../core/provider.js';
import { loadConfigWithSources, type AgentConfig } from '../core/config.js';
import { definePlugin } from '../sdk/index.js';
import { OpenAIProvider } from '../providers/openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { FakeProvider, textResponse } from '../providers/fake.js';
import { ProviderModelsSchema } from './provider-config.js';
export const CONNECTIONS_PLUGIN = 'agentlab.provider-connections';
const name = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine(
    (v) => !['openai', 'anthropic', 'fake', 'constructor', 'prototype', '__proto__'].includes(v),
  );
const common = { displayName: z.string().min(1).optional(), enabled: z.boolean().default(true) };
const network = {
  baseURL: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    })
    .optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  models: ProviderModelsSchema,
};
export const ProviderConnectionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('openai'),
      ...common,
      ...network,
      dialect: z.enum(['auto', 'generic', 'deepseek']).default('auto'),
    })
    .describe('OpenAI 兼容连接'),
  z.object({ type: z.literal('anthropic'), ...common, ...network }).describe('Anthropic 连接'),
  z.object({ type: z.literal('fake'), ...common }).describe('离线 Fake 连接'),
]);
export const ProviderConnectionsSchema = z.object({
  connections: z.record(name, ProviderConnectionSchema).default({}),
});
function namedProvider(id: string, base: Provider): Provider {
  return {
    name: id,
    capabilities: base.capabilities,
    get routeId() {
      return id + ':' + (base.routeId ?? base.name);
    },
    ...(base.modelInfo ? { modelInfo: base.modelInfo.bind(base) } : {}),
    ...(base.modelCapabilities ? { modelCapabilities: base.modelCapabilities.bind(base) } : {}),
    ...(base.normalizeRequest ? { normalizeRequest: base.normalizeRequest.bind(base) } : {}),
    ...(base.requestBytes ? { requestBytes: base.requestBytes.bind(base) } : {}),
    ...(base.estimateRequest ? { estimateRequest: base.estimateRequest.bind(base) } : {}),
    stream: base.stream.bind(base),
  };
}
export function providerConnectionsPlugin(cwd: string, config: AgentConfig) {
  return definePlugin({
    manifest: { id: CONNECTIONS_PLUGIN, version: '1.0.0', apiVersion: 1 },
    config: {
      schema: ProviderConnectionsSchema,
      ownedFields: ['connections'],
      defaults: {},
      applyMode: 'newSession',
      validateSettings(value, scope) {
        const loaded = loadConfigWithSources(cwd),
          id = CONNECTIONS_PLUGIN;
        const global = (
          loaded.layers.global.pluginConfig as Record<string, Record<string, unknown>> | undefined
        )?.[id]?.connections;
        const project = (
          loaded.layers.project.pluginConfig as Record<string, Record<string, unknown>> | undefined
        )?.[id]?.connections;
        const raw =
          scope === 'project'
            ? (value.connections ?? global ?? {})
            : (project ?? value.connections ?? {});
        const proposed = ProviderConnectionsSchema.parse({ connections: raw }).connections;
        const previous = ProviderConnectionsSchema.parse(
          loaded.config.pluginConfig[id] ?? {},
        ).connections;
        const refs = [
          loaded.config.provider,
          ...['agentlab.planning', 'agentlab.compaction-summary', 'agentlab.reviewer-model'].map(
            (k) => loaded.config.pluginConfig[k]?.provider,
          ),
        ];
        for (const key of Object.keys(previous))
          if (refs.includes(key) && (!proposed[key] || !proposed[key].enabled))
            throw new Error('此连接仍被主任务或辅助角色引用，请先选择其他 Provider 保存。');
      },
    },
    setup(ctx) {
      const settings = ProviderConnectionsSchema.parse(ctx.config.value);
      for (const [id, item] of Object.entries(settings.connections)) {
        if (!item.enabled) continue;
        const base =
          item.type === 'fake'
            ? new FakeProvider([() => textResponse('[fake connection ' + id + ']')])
            : item.type === 'openai'
              ? new OpenAIProvider({
                  baseURL: item.baseURL,
                  apiKeyEnv: item.apiKeyEnv,
                  models: item.models,
                  dialect: item.dialect,
                })
              : new AnthropicProvider({
                  baseURL: item.baseURL,
                  apiKeyEnv: item.apiKeyEnv,
                  models: item.models,
                  cacheControl: config.cache.enabled,
                });
        ctx.provide.provider(id, namedProvider(id, base));
      }
    },
  });
}
