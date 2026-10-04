/**
 * OpenAI 兼容 Provider —— chat completions adapter。
 *
 * 兼容所有讲 OpenAI 协议的厂商（OpenAI / DeepSeek / Kimi / 通义 / 本地 vLLM…）。
 * 与 Anthropic adapter 对照阅读，可以清楚看到两家协议的关键差异：
 * - 工具结果是独立的 role:'tool' 消息，而不是 user 消息的 content block
 * - 流式 tool_calls 按 index 增量下发，需要自己拼装 id/name/arguments
 */
import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ChatRequest, Provider } from '../core/provider.js';
import type { Message, StreamEvent, ToolDefinition } from '../core/protocol/types.js';

// ---------------------------------------------------------------------------
// 出站：规范化 -> OpenAI
// ---------------------------------------------------------------------------

export function toOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      // 把 tool_result 拆成独立的 tool 消息，文本块合成一条 user 消息
      const texts: string[] = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: b.isError ? `Error: ${b.content}` : b.content,
          });
        } else {
          texts.push(b.text);
        }
      }
      if (texts.length > 0) out.push({ role: 'user', content: texts.join('\n') });
      continue;
    }
    // assistant：只回传正文。thinking 不并进 content，避免前缀随推理文本抖动
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls = m.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }
  return out;
}

export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

// ---------------------------------------------------------------------------
// 入站：OpenAI chunk -> 规范化 StreamEvent（有状态：跟踪进行中的 tool_call）
// ---------------------------------------------------------------------------

export class OpenAIStreamTranslator {
  private openToolIndex = new Map<number, boolean>();
  private sawToolCalls = false;

  translate(chunk: ChatCompletionChunk): StreamEvent[] {
    const out: StreamEvent[] = [];
    const choice = chunk.choices[0];

    if (chunk.usage) {
      // prompt_tokens 含缓存命中；DeepSeek 用 prompt_cache_hit_tokens，不在 SDK 类型里
      const u = chunk.usage as typeof chunk.usage & {
        prompt_cache_hit_tokens?: number;
      };
      const cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      out.push({
        type: 'usage',
        inputTokens: Math.max(0, u.prompt_tokens - cacheRead),
        outputTokens: u.completion_tokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: 0,
      });
    }
    if (!choice) return out;

    const delta = choice.delta as {
      content?: string | null;
      /** DeepSeek/Qwen 等思考模型的推理内容字段 */
      reasoning_content?: string | null;
      tool_calls?: ChatCompletionChunk.Choice.Delta.ToolCall[];
    };
    if (delta.reasoning_content) out.push({ type: 'thinking_delta', text: delta.reasoning_content });
    if (delta.content) out.push({ type: 'text_delta', text: delta.content });

    for (const tc of delta.tool_calls ?? []) {
      this.sawToolCalls = true;
      if (!this.openToolIndex.has(tc.index)) {
        // 新 tool_call 开始：首个分片带 id 和 name
        out.push({
          type: 'tool_use_start',
          id: tc.id ?? `call_${tc.index}`,
          name: tc.function?.name ?? 'unknown',
        });
        this.openToolIndex.set(tc.index, true);
        if (tc.function?.arguments) out.push({ type: 'tool_use_delta', input: tc.function.arguments });
      } else if (tc.function?.arguments) {
        out.push({ type: 'tool_use_delta', input: tc.function.arguments });
      }
    }

    if (choice.finish_reason) {
      for (const idx of this.openToolIndex.keys()) {
        out.push({ type: 'tool_use_stop' });
        this.openToolIndex.delete(idx);
      }
      out.push({
        type: 'message_stop',
        stopReason:
          choice.finish_reason === 'tool_calls'
            ? 'tool_use'
            : choice.finish_reason === 'length'
              ? 'max_tokens'
              : choice.finish_reason === 'stop'
                ? 'end_turn'
                : 'end_turn',
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 请求参数构造（纯函数，离线可测）
// ---------------------------------------------------------------------------

/**
 * thinking 映射：OpenAI 系的 reasoning_effort（o 系列 / gpt-5 / DeepSeek 思考模型）。
 * off 或不支持时不传该参数。
 */
export function toOpenAIParams(req: ChatRequest): OpenAI.ChatCompletionCreateParamsStreaming {
  return {
    model: req.model,
    messages: [{ role: 'system', content: req.system }, ...toOpenAIMessages(req.messages)],
    tools: req.tools.length > 0 ? toOpenAITools(req.tools) : undefined,
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // req.cache 只服务 Anthropic 的显式断点。这里靠前缀不变触发服务端自动缓存，不写任何标记。
    ...(req.thinking && req.thinking !== 'off'
      ? { reasoning_effort: req.thinking as 'low' | 'medium' | 'high' }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements Provider {
  readonly name = 'openai';
  readonly capabilities = { thinking: true, streaming: true };
  private client: OpenAI | null = null;

  constructor(private opts: { apiKey?: string; baseURL?: string } = {}) {}

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: this.opts.apiKey ?? process.env.OPENAI_API_KEY ?? 'EMPTY',
        baseURL: this.opts.baseURL ?? process.env.OPENAI_BASE_URL,
      });
    }
    return this.client;
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const stream = await this.getClient().chat.completions.create(toOpenAIParams(req), { signal });
    yield { type: 'message_start' };
    const translator = new OpenAIStreamTranslator();
    for await (const chunk of stream) {
      for (const ev of translator.translate(chunk)) yield ev;
    }
  }
}
