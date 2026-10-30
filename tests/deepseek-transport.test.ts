/** 真实 SDK 构造请求和解析 SSE；fetch 仅返回内存夹具，不存在真实网络回退。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({
  bodies: [] as Record<string, unknown>[],
  fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
    transport.bodies.push(JSON.parse(String(init?.body)));
    const chunk = {
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        total_tokens: 1020,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }),
}));
import 'openai/shims/web';
vi.mock('openai', async (load) => {
  const sdk = await load<typeof import('openai')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ConstructorParameters<typeof sdk.default>[0]) {
        super({ ...options, maxRetries: 0, fetch: transport.fetch });
      }
    },
  };
});
import { OpenAIProvider, resolveOpenAIDialect, toOpenAIParams } from '../src/providers/openai.js';
import { collectStreamAsync, toolInputHash, type Message } from '../src/core/protocol/types.js';
import type { ChatRequest, ThinkingLevel } from '../src/core/provider.js';

afterEach(() => {
  transport.bodies.length = 0;
  transport.fetch.mockClear();
});
const messages: Message[] = [
  { role: 'user', content: 'read' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'tool reasoning' },
      { type: 'tool_use', id: 't', name: 'read_file', input: { path: 'a' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'result' }] },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'answer reasoning' },
      { type: 'text', text: 'done' },
    ],
  },
  { role: 'user', content: 'next' },
];
const request = (thinking?: ThinkingLevel): ChatRequest => ({
  model: 'deepseek-flash',
  system: 'stable',
  messages,
  tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
  thinking,
});

describe('DeepSeek 能力隔离与真实传输', () => {
  it.each([
    'https://api.kimi.com/v1',
    'https://api.kimi.ai/v1',
    'https://api.moonshot.cn/v1',
    'https://api.moonshot.ai/v1',
  ])('Kimi 官方端点 %s 使用 K3 参数并按要求回放推理', async (baseURL) => {
    const provider = new OpenAIProvider({ apiKey: 'offline-never-sent', baseURL });
    const model = 'k3.1-pro-highspeed';
    const rawArguments = '{\n  "path": "a"\n}';
    const replayMessages: Message[] = [
      { role: 'user', content: 'read' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'tool reasoning' },
          {
            type: 'tool_use',
            id: 't',
            name: 'read_file',
            input: { path: 'a' },
            replay: {
              arguments: rawArguments,
              inputHash: toolInputHash({ path: 'a' }),
              routeId: provider.routeId,
              model,
            },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'result' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'answer reasoning' },
          { type: 'text', text: 'done' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: 'result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'plain answer' }] },
      { role: 'user', content: 'next' },
    ];
    await collectStreamAsync(
      provider.stream(
        {
          ...request('high'),
          model,
          messages: replayMessages,
          replayToolArguments: true,
          maxTokens: 8192,
        },
        new AbortController().signal,
      ),
    );
    const body = transport.bodies[0];
    expect(body.max_completion_tokens).toBe(8192);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('thinking');
    expect(body.reasoning_effort).toBe('high');
    const turns = (body.messages as Record<string, unknown>[]).filter(
      (m) => m.role === 'assistant',
    );
    expect(turns.map((m) => m.reasoning_content)).toEqual([
      'tool reasoning',
      'answer reasoning',
      '',
      undefined,
    ]);
    expect(turns[2]).toHaveProperty('reasoning_content', '');
    expect(turns[3]).not.toHaveProperty('reasoning_content');
    const toolCalls = turns[0].tool_calls as { function: { arguments: string } }[];
    expect(toolCalls[0].function.arguments).toBe(rawArguments);
    expect(transport.fetch).toHaveBeenCalledTimes(1);

    expect(resolveOpenAIDialect(baseURL)).toBe('kimi');
    expect(resolveOpenAIDialect(baseURL, 'generic')).toBe('generic');
    expect(resolveOpenAIDialect('https://proxy.invalid/v1', 'kimi')).toBe('kimi');
    for (const name of ['k3', 'k3.1-pro', 'k3.1-pro-highspeed', 'kimi-k3.1-pro']) {
      expect(provider.modelCapabilities(name)).toEqual({
        api: 'chat-completions',
        thinkingLevels: ['low', 'high'],
        rawToolArguments: true,
        outputParameter: 'max_completion_tokens',
      });
    }
    expect(() => provider.normalizeRequest({ ...request('off'), model })).toThrow(
      /unsupported_thinking_level/,
    );
    const hostname = new URL(baseURL).hostname;
    expect(resolveOpenAIDialect(`https://${hostname}.attacker.test/v1`)).toBe('generic');
    expect(resolveOpenAIDialect(baseURL.replace('https://', 'http://'))).toBe('generic');
  });
  it.each(['low', 'medium', 'high', 'off'] as const)(
    'thinking=%s 回传工具轮和纯回答轮，最后内容 chunk 用量不漏计',
    async (thinking) => {
      const provider = new OpenAIProvider({
        apiKey: 'offline-never-sent',
        baseURL: 'https://api.deepseek.com',
      });
      const result = await collectStreamAsync(
        provider.stream(request(thinking), new AbortController().signal),
      );
      const body = transport.bodies[0];
      const turns = (body.messages as Record<string, unknown>[]).filter(
        (m) => m.role === 'assistant',
      );
      expect(turns.map((m) => m.reasoning_content)).toEqual(['tool reasoning', 'answer reasoning']);
      expect(body.thinking).toEqual({ type: thinking === 'off' ? 'disabled' : 'enabled' });
      expect(body.reasoning_effort).toBe(
        thinking === 'off' ? undefined : thinking === 'low' ? 'low' : 'high',
      );
      expect(result.usage).toEqual({
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      });
      expect(transport.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('无 tools 时不回传无效推理，限制调用时仍保留 tools 和推理', () => {
    const bare = toOpenAIParams({ ...request('high'), tools: [] }, 'deepseek');
    expect(bare.tools).toBeUndefined();
    expect(JSON.stringify(bare.messages)).not.toContain('reasoning_content');
    const reporting = toOpenAIParams({ ...request('high'), toolChoice: 'none' }, 'deepseek');
    expect(reporting.tools).toHaveLength(1);
    expect(reporting.tool_choice).toBe('none');
    expect(JSON.stringify(reporting.messages)).toContain('answer reasoning');
  });

  it.each([
    'https://proxy.invalid/v1',
    'https://api.deepseek.com.attacker.invalid',
    'http://api.deepseek.com',
  ])('通用端点 %s 不根据模型名注入 DeepSeek 字段', async (baseURL) => {
    const provider = new OpenAIProvider({ apiKey: 'offline-never-sent', baseURL });
    await collectStreamAsync(provider.stream(request('off'), new AbortController().signal));
    expect(transport.bodies[0]).not.toHaveProperty('thinking');
    expect(transport.bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(JSON.stringify(transport.bodies[0])).not.toContain('reasoning_content');
    expect(toOpenAIParams(request('medium')).reasoning_effort).toBe('medium');
  });

  it('代理可显式声明，官方端点也可显式选择通用协议', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'offline-never-sent',
      baseURL: 'https://proxy.invalid',
      dialect: 'deepseek',
    });
    await collectStreamAsync(provider.stream(request('off'), new AbortController().signal));
    expect(transport.bodies[0].thinking).toEqual({ type: 'disabled' });
    expect(resolveOpenAIDialect('https://api.deepseek.com/v1', 'generic')).toBe('generic');
    expect(resolveOpenAIDialect('https://api.deepseek.com/v1')).toBe('deepseek');
    expect(resolveOpenAIDialect('invalid')).toBe('generic');
  });
});
