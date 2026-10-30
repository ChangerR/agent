/** 一次提交模型、命名连接和加密凭据；复用文件身份/CAS，不创建运行时或发送请求。 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getGlobalConfigPath } from '../../src/core/paths.js';
import { AgentConfigSchema, loadConfigWithSources } from '../../src/core/config.js';
import {
  ConfigConflictError,
  PluginConfigStore,
  type ConfigSnapshot,
} from '../../src/runtime/config-store.js';
import { assertManagedSettingsPath } from '../../src/builtin/settings-paths.js';
import { ProviderConnectionSchema } from '../../src/builtin/provider-connections.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { CredentialVault } from './credentials.js';
import {
  MODEL_SERVICES,
  officialEndpoints,
  type ModelService,
  type ModelSetupView,
} from '../shared/model-setup.js';

const modelServiceSchema = z.enum(['deepseek', 'kimi', 'custom']);
const modelSetupSaveSchema = z
  .object({
    token: z.string().uuid(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\s\u0000-\u001f]+$/),
    endpoint: z
      .string()
      .trim()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          !/\/(chat\/completions|messages)\/?$/.test(url.pathname)
        );
      }),
    protocol: z.enum(['openai', 'anthropic']),
    key: z
      .string()
      .max(16384)
      .refine((value) => !/[\u0000\r\n]/.test(value)),
  })
  .strict();

const plugin = 'agentlab.provider-connections';
export class ModelSetupError extends Error {}
const endpoint = (value: string) => value.replace(/\/+$/, '');
type Item = Record<string, unknown>;
const object = (value: unknown): Item =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Item) : {};
function serviceFor(url: string, protocol: string): ModelService {
  return protocol === 'openai'
    ? ((Object.keys(MODEL_SERVICES).find((id) =>
        officialEndpoints(id as 'deepseek' | 'kimi').includes(endpoint(url)),
      ) as ModelService) ?? 'custom')
    : 'custom';
}
export class ModelSetupSettings {
  private store = new PluginConfigStore(getGlobalConfigPath());
  private tokens = new Map<
    string,
    {
      base: ConfigSnapshot;
      vault: ConfigSnapshot;
      service: ModelService;
      provider: string;
      item: Item;
    }
  >();
  constructor(private vault: CredentialVault) {}
  read(choice?: unknown): ModelSetupView {
    assertManagedSettingsPath(dirname(this.store.path), this.store.path);
    const base = this.store.readDocument();
    const cwd = join(dirname(this.store.path), '.settings-context');
    const config = loadConfigWithSources(cwd, {}, { globalOnly: true }).config;
    const plugins = object(base.value.pluginConfig),
      connections = object(object(plugins[plugin]).connections),
      active = object(connections[config.provider]);
    const currentEndpoint = String(
      active.baseURL ??
        config.baseURL ??
        (config.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'),
    );
    const currentProtocol = String(active.type ?? config.provider);
    const inferred = serviceFor(currentEndpoint, currentProtocol);
    const service =
      choice === undefined
        ? Object.keys(base.value).length
          ? inferred
          : 'deepseek'
        : modelServiceSchema.parse(choice);
    let provider: string, item: Item;
    if (service !== 'custom') {
      const match = Object.entries(connections)
        .sort(([a], [b]) => Number(b === config.provider) - Number(a === config.provider))
        .find(([id, raw]) => {
          const v = object(raw);
          return (
            v.type === 'openai' &&
            officialEndpoints(service).includes(endpoint(String(v.baseURL ?? ''))) &&
            (id === config.provider || v.enabled !== false)
          );
        });
      provider = match?.[0] ?? this.unusedId('quick-' + service, connections);
      item = match ? object(match[1]) : {};
    } else if (Object.keys(active).length && inferred === 'custom') {
      provider = config.provider;
      item = active;
    } else {
      provider = this.unusedId('quick-custom', connections);
      item = {};
    }
    const preset = service === 'custom' ? undefined : MODEL_SERVICES[service];
    const url = String(item.baseURL ?? preset?.endpoint ?? currentEndpoint);
    const protocol = preset
      ? 'openai'
      : item.type === 'anthropic' || currentProtocol === 'anthropic'
        ? 'anthropic'
        : 'openai';
    const vault = this.vault.read();
    const ref = item.apiKeyRef as string | undefined;
    const entry = ref ? object(vault.value[ref]) : {};
    const token = randomUUID();
    this.tokens.clear();
    this.tokens.set(token, { base, vault, service, provider, item });
    return {
      token,
      service,
      endpoint: url,
      protocol,
      model:
        config.provider === provider &&
        (!preset || (preset.models as readonly string[]).includes(config.model))
          ? config.model
          : (preset?.models[0] ?? config.model),
      configured: !!ref && entry.binding === JSON.stringify([provider, protocol, endpoint(url)]),
      available: this.vault.status().available,
    };
  }
  private unusedId(prefix: string, connections: Item): string {
    if (!Object.hasOwn(connections, prefix)) return prefix;
    for (let i = 2; ; i++)
      if (!Object.hasOwn(connections, prefix + '-' + i)) return prefix + '-' + i;
  }
  save(input: unknown): void {
    const parsed = modelSetupSaveSchema.safeParse(input);
    if (!parsed.success)
      throw new ModelSetupError(
        '请填写模型 ID、有效的 API 基础地址和协议；地址不要包含 /chat/completions 或 /messages。',
      );
    const data = parsed.data,
      saved = this.tokens.get(data.token);
    this.tokens.delete(data.token);
    if (!saved) throw new ModelSetupError('配置已变化，请重新读取后保存。');
    const { base, service, provider, item } = saved;
    if (service !== 'custom') {
      const preset = MODEL_SERVICES[service];
      if (
        !officialEndpoints(service).includes(endpoint(data.endpoint)) ||
        data.protocol !== 'openai' ||
        !(preset.models as readonly string[]).includes(data.model)
      )
        throw new ModelSetupError('官方连接的端点、协议和模型由预设提供；其他服务请选择自定义。');
    }
    const target = { provider, type: data.protocol, endpoint: endpoint(data.endpoint) };
    const identity = JSON.stringify([provider, target.type, target.endpoint]);
    const oldRef = item.apiKeyRef as string | undefined;
    const oldEntry = oldRef ? object(saved.vault.value[oldRef]) : {};
    const reuse = !!oldRef && oldEntry.binding === identity;
    if (!data.key.trim() && !reuse)
      throw new ModelSetupError('请粘贴这个服务的 API Key；更换端点或协议后需要重新输入。');
    const reference = reuse ? oldRef! : 'cred_' + randomUUID().replaceAll('-', '');
    const nextItem: Item = {
      ...item,
      type: target.type,
      baseURL: target.endpoint,
      apiKeyRef: reference,
      enabled: true,
      displayName:
        service === 'custom' ? (item.displayName ?? '自定义服务') : MODEL_SERVICES[service].label,
    };
    delete nextItem.apiKeyEnv;
    // 协议切换时，不能继承另一协议的模型能力声明。
    if (item.type && item.type !== target.type) {
      delete nextItem.models;
      delete nextItem.dialect;
    }
    if (target.type === 'openai')
      nextItem.dialect = service === 'deepseek' ? 'deepseek' : service === 'kimi' ? 'kimi' : 'auto';
    ProviderConnectionSchema.parse(nextItem);
    const next = structuredClone(base.value) as Item;
    const plugins = { ...object(next.pluginConfig) },
      configuration = { ...object(plugins[plugin]) };
    configuration.connections = { ...object(configuration.connections), [provider]: nextItem };
    plugins[plugin] = configuration;
    next.pluginConfig = plugins;
    if (Array.isArray(next.disabledPlugins) && next.disabledPlugins.includes(plugin))
      next.disabledPlugins = next.disabledPlugins.filter((id) => id !== plugin);
    next.provider = provider;
    next.model = data.model;
    // 命名连接自己持有身份，不能遗留上个内置 Provider 的顶层覆盖。
    delete next.baseURL;
    delete next.apiKeyEnv;
    if (base.value.provider !== provider) next.thinking = service === 'kimi' ? 'high' : 'off';
    if (target.type === 'openai') {
      const levels = new OpenAIProvider({
        baseURL: target.endpoint,
        dialect: nextItem.dialect as 'auto' | 'deepseek' | 'kimi',
      }).modelCapabilities(data.model).thinkingLevels;
      if (levels && !levels.includes(next.thinking as 'off'))
        next.thinking = levels.includes('off')
          ? 'off'
          : levels.includes('high')
            ? 'high'
            : levels[0];
    }
    AgentConfigSchema.parse(next);
    this.store.assertUnchanged(base);
    let written: ConfigSnapshot | undefined;
    if (data.key.trim())
      written = this.vault.write(saved.vault, {
        ...saved.vault.value,
        [reference]: this.vault.encrypt(data.key.trim(), target),
      });
    else if (this.vault.read().revision !== saved.vault.revision) throw new ConfigConflictError();
    try {
      this.store.commitDocument(base, next);
    } catch (error) {
      if (written)
        try {
          this.vault.write(written, { ...saved.vault.value });
        } catch {
          throw new ModelSetupError('配置保存冲突且密文回滚未完成，请重新读取设置；未输出密钥。');
        }
      throw error;
    }
  }
}
