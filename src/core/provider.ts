/**
 * Provider 插件接口。
 *
 * Provider 的唯一职责：给定规范化请求，产出规范化流式事件。
 * 厂商 SDK 的所有细节都被关在各自的 adapter 里。
 */
import type { Message, StreamEvent, ToolDefinition, StopReason } from './protocol/types.js';
import { emptyUsage, mergeUsage, type TokenUsage } from './protocol/types.js';
import { randomUUID } from 'node:crypto';
import type { EventBus } from './events.js';

/** 思考等级：off 关闭；low/medium/high 由各 provider 映射到自己的 API 参数 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Anthropic prompt cache 的存活时间。5 分钟不传 ttl 字段；1 小时要带 beta 头 */
export type CacheTtl = '5m' | '1h';

/**
 * 这一次请求要在哪些稳定前缀上打断点。
 * 断点语义放在协议层，wire 格式（cache_control）只由 Anthropic adapter 翻译。
 * 不传 cache 的调用（压缩、审批）不会付写入缓存的费用。
 */
export interface CachePolicy {
  /** 在 system 末尾打断点 */
  system?: boolean;
  /** 在最后一个工具定义上打断点 */
  tools?: boolean;
  /** messages 下标，升序。最多两个：上一轮末尾（读）和本轮末尾（写） */
  messageBreakpoints?: number[];
  ttl?: CacheTtl;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  maxTokens?: number;
  thinking?: ThinkingLevel;
  cache?: CachePolicy;
}

export interface ProviderCapabilities {
  thinking: boolean;
  streaming: boolean;
}

export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

/** 记录独立请求快照与实际收到的用量；归一化统计同时覆盖主模型、压缩与审批。 */
export async function* observedStream(
  provider: Provider, req: ChatRequest, signal: AbortSignal,
  trace: { events: EventBus; purpose: 'agent' | 'compact' | 'judge' },
): AsyncIterable<StreamEvent> {
  const requestId = randomUUID();
  const usage = emptyUsage();
  trace.events.emit({ type: 'model_request', requestId, purpose: trace.purpose, provider: provider.name, request: structuredClone(req) });
  try {
    for await (const event of provider.stream(req, signal)) {
      if (event.type === 'usage') mergeUsage(usage, event);
      yield event;
    }
  } finally {
    trace.events.emit({ type: 'model_usage', requestId, purpose: trace.purpose, usage });
  }
}

/** 非流式便捷封装：抽干 stream 拼出完整消息（上下文压缩等场景用） */
export async function complete(
  provider: Provider,
  req: ChatRequest,
  signal: AbortSignal,
  trace?: { events: EventBus; purpose: 'compact' | 'judge' },
): Promise<{ text: string; usage: TokenUsage; stopReason?: StopReason }> {
  let text = '';
  let stopReason: StopReason | undefined;
  const usage = emptyUsage();
  const stream = trace ? observedStream(provider, req, signal, trace) : provider.stream(req, signal);
  for await (const ev of stream) {
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'message_stop') stopReason = ev.stopReason;
    if (ev.type === 'usage') mergeUsage(usage, ev);
  }
  return { text, usage, stopReason };
}
