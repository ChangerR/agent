/**
 * Provider 插件接口。
 *
 * Provider 的唯一职责：给定规范化请求，产出规范化流式事件。
 * 厂商 SDK 的所有细节都被关在各自的 adapter 里。
 */
import type { Message, StreamEvent, ToolDefinition, StopReason } from './protocol/types.js';
import { cacheUsage, emptyUsage, mergeUsage, type TokenUsage } from './protocol/types.js';
import { randomUUID } from 'node:crypto';
import type { EventBus } from './events.js';
import type { ModelInfo } from './config.js';
import {
  prepareModelRequest,
  type RequestEstimate,
  type RequestLimits,
} from './context/request-budget.js';

/** 思考等级：off 关闭；low/medium/high 由各 provider 映射到自己的 API 参数 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Anthropic prompt cache 的存活时间。5 分钟不传 ttl 字段；1 小时要带 beta 头 */
export type CacheTtl = '5m' | '1h';

/**
 * 这一次请求要在哪些稳定前缀上打断点。
 * 断点语义放在协议层，wire 格式（cache_control）只由 Anthropic adapter 翻译。
 * 此字段只控制显式缓存；厂商自动缓存可能独立产生读取或写入计费。
 */
export interface CachePolicy {
  /** 在 system 末尾打断点 */
  system?: boolean;
  /** 在最后一个工具定义上打断点 */
  tools?: boolean;
  /** messages 下标，升序。最多两个：上一轮末尾（读）和本轮末尾（写） */
  messageBreakpoints?: number[];
  ttl?: CacheTtl;
  staticTtl?: CacheTtl;
}

export interface ChatRequest {
  model: string;
  system: string;
  /** 有序 system 分段；拼接后必须与 system 相同，不改变权限层级。 */
  systemSegments?: Array<{ text: string; stable: boolean }>;
  messages: Message[];
  tools: ToolDefinition[];
  /** 保留工具定义与历史，仅限制本次响应是否允许产生工具调用。 */
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  thinking?: ThinkingLevel;
  cache?: CachePolicy;
  /** 显式可选；只回放来源匹配且解析对象未改变的原始工具参数。 */
  replayToolArguments?: boolean;
}

export interface ModelCapabilities {
  api: 'chat-completions' | 'messages' | 'generic';
  thinkingLevels?: readonly ThinkingLevel[];
  rawToolArguments?: boolean;
  prefixCompaction?: boolean;
  outputParameter?: 'max_tokens' | 'max_completion_tokens';
  thinkingMode?: 'budget' | 'adaptive';
  offEffort?: 'none';
}

export interface ProviderCapabilities {
  thinking: boolean;
  streaming: boolean;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly routeId?: string;
  modelInfo?(model: string): ModelInfo | undefined;
  modelCapabilities?(model: string): ModelCapabilities | undefined;
  normalizeRequest?(req: ChatRequest): ChatRequest;
  requestBytes?(req: ChatRequest): number;
  /** 适配器可按最终协议估算实际输入及输出预算，尤其是额外 thinking 预留。 */
  estimateRequest?(req: ChatRequest): RequestEstimate;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/** 角色独立于事件用途，planner 不再与主循环用量混在一起。 */
export type ModelRole = 'main' | 'planner' | 'child' | 'judge' | 'compact';
export interface RequestMetrics {
  durationMs: number;
  ttftMs?: number;
  estimatedInputTokens: number;
  inputErrorTokens?: number;
}

/** 规范化请求的 UTF-8 JSON 大小，不冒充 SDK wire 字节或厂商 token 计数。 */
export function requestSize(req: ChatRequest) {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  return {
    normalizedJsonBytes: bytes(req),
    systemBytes: Buffer.byteLength(req.system),
    messagesJsonBytes: bytes(req.messages),
    toolsJsonBytes: bytes(req.tools),
  };
}

export type RequestSize = ReturnType<typeof requestSize>;

/** 记录独立请求快照与实际收到的用量；归一化统计同时覆盖主模型、压缩与审批。 */
export async function* observedStream(
  provider: Provider,
  request: ChatRequest,
  signal: AbortSignal,
  trace: {
    events: EventBus;
    purpose: 'agent' | 'compact' | 'judge';
    modelRole?: ModelRole;
    runId?: string;
    maxRequestBytes?: number;
  },
): AsyncIterable<StreamEvent> {
  const requestId = randomUUID();
  const { request: req, estimate } = prepareModelRequest(provider, request, {
    maxRequestBytes: trace.maxRequestBytes,
  });
  const startedAt = performance.now();
  let ttftMs: number | undefined;
  const reportedUsage: Partial<TokenUsage> = {};
  let usageReported = false;
  const modelRole = trace.modelRole ?? (trace.purpose === 'agent' ? 'main' : trace.purpose);
  const size = requestSize(req);
  trace.events.emit({
    type: 'model_request',
    requestId,
    runId: trace.runId,
    purpose: trace.purpose,
    modelRole,
    size,
    provider: provider.name,
    routeId: provider.routeId ?? provider.name,
    estimate,
    request: structuredClone(req),
  });
  try {
    for await (const event of provider.stream(req, signal)) {
      if (
        ttftMs === undefined &&
        [
          'text_delta',
          'thinking_delta',
          'tool_use_start',
          'tool_use_delta',
          'redacted_thinking',
        ].includes(event.type)
      )
        ttftMs = performance.now() - startedAt;
      if (event.type === 'usage') {
        usageReported = true;
        mergeUsage(reportedUsage, event);
      }
      yield event;
    }
  } finally {
    trace.events.emit({
      type: 'model_usage',
      requestId,
      runId: trace.runId,
      purpose: trace.purpose,
      modelRole,
      usageReported,
      cache: cacheUsage(reportedUsage),
      metrics: {
        durationMs: performance.now() - startedAt,
        ttftMs,
        estimatedInputTokens: estimate.inputTokens,
        inputErrorTokens: cacheUsage(reportedUsage)
          ? cacheUsage(reportedUsage)!.hitTokens +
            cacheUsage(reportedUsage)!.missTokens -
            estimate.inputTokens
          : undefined,
      },
      usage: { ...emptyUsage(), ...reportedUsage },
    });
  }
}

/** 非流式便捷封装：抽干 stream 拼出完整消息（上下文压缩等场景用） */
export async function complete(
  provider: Provider,
  req: ChatRequest,
  signal: AbortSignal,
  trace?: { events: EventBus; purpose: 'compact' | 'judge'; maxRequestBytes?: number },
  limits?: RequestLimits,
): Promise<{ text: string; usage: TokenUsage; stopReason?: StopReason; toolCalls?: number }> {
  let text = '';
  let stopReason: StopReason | undefined;
  let toolCalls = 0;
  const usage = emptyUsage();
  const prepared = prepareModelRequest(provider, req, {
    ...limits,
    maxRequestBytes: trace?.maxRequestBytes ?? limits?.maxRequestBytes,
  }).request;
  const stream = trace
    ? observedStream(provider, prepared, signal, trace)
    : provider.stream(prepared, signal);
  for await (const ev of stream) {
    if (ev.type === 'tool_use_start') toolCalls++;
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'message_stop') stopReason = ev.stopReason;
    if (ev.type === 'usage') mergeUsage(usage, ev);
  }
  return { text, usage, stopReason, ...(toolCalls ? { toolCalls } : {}) };
}
