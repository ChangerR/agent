/**
 * OpenAI 兼容 Provider —— chat completions adapter。
 *
 * 兼容所有讲 OpenAI 协议的厂商（OpenAI / DeepSeek / Kimi / 通义 / 本地 vLLM…）。
 * 与 Anthropic adapter 对照阅读，可以清楚看到两家协议的关键差异：
 * - 工具结果是独立的 role:'tool' 消息，而不是 user 消息的 content block
 * - 流式 tool_calls 按 index 增量下发，需要自己拼装 id/name/arguments
 */
import OpenAI from 'openai';
import { resolveApiKey, type ApiKeyOptions } from './api-key.js';
import { estimateTextTokens } from '../core/context/tokens.js';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ChatRequest, Provider } from '../core/provider.js';
import type { Message, StreamEvent, ToolDefinition } from '../core/protocol/types.js';

export type OpenAIDialect = 'generic' | 'deepseek';
export type OpenAIDialectSetting = OpenAIDialect | 'auto';

/** 只自动识别官方端点；代理须显式声明，不能从模型名猜测厂商。 */
export function resolveOpenAIDialect(
  baseURL: string | undefined,
  setting: OpenAIDialectSetting = 'auto',
): OpenAIDialect {
  if (setting !== 'auto') return setting;
  if (!baseURL) return 'generic';
  try {
    const url = new URL(baseURL);
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com'
      ? 'deepseek'
      : 'generic';
  } catch {
    return 'generic';
  }
}

// ---------------------------------------------------------------------------
// 出站：规范化 -> OpenAI
// ---------------------------------------------------------------------------

export function toOpenAIMessages(
  messages: Message[],
  reasoningHistory = false,
): ChatCompletionMessageParam[] {
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
    // 推理与正文分离；DeepSeek 携带 tools 时回传所有轮次的原始推理。
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
      ...(reasoningHistory
        ? {
            reasoning_content: m.content
              .filter((b) => b.type === 'thinking')
              .map((b) => b.thinking)
              .join(''),
          }
        : {}),
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
  private openToolIndex = new Map<number, string>();

  translate(chunk: ChatCompletionChunk): StreamEvent[] {
    const out: StreamEvent[] = [];
    const choice = chunk.choices[0];

    if (chunk.usage) {
      // prompt_tokens 含缓存命中；DeepSeek 用 prompt_cache_hit_tokens，不在 SDK 类型里
      const u = chunk.usage as typeof chunk.usage & {
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
      const cacheRead =
        u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? undefined;
      out.push({
        type: 'usage',
        inputTokens: u.prompt_cache_miss_tokens ?? Math.max(0, u.prompt_tokens - (cacheRead ?? 0)),
        outputTokens: u.completion_tokens,
        ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
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
    if (delta.reasoning_content)
      out.push({ type: 'thinking_delta', text: delta.reasoning_content });
    if (delta.content) out.push({ type: 'text_delta', text: delta.content });

    for (const tc of delta.tool_calls ?? []) {
      if (!this.openToolIndex.has(tc.index)) {
        // 新 tool_call 开始：首个分片带 id 和 name
        out.push({
          type: 'tool_use_start',
          id: tc.id ?? `call_${tc.index}`,
          name: tc.function?.name ?? 'unknown',
        });
        this.openToolIndex.set(tc.index, tc.id ?? `call_${tc.index}`);
        if (tc.function?.arguments)
          out.push({
            type: 'tool_use_delta',
            id: this.openToolIndex.get(tc.index)!,
            input: tc.function.arguments,
          });
      } else if (tc.function?.arguments) {
        out.push({
          type: 'tool_use_delta',
          id: this.openToolIndex.get(tc.index)!,
          input: tc.function.arguments,
        });
      }
    }

    if (choice.finish_reason) {
      for (const idx of this.openToolIndex.keys()) {
        out.push({ type: 'tool_use_stop', id: this.openToolIndex.get(idx)! });
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
 * DeepSeek 显式映射开关与历史；通用兼容接口保留既有参数行为。
 */
export function toOpenAIParams(
  req: ChatRequest,
  dialect: OpenAIDialect = 'generic',
): OpenAI.ChatCompletionCreateParamsStreaming {
  return {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      ...toOpenAIMessages(req.messages, dialect === 'deepseek' && req.tools.length > 0),
    ],
    tools: req.tools.length > 0 ? toOpenAITools(req.tools) : undefined,
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // req.cache 只服务 Anthropic 的显式断点。这里靠前缀不变触发服务端自动缓存，不写任何标记。
    ...(dialect === 'deepseek' && req.thinking !== undefined
      ? {
          thinking: { type: req.thinking === 'off' ? 'disabled' : 'enabled' },
          ...(req.thinking === 'off'
            ? {}
            : { reasoning_effort: req.thinking === 'low' ? ('low' as const) : ('high' as const) }),
        }
      : req.thinking && req.thinking !== 'off'
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

  constructor(
    private opts: ApiKeyOptions & { baseURL?: string; dialect?: OpenAIDialectSetting } = {},
  ) {}

  estimateRequest(req: ChatRequest) {
    const dialect = resolveOpenAIDialect(
      this.opts.baseURL ?? process.env.OPENAI_BASE_URL,
      this.opts.dialect,
    );
    const body = toOpenAIParams(req, dialect);
    const inputTokens =
      estimateTextTokens(JSON.stringify({ messages: body.messages, tools: body.tools })) + 32;
    const outputTokens = body.max_tokens ?? 0;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: resolveApiKey(this.opts, 'OPENAI_API_KEY') ?? 'EMPTY',
        baseURL: this.opts.baseURL ?? process.env.OPENAI_BASE_URL,
      });
    }
    return this.client;
  }

  async *stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent> {
    const client = this.getClient();
    const dialect = resolveOpenAIDialect(client.baseURL, this.opts.dialect);
    const stream = await client.chat.completions.create(toOpenAIParams(req, dialect), { signal });
    yield { type: 'message_start' };
    const translator = new OpenAIStreamTranslator();
    for await (const chunk of stream) {
      for (const ev of translator.translate(chunk)) yield ev;
    }
  }
}
