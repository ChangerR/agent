/** 仅暴露 adapter 的同步纯转换；此对象没有 stream，永不初始化 HTTP client。 */
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import type { Provider, ModelCapabilities } from '../core/provider.js';
import type { ModelInfo } from '../core/config.js';

export interface ProviderDescription {
  revision?: number;
  name: string;
  handle: string;
  kind: 'openai' | 'anthropic' | 'fake';
  routeId: string;
  endpoint: string;
  dialect?: 'auto' | 'generic' | 'deepseek' | 'kimi';
  cacheControl?: boolean;
  models: Record<string, ModelInfo>;
  capabilities: Record<string, ModelCapabilities>;
}
export function providerSemantics(d: ProviderDescription) {
  const base =
    d.kind === 'openai'
      ? new OpenAIProvider({ baseURL: d.endpoint, dialect: d.dialect, models: d.capabilities })
      : d.kind === 'anthropic'
        ? new AnthropicProvider({
            baseURL: d.endpoint,
            models: d.capabilities,
            cacheControl: d.cacheControl,
          })
        : undefined;
  return {
    modelInfo: (model: string) => d.models[model],
    modelCapabilities: (model: string) => d.capabilities[model],
    normalizeRequest: base?.normalizeRequest.bind(base),
    requestBytes: base?.requestBytes.bind(base),
    estimateRequest: base?.estimateRequest.bind(base),
  } satisfies Partial<Provider>;
}
