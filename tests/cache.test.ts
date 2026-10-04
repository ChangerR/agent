/**
 * 提示缓存：断点落位、前缀稳定、用量合并。全部离线。
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../src/core/provider.js';
import {
  collectStreamAsync,
  emptyUsage,
  mergeUsage,
  type Message,
  type ToolDefinition,
} from '../src/core/protocol/types.js';
import { buildAnthropicBody, fromAnthropicEvent } from '../src/providers/anthropic.js';
import { OpenAIStreamTranslator, toOpenAIMessages } from '../src/providers/openai.js';

const tools: ToolDefinition[] = [
  { name: 'read_file', description: 'read', inputSchema: { type: 'object' } },
  { name: 'grep', description: 'grep', inputSchema: { type: 'object' } },
  { name: 'bash', description: 'bash', inputSchema: { type: 'object' } },
];

function req(partial: Partial<ChatRequest> & Pick<ChatRequest, 'messages'>): ChatRequest {
  return {
    model: 'claude-sonnet-4-5',
    system: 'sys',
    tools,
    ...partial,
  };
}

function countCacheControl(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((n, v) => n + countCacheControl(v), 0);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).reduce(
      (n, [k, v]) => n + (k === 'cache_control' ? 1 : 0) + countCacheControl(k === 'cache_control' ? undefined : v),
      0,
    );
  }
  return 0;
}

function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'cache_control') continue;
      out[k] = stripCacheControl(v);
    }
    return out;
  }
  return value;
}

describe('Anthropic 缓存断点', () => {
  it('没有 cache 策略时不写入 cache_control，system 保持字符串', () => {
    const { body, headers } = buildAnthropicBody(
      req({ messages: [{ role: 'user', content: 'hi' }], cache: undefined }),
    );
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body.system).toBe('sys');
    expect(headers).toEqual({});
    expect(body.messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('断点落在 system、最后一个工具、指定消息的最后一个可标记块', () => {
    const messages: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'c' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'd' },
          { type: 'tool_use', id: 't2', name: 'bash', input: {} },
        ],
      },
    ];
    const { body } = buildAnthropicBody(
      req({
        messages,
        cache: { system: true, tools: true, messageBreakpoints: [1, 3] },
      }),
    );
    const system = body.system as Array<{ cache_control?: unknown }>;
    const wireTools = body.tools as Array<{ cache_control?: unknown }>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(wireTools[2].cache_control).toEqual({ type: 'ephemeral' });
    expect(wireTools[0].cache_control).toBeUndefined();
    expect(wireTools[1].cache_control).toBeUndefined();

    const m1 = body.messages[1].content as Array<{ cache_control?: unknown }>;
    const m3 = body.messages[3].content as Array<{ type: string; cache_control?: unknown }>;
    expect(m1.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(m3.at(-1)).toMatchObject({ type: 'tool_use', cache_control: { type: 'ephemeral' } });
    expect(m3[0].cache_control).toBeUndefined();
    expect(countCacheControl(body)).toBe(4);
  });

  it('断点落在只有 thinking 的消息上时跳过', () => {
    const { body } = buildAnthropicBody(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: '先想', signature: 'sig' },
              { type: 'redacted_thinking', data: 'opaque' },
            ],
          },
        ],
        cache: { system: true, tools: true, messageBreakpoints: [0] },
      }),
    );
    expect(countCacheControl(body)).toBe(2);
    expect(JSON.stringify(body.messages)).not.toContain('cache_control');
  });

  it('后一轮去掉 cache_control 后，前缀与前一轮相同', () => {
    const head: Message[] = [
      { role: 'user', content: '读文件' },
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'data' }] },
    ];
    const longer: Message[] = [
      ...head,
      { role: 'assistant', content: [{ type: 'text', text: '继续' }] },
      { role: 'user', content: '再看一眼' },
    ];
    const first = buildAnthropicBody(req({ messages: head, cache: { system: true, tools: true, messageBreakpoints: [2] } }));
    const second = buildAnthropicBody(
      req({ messages: longer, cache: { system: true, tools: true, messageBreakpoints: [2, 4] } }),
    );
    expect((stripCacheControl(second.body.messages) as unknown[]).slice(0, 3)).toEqual(
      stripCacheControl(first.body.messages),
    );
    expect(stripCacheControl(first.body.system)).toEqual(stripCacheControl(second.body.system));
    expect(stripCacheControl(first.body.tools)).toEqual(stripCacheControl(second.body.tools));
  });

  it('1 小时 ttl 写入断点和 beta 头，5 分钟不写', () => {
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    const hour = buildAnthropicBody(req({ messages, cache: { system: true, tools: false, messageBreakpoints: [0], ttl: '1h' } }));
    expect(JSON.stringify(hour.body)).toContain('"ttl":"1h"');
    expect(hour.headers['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');

    const five = buildAnthropicBody(req({ messages, cache: { system: true, tools: false, messageBreakpoints: [0], ttl: '5m' } }));
    expect(JSON.stringify(five.body)).not.toContain('"ttl"');
    expect(five.headers).toEqual({});
  });
});

describe('用量合并', () => {
  it('message_start 读出缓存计数，message_delta 不带 inputTokens', () => {
    const start = fromAnthropicEvent({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 120,
        },
      },
    } as never);
    expect(start.find((e) => e.type === 'usage')).toMatchObject({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 900,
      cacheWriteTokens: 120,
    });

    const delta = fromAnthropicEvent({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    } as never);
    const usage = delta.find((e) => e.type === 'usage');
    expect(usage).not.toHaveProperty('inputTokens');
    expect(usage).toMatchObject({ type: 'usage', outputTokens: 3 });
  });

  it('后到的 usage 片段不会把已有 inputTokens 冲成 0', async () => {
    const usage = emptyUsage();
    mergeUsage(usage, { inputTokens: 100, cacheReadTokens: 900 });
    mergeUsage(usage, { outputTokens: 50 });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });

    const collected = await collectStreamAsync(
      (async function* () {
        yield { type: 'message_start' as const };
        yield { type: 'usage' as const, inputTokens: 100, cacheReadTokens: 900 };
        yield { type: 'text_delta' as const, text: 'ok' };
        yield { type: 'usage' as const, outputTokens: 50 };
        yield { type: 'message_stop' as const, stopReason: 'end_turn' as const };
      })(),
    );
    expect(collected.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
  });

  it('OpenAI cached_tokens 与 DeepSeek prompt_cache_hit_tokens 都算作读取', () => {
    const openai = new OpenAIStreamTranslator();
    expect(
      openai.translate({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
      } as never),
    ).toContainEqual({
      type: 'usage',
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });

    const deepseek = new OpenAIStreamTranslator();
    expect(
      deepseek.translate({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 800 },
      } as never),
    ).toContainEqual({
      type: 'usage',
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
  });

  it('OpenAI 回传不带 tool_calls.index，thinking 不进 content', () => {
    const out = toOpenAIMessages([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } },
        ],
      },
    ]);
    const call = (out[0] as unknown as { tool_calls: Array<Record<string, unknown>>; content: string }).tool_calls[0];
    expect(call).not.toHaveProperty('index');
    expect(out[0]).toMatchObject({ content: 'hi' });
    expect(JSON.stringify(out[0])).not.toContain('secret');
  });
});
