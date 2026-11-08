/** Responses API 的双向翻译；会话由本地管理，不依赖服务端 previous_response_id。 */
import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ChatRequest } from '../core/provider.js';
import { replayArguments, type StreamEvent } from '../core/protocol/types.js';

interface ResponsesOptions {
  routeId: string;
  offEffort?: 'none';
}

/** SDK v4 尚未声明新模型返回的缓存写入字段。 */
interface ResponseCacheUsage {
  cached_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_write_tokens_details?: {
    ttl_30m_tokens?: number;
    ttl_12h_tokens?: number;
  } | null;
}

/** 加密思考只在同一端点、协议和模型之间回传；不解释其中的模型状态。 */
function reasoningItem(data: string): ResponseReasoningItem {
  const item = JSON.parse(data) as ResponseReasoningItem;
  if (
    item?.type !== 'reasoning' ||
    typeof item.id !== 'string' ||
    typeof item.encrypted_content !== 'string' ||
    !Array.isArray(item.summary) ||
    item.summary.some((part) => part.type !== 'summary_text' || typeof part.text !== 'string')
  )
    throw new Error('invalid_responses_reasoning');
  return {
    type: 'reasoning',
    id: item.id,
    summary: item.summary.map((part) => ({ type: 'summary_text', text: part.text })),
    encrypted_content: item.encrypted_content,
  };
}

export function toResponsesParams(
  req: ChatRequest,
  options: ResponsesOptions,
): ResponseCreateParamsStreaming {
  const input: ResponseInputItem[] = [];
  for (const message of req.messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        input.push({ role: 'user', content: message.content });
      } else {
        for (const block of message.content) {
          input.push(
            block.type === 'tool_result'
              ? {
                  type: 'function_call_output',
                  call_id: block.toolUseId,
                  output: block.isError ? `Error: ${block.content}` : block.content,
                }
              : { role: 'user', content: block.text },
          );
        }
      }
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        input.push({ role: 'assistant', content: block.text });
      } else if (block.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: req.replayToolArguments
            ? replayArguments(block, options.routeId, req.model)
            : JSON.stringify(block.input),
        });
      } else if (
        block.type === 'redacted_thinking' &&
        block.source?.routeId === options.routeId &&
        block.source.model === req.model
      ) {
        input.push(reasoningItem(block.data));
      }
      // 展示用思考摘要不是可回放的 reasoning item；其他厂商的签名也不跨协议发送。
    }
  }
  const effort = req.thinking === 'off' ? options.offEffort : req.thinking;
  return {
    model: req.model,
    instructions: req.system,
    input,
    tools: req.tools.length
      ? req.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          strict: false,
        }))
      : undefined,
    ...(req.toolChoice ? { tool_choice: req.toolChoice } : {}),
    max_output_tokens: req.maxTokens,
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(effort
      ? {
          // SDK v4 的枚举缺少较新模型支持的 none；只在能力显式声明时发送。
          reasoning: {
            effort,
            ...(effort === 'none' ? {} : { summary: 'auto' }),
          } as ResponseCreateParamsStreaming['reasoning'],
        }
      : {}),
  };
}

/** output item ID 只用于关联增量；工具执行和结果回填必须使用 call_id。 */
export class ResponsesStreamTranslator {
  private tools = new Map<string, { id: string; arguments: string; stopped: boolean }>();
  private terminal = false;

  constructor(private source: { routeId: string; model: string }) {}

  private finishTool(itemId: string, args: string): StreamEvent[] {
    const tool = this.tools.get(itemId);
    if (!tool) throw new Error('unknown_responses_tool');
    if (tool.stopped) {
      if (tool.arguments !== args) throw new Error('inconsistent_responses_arguments');
      return [];
    }
    if (!args.startsWith(tool.arguments)) throw new Error('inconsistent_responses_arguments');
    const rest = args.slice(tool.arguments.length);
    tool.arguments = args;
    tool.stopped = true;
    return [
      ...(rest ? [{ type: 'tool_use_delta' as const, id: tool.id, input: rest }] : []),
      { type: 'tool_use_stop', id: tool.id },
    ];
  }

  translate(event: ResponseStreamEvent): StreamEvent[] {
    if (this.terminal) throw new Error('responses_event_after_stop');
    switch (event.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        return [{ type: 'text_delta', text: event.delta }];
      case 'response.reasoning_summary_text.delta':
        return [{ type: 'thinking_delta', text: event.delta }];
      case 'response.output_item.added': {
        const item = event.item;
        if (item.type !== 'function_call') return [];
        if (!item.id || !item.call_id || !item.name || this.tools.has(item.id))
          throw new Error('invalid_responses_tool');
        this.tools.set(item.id, { id: item.call_id, arguments: item.arguments, stopped: false });
        return [
          { type: 'tool_use_start', id: item.call_id, name: item.name },
          ...(item.arguments
            ? [{ type: 'tool_use_delta' as const, id: item.call_id, input: item.arguments }]
            : []),
        ];
      }
      case 'response.function_call_arguments.delta': {
        const tool = this.tools.get(event.item_id);
        if (!tool || tool.stopped) throw new Error('unknown_responses_tool');
        tool.arguments += event.delta;
        return [{ type: 'tool_use_delta', id: tool.id, input: event.delta }];
      }
      case 'response.function_call_arguments.done':
        return this.finishTool(event.item_id, event.arguments);
      case 'response.output_item.done': {
        const item = event.item;
        if (item.type === 'function_call') {
          if (!item.id) throw new Error('invalid_responses_tool');
          return this.finishTool(item.id, item.arguments);
        }
        if (item.type === 'reasoning' && item.encrypted_content) {
          return [{ type: 'redacted_thinking', data: JSON.stringify(item), source: this.source }];
        }
        return [];
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = event.response;
        if (
          event.type === 'response.incomplete' &&
          response.incomplete_details?.reason !== 'max_output_tokens'
        )
          throw new Error('responses_incomplete');
        if ([...this.tools.values()].some((tool) => !tool.stopped))
          throw new Error('responses_unfinished_tool');
        this.terminal = true;
        const usage = response.usage;
        const details = usage?.input_tokens_details as ResponseCacheUsage | undefined;
        const cached = details?.cached_tokens ?? undefined;
        const written = details?.cache_write_tokens ?? undefined;
        const writes = details?.cache_write_tokens_details;
        return [
          ...(usage
            ? [
                {
                  type: 'usage' as const,
                  // 总输入已包含缓存读写，归一化后每个 token 只计一次。
                  inputTokens: Math.max(0, usage.input_tokens - (cached ?? 0) - (written ?? 0)),
                  outputTokens: usage.output_tokens,
                  ...(cached === undefined ? {} : { cacheReadTokens: cached }),
                  ...(written !== undefined
                    ? { cacheWriteTokens: written }
                    : !/^gpt-(?:5\.[6-9]|6)/.test(this.source.model)
                      ? { cacheWriteTokens: 0 }
                      : {}),
                  ...(writes
                    ? {
                        cacheWriteTokensByTtl: {
                          ...(typeof writes.ttl_30m_tokens === 'number'
                            ? { '30m': writes.ttl_30m_tokens }
                            : {}),
                          ...(typeof writes.ttl_12h_tokens === 'number'
                            ? { '12h': writes.ttl_12h_tokens }
                            : {}),
                        },
                      }
                    : {}),
                },
              ]
            : []),
          {
            type: 'message_stop',
            stopReason:
              event.type === 'response.incomplete'
                ? 'max_tokens'
                : this.tools.size
                  ? 'tool_use'
                  : 'end_turn',
          },
        ];
      }
      case 'response.failed':
        throw new Error('responses_failed');
      case 'error':
        // 错误正文可能含请求数据，不把上游原文直接带到 UI。
        throw new Error('responses_stream_error');
      default:
        return [];
    }
  }

  finish(): void {
    if (!this.terminal) throw new Error('responses_stream_interrupted');
  }
}
