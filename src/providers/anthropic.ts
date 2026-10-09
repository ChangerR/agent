/**
 * Anthropic Provider —— Messages API adapter。
 *
 * 职责只有一个：规范化协议 <-> Anthropic wire format。
 * 转换函数单独导出，便于脱离网络做单元测试。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { CacheTtl, ChatRequest, Provider } from '../core/provider.js';
import type { Message, StopReason, StreamEvent, ToolDefinition } from '../core/protocol/types.js';

// SDK 根命名空间导出的类型（避免依赖 resources 子路径的具体导出名，跨版本更稳）
type MessageParam = Anthropic.MessageParam;
type AnthropicTool = Anthropic.Tool;
type MessageStreamEvent = Anthropic.MessageStreamEvent;

/** SDK 各版本对 ContentBlockParam 的导出不一致，这里用结构化类型自行构造 */
type ContentBlockParam = MessageParam extends { content: infer C }
  ? C extends Array<infer B>
    ? B
    : never
  : never;

// ---------------------------------------------------------------------------
// 出站：规范化 -> Anthropic
// ---------------------------------------------------------------------------

/** SDK 0.32 稳定版类型没有 cache_control / ttl，线上 Messages API 支持 */
type CacheControl = { type: 'ephemeral'; ttl?: '1h' };

function cacheControlOf(ttl?: CacheTtl): CacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/** thinking / redacted_thinking 不能带 cache_control，从尾部往前找可标记的块 */
const MARKABLE_BLOCK = new Set(['text', 'tool_use', 'tool_result', 'image']);

function markLastCacheable(blocks: Array<Record<string, unknown>>, ttl?: CacheTtl): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const type = blocks[i]?.type;
    if (typeof type === 'string' && MARKABLE_BLOCK.has(type)) {
      blocks[i] = { ...blocks[i], cache_control: cacheControlOf(ttl) };
      return true;
    }
  }
  return false;
}

export function toAnthropicMessages(
  messages: Message[],
  breakpoints?: Set<number>,
  ttl?: CacheTtl,
): MessageParam[] {
  return messages.map((m, index) => {
    const mark = breakpoints?.has(index) ?? false;
    if (m.role === 'assistant') {
      const content = m.content.map((b) => {
        switch (b.type) {
          case 'text':
            return { type: 'text', text: b.text };
          case 'thinking':
            // 有签名才能作为 thinking 块回填；没有签名的（例如 OpenAI reasoning）过不了校验
            if (b.signature) return { type: 'thinking' as const, thinking: b.thinking, signature: b.signature };
            return { type: 'text' as const, text: `<thinking>${b.thinking}</thinking>` };
          case 'redacted_thinking':
            return { type: 'redacted_thinking' as const, data: b.data };
          case 'tool_use':
            return { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input };
        }
      });
      const blocks = content as Array<Record<string, unknown>>;
      if (mark) markLastCacheable(blocks, ttl);
      // 当前 SDK 类型还没有 thinking / redacted_thinking，线上格式本身支持
      return { role: 'assistant' as const, content: blocks as unknown as ContentBlockParam[] };
    }
    // user：字符串也收成 text 块数组，避免打断点时 string/array 来回切换把前缀打散
    const blocks: Array<Record<string, unknown>> =
      typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content.map((b) =>
            b.type === 'tool_result'
              ? { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError }
              : { type: 'text', text: b.text },
          );
    if (mark) markLastCacheable(blocks, ttl);
    return { role: 'user' as const, content: blocks as unknown as ContentBlockParam[] };
  });
}

export function toAnthropicTools(tools: ToolDefinition[], cacheLast = false, ttl?: CacheTtl): AnthropicTool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthropicTool['input_schema'],
    ...(cacheLast && i === tools.length - 1 ? { cache_control: cacheControlOf(ttl) } : {}),
  })) as AnthropicTool[];
}

/** 空 system 保持字符串，不产出空 text 块（会 400） */
export function toAnthropicSystem(
  system: string,
  cache: boolean,
  ttl?: CacheTtl,
): Anthropic.MessageStreamParams['system'] {
  if (!cache || system === '') return system;
  return [{ type: 'text', text: system, cache_control: cacheControlOf(ttl) }] as Anthropic.MessageStreamParams['system'];
}

// ---------------------------------------------------------------------------
// 入站：Anthropic 流事件 -> 规范化 StreamEvent
// ---------------------------------------------------------------------------

export function fromAnthropicEvent(ev: MessageStreamEvent): StreamEvent[] {
  switch (ev.type) {
    case 'message_start': {
      const u = ev.message.usage as Anthropic.Usage & {
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
      return [
        { type: 'message_start' },
        {
          type: 'usage',
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_input_tokens ?? 0,
          cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        },
      ];
    }
    case 'content_block_start': {
      // SDK 0.32 的类型只有 text | tool_use；thinking / redacted_thinking 用结构收
      const block = ev.content_block as { type: string; id?: string; name?: string; data?: string };
      if (block.type === 'tool_use') {
        return [{ type: 'tool_use_start', id: block.id ?? '', name: block.name ?? '' }];
      }
      if (block.type === 'redacted_thinking' && block.data) {
        return [{ type: 'redacted_thinking', data: block.data }];
      }
      return [];
    }
    case 'content_block_delta': {
      // 用宽松结构处理 delta：thinking 在不同 SDK 版本中类型形状有差异
      const delta = ev.delta as {
        type: string;
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
      };
      if (delta.type === 'text_delta') return [{ type: 'text_delta', text: delta.text ?? '' }];
      if (delta.type === 'thinking_delta') return [{ type: 'thinking_delta', text: delta.thinking ?? '' }];
      if (delta.type === 'signature_delta') return [{ type: 'signature_delta', signature: delta.signature ?? '' }];
      if (delta.type === 'input_json_delta') return [{ type: 'tool_use_delta', input: delta.partial_json ?? '' }];
      return [];
    }
    case 'content_block_stop':
      return [{ type: 'tool_use_stop' }];
    case 'message_delta': {
      // 只补输出 token。不要带 inputTokens: 0，否则会把 message_start 的输入计数覆盖掉
      const u = ev.usage as Anthropic.MessageDeltaUsage & {
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      };
      const usage: StreamEvent = {
        type: 'usage',
        outputTokens: u.output_tokens,
        ...(typeof u.cache_read_input_tokens === 'number' ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
        ...(typeof u.cache_creation_input_tokens === 'number' ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
      };
      return [
        {
          type: 'message_stop',
          stopReason: (ev.delta.stop_reason ?? 'end_turn') as StopReason,
        },
        usage,
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 请求参数构造（纯函数，离线可测）
// ---------------------------------------------------------------------------

/** Anthropic extended thinking 的 budget_tokens 映射（必须 ≥1024 且 < max_tokens） */
export const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 32768 } as const;

export function toAnthropicParams(req: ChatRequest): Anthropic.MessageStreamParams {
  return buildAnthropicBody(req).body;
}

/**
 * 组装 Messages API 请求体与额外请求头。
 * cacheControl: false 时忽略 req.cache（兼容端点降级用）。
 * SDK 0.32 稳定版类型没有 cache_control / ttl，body 在返回前整体断言。
 */
export function buildAnthropicBody(
  req: ChatRequest,
  opts?: { cacheControl?: boolean },
): { body: Anthropic.MessageStreamParams; headers: Record<string, string> } {
  const allowCache = opts?.cacheControl !== false && req.cache !== undefined;
  const policy = allowCache ? req.cache : undefined;
  const ttl = policy?.ttl;

  const systemOn = !!(policy?.system && req.system.length > 0);
  const toolsOn = !!(policy?.tools && req.tools.length > 0);
  let breakpoints = [...new Set(policy?.messageBreakpoints ?? [])]
    .filter((i) => i >= 0 && i < req.messages.length)
    .sort((a, b) => a - b);
  const budget = Math.max(0, 4 - (systemOn ? 1 : 0) - (toolsOn ? 1 : 0));
  if (breakpoints.length > budget) breakpoints = breakpoints.slice(breakpoints.length - budget);

  const thinkingOn = req.thinking !== undefined && req.thinking !== 'off';
  const thinkingBudget = thinkingOn ? THINKING_BUDGETS[req.thinking as 'low' | 'medium' | 'high'] : 0;

  const body = {
    model: req.model,
    system: toAnthropicSystem(req.system, systemOn, ttl),
    messages: toAnthropicMessages(req.messages, new Set(breakpoints), ttl),
    tools: req.tools.length > 0 ? toAnthropicTools(req.tools, toolsOn, ttl) : undefined,
    // thinking 开启时 max_tokens 必须大于 budget_tokens
    max_tokens: thinkingOn ? Math.max(req.maxTokens ?? 8192, thinkingBudget + 4096) : (req.maxTokens ?? 8192),
    ...(thinkingOn ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } } : {}),
  } as unknown as Anthropic.MessageStreamParams;

  const wroteCache = ttl === '1h' && JSON.stringify(body).includes('"cache_control"');
  const headers: Record<string, string> = wroteCache
    ? { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' }
    : {};
  return { body, headers };
}

function isCacheControlRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: number }).status !== 400) return false;
  const message = err instanceof Error ? err.message : '';
  return /cache_control|unexpected|unknown field/i.test(message);
}

/** 请求内跟踪块类型；文本/思考结束不是工具调用结束。 */
export class AnthropicStreamTranslator {
  private readonly blocks = new Map<number, { type: string; id?: string }>();
  push(event: MessageStreamEvent): StreamEvent[] {
    if (event.type === 'message_start') this.blocks.clear();
    if (event.type === 'content_block_start') {
      const block = event.content_block as { type: string; id?: string };
      this.blocks.set(event.index, { type: block.type, id: block.id });
    }
    if (event.type === 'content_block_stop') {
      const block = this.blocks.get(event.index); this.blocks.delete(event.index);
      return block?.type === 'tool_use' ? [{ type: 'tool_use_stop', ...(block.id ? { id: block.id } : {}) }] : [];
    }
    return fromAnthropicEvent(event);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly capabilities = { thinking: true, streaming: true };
  private client: Anthropic | null = null;

  /** 兼容端点拒绝 cache_control 之后，本会话不再发送 */
  private cacheDisabled = false;

  constructor(private opts: { apiKey?: string; baseURL?: string; cacheControl?: boolean } = {}) {}

  /** 惰性初始化：缺 API key 只在真正调用时才报错，不影响装配与测试 */
  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
        baseURL: this.opts.baseURL,
      });
    }
    return this.client;
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const allowCache = this.opts.cacheControl !== false && !this.cacheDisabled;
    const { body, headers } = buildAnthropicBody(req, { cacheControl: allowCache });
    const response = this.getClient().messages.stream(body, {
      signal,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    const iter = response[Symbol.asyncIterator]();

    // 只在吐出任何事件之前重试，避免 UI 收到重复文本
    let first: IteratorResult<MessageStreamEvent>;
    try {
      first = await iter.next();
    } catch (err) {
      if (allowCache && isCacheControlRejection(err)) {
        this.cacheDisabled = true;
        yield* this.stream(req, signal);
        return;
      }
      throw err;
    }

    const translator = new AnthropicStreamTranslator();
    if (!first.done) {
      for (const out of translator.push(first.value)) yield out;
    }
    let next = await iter.next();
    while (!next.done) {
      for (const out of translator.push(next.value)) yield out;
      next = await iter.next();
    }
  }
}
