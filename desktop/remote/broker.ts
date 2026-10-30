/** 只装配可信本地模型适配器；不装配远程插件或工具，不加载项目 .env。 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentConfig } from '../../src/core/config.js';
import type { Provider, ChatRequest, ModelCapabilities } from '../../src/core/provider.js';
import type { StreamEvent } from '../../src/core/protocol/types.js';
import type { ApiTransport } from '../../src/core/protocol/transport.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { FakeProvider, textResponse } from '../../src/providers/fake.js';
import { credentialBinding, storedApiKey } from '../../src/providers/api-key.js';
import { ProviderConnectionsSchema } from '../../src/builtin/provider-connections.js';
import { createModelCatalog } from '../../src/builtin/model-catalog/index.js';
import { loadModelsFile } from '../../src/core/config.js';
import { chatSchema } from './protocol.js';
import type { ProviderDescription } from '../../src/providers/semantics.js';

interface Route {
  provider: Provider;
  description: ProviderDescription;
  busy: boolean;
}
type Item = { seq: number; event?: StreamEvent; trace?: ApiTransport };
interface Call {
  abort: AbortController;
  queue: Item[];
  bytes: number;
  done: boolean;
  error?: string;
  nextSeq: number;
  wake?: () => void;
  space?: () => void;
  route: Route;
  timer: ReturnType<typeof setTimeout>;
  reading?: boolean;
  revision: number;
}
export class ModelBroker {
  private routes = new Map<string, Route>();
  private calls = new Map<string, Call>();
  private cancelled = new Set<string>();
  private used = new Set<string>();
  private closed = false;
  private enabled = false;
  private consumed = 0;
  constructor(private maxTokens = 2000000) {}
  activate() {
    this.enabled = true;
  }
  add(provider: Provider, description: Omit<ProviderDescription, 'handle'>) {
    const d = { ...description, handle: randomUUID(), revision: 0 };
    this.routes.set(d.handle, { provider, description: d, busy: false });
    return structuredClone(d);
  }
  async handle(method: string, raw: unknown) {
    if (this.closed || !this.enabled) throw new Error('BROKER_INACTIVE');
    if (method === 'model.cancel') {
      const { callId } = z.object({ callId: z.string().uuid() }).strict().parse(raw);
      if (this.cancelled.size >= 1024) throw new Error('CALL_LIMIT');
      this.cancelled.add(callId);
      const c = this.calls.get(callId);
      if (c) {
        c.abort.abort();
        c.wake?.();
        c.space?.();
        this.finish(callId);
      }
      return null;
    }
    if (method === 'model.open') {
      const { callId, handle, request, revision } = z
        .object({
          callId: z.string().uuid(),
          handle: z.string().uuid(),
          revision: z.number().int().nonnegative().default(0),
          request: chatSchema,
        })
        .strict()
        .parse(raw);
      if (this.cancelled.has(callId)) throw new Error('ABORTED');
      if (this.used.has(callId)) throw new Error('CALL_CONFLICT');
      if (this.used.size >= 10000) throw new Error('CALL_LIMIT');
      if (this.calls.size >= 4) throw new Error('CALL_LIMIT');
      const route = this.routes.get(handle);
      if (!route || !route.description.models[request.model]) throw new Error('ROUTE_UNAVAILABLE');
      if (revision !== (route.description.revision ?? 0)) throw new Error('ROUTE_STALE');
      const info = route.description.models[request.model];
      const estimate = route.provider.estimateRequest?.(request);
      if (
        !request.maxTokens ||
        request.maxTokens > info.maxOutputTokens ||
        (estimate && estimate.totalTokens > info.contextWindow) ||
        JSON.stringify(request).length > 16 * 1024 * 1024
      )
        throw new Error('REQUEST_LIMIT');
      const reserve = estimate?.totalTokens ?? info.contextWindow;
      if (this.consumed + reserve > this.maxTokens) throw new Error('BROKER_BUDGET');
      this.consumed += reserve; // 未报告 usage 的中断保留预留，不冒充零消耗。
      this.used.add(callId);
      const call: Call = {
        route,
        revision,
        abort: new AbortController(),
        queue: [],
        bytes: 0,
        nextSeq: 0,
        done: false,
        timer: setTimeout(
          () => {
            call.abort.abort();
            call.wake?.();
            call.space?.();
            this.finish(callId);
          },
          15 * 60 * 1000,
        ),
      };
      this.calls.set(callId, call);
      void this.pump(callId, call, request);
      return { accepted: true };
    }
    if (method === 'model.next') {
      const { callId } = z.object({ callId: z.string().uuid() }).strict().parse(raw);
      const c = this.calls.get(callId);
      if (!c || c.reading) throw new Error('CALL_UNAVAILABLE');
      c.reading = true;
      try {
        if (!c.queue.length && !c.done && !c.abort.signal.aborted)
          await new Promise<void>((r) => {
            c.wake = r;
          });
        c.wake = undefined;
        if (c.abort.signal.aborted) throw new Error('ABORTED');
        const events = c.queue.splice(0, 64);
        c.bytes = c.queue.reduce((n, item) => n + Buffer.byteLength(JSON.stringify(item)), 0);
        c.space?.();
        c.space = undefined;
        const done = c.done && !c.queue.length;
        const result = {
          events,
          done,
          ...(done && c.error ? { error: c.error } : {}),
          ...(done && c.route.provider instanceof AnthropicProvider
            ? {
                cacheControl: c.route.provider.cacheControlEnabled,
                revision: c.route.description.revision,
              }
            : {}),
        };
        if (done) this.finish(callId);
        return result;
      } finally {
        c.reading = false;
      }
    }
    throw new Error('METHOD_UNAVAILABLE');
  }
  private async pump(id: string, c: Call, request: ChatRequest) {
    try {
      while (c.route.busy) {
        if (c.abort.signal.aborted || this.closed) throw new Error('ABORTED');
        await new Promise<void>((r) => setTimeout(r, 10));
      }
      if (c.abort.signal.aborted) throw new Error('ABORTED');
      if (c.revision !== (c.route.description.revision ?? 0)) throw new Error('ROUTE_STALE');
      c.route.busy = true;
      let usage = 0,
        reported = false;
      try {
        for await (const event of c.route.provider.stream(request, c.abort.signal, {
          onTransport: (trace) => {
            const json = JSON.stringify(trace);
            // 诊断副本可截断；执行事件不得丢弃。避免 fetch 回调积累无界正文。
            if (c.bytes < 256 * 1024)
              this.push(c, {
                trace:
                  json.length <= 64000 ? trace : { ...trace, body: undefined, truncated: true },
              });
          },
        })) {
          if (c.abort.signal.aborted) throw new Error('ABORTED');
          if (event.type === 'usage') {
            reported = true;
            usage +=
              (event.inputTokens ?? 0) +
              (event.outputTokens ?? 0) +
              (event.cacheReadTokens ?? 0) +
              (event.cacheWriteTokens ?? 0);
          }
          this.push(c, { event });
          if (c.bytes >= 512 * 1024)
            await new Promise<void>((r) => {
              c.space = r;
            });
        }
        if (reported) {
          const estimate = c.route.provider.estimateRequest?.(request);
          this.consumed -= Math.max(
            0,
            (estimate?.totalTokens ?? c.route.description.models[request.model].contextWindow) -
              usage,
          );
        }
      } finally {
        if (
          c.route.provider instanceof AnthropicProvider &&
          c.route.description.cacheControl !== c.route.provider.cacheControlEnabled
        ) {
          c.route.description.cacheControl = c.route.provider.cacheControlEnabled;
          c.route.description.revision = (c.route.description.revision ?? 0) + 1;
        }
        c.route.busy = false;
      }
    } catch (e) {
      c.error = c.abort.signal.aborted
        ? 'ABORTED'
        : e instanceof Error && e.message === 'ROUTE_STALE'
          ? 'ROUTE_STALE'
          : 'MODEL_REQUEST_FAILED';
    } finally {
      c.done = true;
      c.wake?.();
    }
  }
  private push(c: Call, item: Omit<Item, 'seq'>) {
    const value = { seq: c.nextSeq++, ...item };
    c.queue.push(value);
    c.bytes += Buffer.byteLength(JSON.stringify(value));
    c.wake?.();
  }
  private finish(id: string) {
    const c = this.calls.get(id);
    if (c) clearTimeout(c.timer);
    this.calls.delete(id);
  }
  close() {
    this.closed = true;
    for (const [id, c] of this.calls) {
      c.abort.abort();
      c.wake?.();
      c.space?.();
      this.finish(id);
    }
    this.routes.clear();
    this.cancelled.clear();
    this.used.clear();
  }
}

export function configureBroker(
  broker: ModelBroker,
  config: AgentConfig,
  requirements: Array<{ name: string; models: string[] }>,
  mappings: Record<string, string>,
  resolveCredential?: (ref: string, identity?: string) => string,
): ProviderDescription[] {
  const connections = ProviderConnectionsSchema.parse(
    config.pluginConfig['agentlab.provider-connections'] ?? {},
  ).connections;
  const catalog = createModelCatalog(loadModelsFile(config.modelsFile));
  return requirements.map((required) => {
    const local =
      mappings[required.name] ?? (required.name === config.provider ? required.name : undefined);
    if (!local) throw new Error('ROUTE_MAPPING_REQUIRED');
    const builtin = ['openai', 'anthropic', 'fake'].includes(local);
    const item: Record<string, unknown> | undefined = builtin
      ? (config.pluginConfig['agentlab.provider-' + local] ?? {})
      : connections[local];
    if (!item || (!builtin && item.enabled === false)) throw new Error('ROUTE_UNAVAILABLE');
    const kind = (builtin ? local : item.type) as ProviderDescription['kind'];
    const endpoint = String(
      (builtin && config.provider === local ? config.baseURL : undefined) ??
        item.baseURL ??
        (kind === 'openai'
          ? (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1')
          : (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com')),
    );
    const u = new URL(endpoint);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      throw new Error('INVALID_ENDPOINT');
    const models: ProviderDescription['models'] = {};
    for (const model of required.models) {
      const info = catalog.get(model, local);
      if (!info) throw new Error('MODEL_SPEC_REQUIRED');
      models[model] = info;
    }
    const options = {
      baseURL: endpoint,
      models: item.models as Record<string, ModelCapabilities> | undefined,
      apiKeyEnv:
        (item.apiKeyEnv as string | undefined) ??
        (builtin && local === config.provider ? config.apiKeyEnv : undefined),
      apiKeyResolver:
        typeof item.apiKeyRef === 'string'
          ? (actual: string) =>
              storedApiKey(
                item.apiKeyRef as string,
                resolveCredential,
                credentialBinding(local, kind, actual),
              )!
          : undefined,
    };
    const provider: Provider =
      kind === 'openai'
        ? new OpenAIProvider({
            ...options,
            dialect: item.dialect as 'auto' | 'generic' | 'deepseek' | 'kimi' | undefined,
          })
        : kind === 'anthropic'
          ? new AnthropicProvider({ ...options, cacheControl: config.cache.enabled })
          : new FakeProvider([() => textResponse('[fake connection ' + local + ']')]);
    return broker.add(provider, {
      name: required.name,
      kind,
      routeId: builtin ? (provider.routeId ?? local) : local + ':' + (provider.routeId ?? local),
      endpoint,
      models,
      capabilities: Object.fromEntries(
        required.models.map((model) => [
          model,
          provider.modelCapabilities?.(model) ?? { api: 'generic' },
        ]),
      ),
      cacheControl: config.cache.enabled,
      dialect: item.dialect as ProviderDescription['dialect'],
    });
  });
}
