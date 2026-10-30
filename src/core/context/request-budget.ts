/** 所有模型角色共用最终请求预算；字节上限与 token 容量分别检查。 */
import { createHash } from 'node:crypto';
import type { ModelInfo } from '../config.js';
import type { ChatRequest, Provider } from '../provider.js';
import { cacheUsage, mergeUsage, type TokenUsage } from '../protocol/types.js';
import { estimateRequestTokens } from './tokens.js';

export interface RequestEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  baseInputTokens?: number;
  calibrated?: boolean;
}
export interface RequestLimits {
  model?: ModelInfo;
  maxRequestBytes?: number;
}
export function normalizeModelRequest(provider: Provider, request: ChatRequest): ChatRequest {
  const info = provider.modelInfo?.(request.model);
  const req = info
    ? {
        ...request,
        maxTokens: Math.min(request.maxTokens ?? info.maxOutputTokens, info.maxOutputTokens),
      }
    : { ...request, maxTokens: request.maxTokens ?? 8192 };
  return provider.normalizeRequest?.(req) ?? req;
}
export function estimateModelRequest(provider: Provider, req: ChatRequest): RequestEstimate {
  const normalized = normalizeModelRequest(provider, req);
  return provider.estimateRequest?.(normalized) ?? estimateRequestTokens(normalized);
}
export function prepareModelRequest(
  provider: Provider,
  request: ChatRequest,
  limits: RequestLimits = {},
) {
  const info = limits.model ?? provider.modelInfo?.(request.model);
  const req = normalizeModelRequest(
    provider,
    info
      ? {
          ...request,
          maxTokens: Math.min(request.maxTokens ?? info.maxOutputTokens, info.maxOutputTokens),
        }
      : request,
  );
  const estimate = estimateModelRequest(provider, req);
  if (
    ![estimate.inputTokens, estimate.outputTokens, estimate.totalTokens].every(
      (n) => Number.isFinite(n) && n >= 0,
    )
  )
    throw new Error('invalid_request_estimate');
  if (info && estimate.outputTokens > info.maxOutputTokens)
    throw new Error(
      `output_budget_exceeded: final output reserve ${estimate.outputTokens} > model maximum ${info.maxOutputTokens}`,
    );
  if (info && estimate.totalTokens > info.contextWindow)
    throw new Error(
      `context_budget_exceeded: estimated input ${estimate.inputTokens} + output reserve ${estimate.outputTokens} > context window ${info.contextWindow}; request not sent`,
    );
  const bytes = provider.requestBytes?.(req) ?? Buffer.byteLength(JSON.stringify(req));
  if (limits.maxRequestBytes !== undefined && bytes > limits.maxRequestBytes)
    throw new Error(`request_byte_budget_exceeded: ${bytes} > ${limits.maxRequestBytes}`);
  return { request: req, estimate, bytes };
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Anchor {
  prefix: string[];
  estimated: number;
  actual: number;
}
/** 只保留摘要指纹和计数，不保留请求原文。仅同一路由/包络、完整 append-only 前缀可校准。 */
export class UsageAnchors {
  private anchors = new Map<string, Anchor>();
  private image(req: ChatRequest) {
    return {
      key: hash({
        model: req.model,
        system: req.system,
        systemSegments: req.systemSegments,
        tools: req.tools,
        thinking: req.thinking,
        maxTokens: req.maxTokens,
        toolChoice: req.toolChoice,
        replayToolArguments: req.replayToolArguments,
      }),
      prefix: req.messages.map(hash),
    };
  }
  estimate(req: ChatRequest, base: RequestEstimate): RequestEstimate {
    const { key, prefix } = this.image(req);
    const anchor = this.anchors.get(key);
    const matches =
      anchor &&
      anchor.prefix.length <= prefix.length &&
      anchor.prefix.every((v, i) => v === prefix[i]);
    const inputTokens = matches
      ? Math.max(base.inputTokens, anchor.actual + base.inputTokens - anchor.estimated)
      : base.inputTokens;
    return {
      ...base,
      inputTokens,
      totalTokens: inputTokens + base.outputTokens,
      baseInputTokens: base.inputTokens,
      calibrated: Boolean(matches && inputTokens !== base.inputTokens),
    };
  }
  observe(req: ChatRequest, base: RequestEstimate, usage: Partial<TokenUsage>) {
    // 不把缺失桶当作 0；失败/无 usage 的请求不能成为锚点。
    const cache = cacheUsage(usage);
    if (!cache) return;
    const { key, prefix } = this.image(req);
    this.anchors.delete(key);
    this.anchors.set(key, {
      prefix,
      estimated: base.inputTokens,
      actual: cache.hitTokens + cache.missTokens,
    });
    if (this.anchors.size > 32) this.anchors.delete(this.anchors.keys().next().value!);
  }
}

const guarded = new WeakSet<Provider>();
const wrappers = new WeakMap<
  Provider,
  Map<((model: string) => ModelInfo | undefined) | undefined, Provider>
>();
/** runtime 和独立 loop 使用同一装饰器，连未经过观测器的插件调用也不能绕过预算。 */
export function withRequestBudget(
  provider: Provider,
  modelInfo?: (model: string) => ModelInfo | undefined,
): Provider {
  if (guarded.has(provider)) return provider;
  const existing = wrappers.get(provider)?.get(modelInfo);
  if (existing) return existing;
  const anchors = new UsageAnchors();
  const result: Provider = {
    name: provider.name,
    routeId: provider.routeId ?? provider.name,
    capabilities: provider.capabilities,
    modelInfo: (model) => provider.modelInfo?.(model) ?? modelInfo?.(model),
    normalizeRequest: (req) => provider.normalizeRequest?.(req) ?? req,
    modelCapabilities: (model) => provider.modelCapabilities?.(model),
    requestBytes: (req) => provider.requestBytes?.(req) ?? Buffer.byteLength(JSON.stringify(req)),
    estimateRequest(req) {
      const normalized = normalizeModelRequest(result, req);
      const base = provider.estimateRequest?.(normalized) ?? estimateRequestTokens(normalized);
      return anchors.estimate(normalized, base);
    },
    async *stream(request, signal, trace) {
      signal.throwIfAborted();
      const { request: req } = prepareModelRequest(result, request);
      const base = provider.estimateRequest?.(req) ?? estimateRequestTokens(req);
      const usage: Partial<TokenUsage> = {};
      let complete = false;
      for await (const event of provider.stream(req, signal, trace)) {
        if (event && typeof event === 'object' && event.type === 'usage') mergeUsage(usage, event);
        if (event && typeof event === 'object' && event.type === 'message_stop') complete = true;
        yield event;
      }
      if (complete && !signal.aborted) anchors.observe(req, base, usage);
    },
  };
  guarded.add(result);
  if (!wrappers.has(provider)) wrappers.set(provider, new Map());
  wrappers.get(provider)!.set(modelInfo, result);
  return result;
}
