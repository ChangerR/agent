/** 真实 SDK + 内存 SSE；固定假 key，所有请求只能进入 mock fetch。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const wire = vi.hoisted(() => ({
  batches: [] as Array<Array<Record<string, unknown>>>,
  bodies: [] as Record<string, any>[],
  urls: [] as string[],
  fetch: vi.fn(async (url: unknown, init?: RequestInit) => {
    wire.urls.push(String(url));
    wire.bodies.push(JSON.parse(String(init?.body)));
    const batch = wire.batches.shift();
    if (!batch) throw new Error('missing_offline_fixture');
    return new Response(
      batch
        .map(
          (event) =>
            `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  }),
}));
import 'openai/shims/web';
vi.mock('openai', async (load) => {
  const sdk = await load<typeof import('openai')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ConstructorParameters<typeof sdk.default>[0]) {
        super({ ...options, maxRetries: 0, fetch: wire.fetch });
      }
    },
  };
});
import { OpenAIProvider } from '../src/providers/openai.js';
import { toResponsesParams } from '../src/providers/openai-responses.js';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import {
  cacheUsage,
  collectStreamAsync,
  type Message,
  type StreamEvent,
} from '../src/core/protocol/types.js';
import type { ChatRequest } from '../src/core/provider.js';
import { observedStream } from '../src/core/provider.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { ModelUsageSummary, totalInputTokens } from '../src/cli/usage.js';
import { chatSchema, streamSchema } from '../src/providers/bridge-protocol.js';
import { MessageSchema } from '../src/core/session/schema.js';
import { createAgent } from './helpers/trusted-agent.js';
import { mkdtempProjectSync } from './helpers/project.js';
import { ModelBroker } from '../desktop/remote/broker.js';
import { BridgeProvider } from '../src/providers/bridge.js';

const dirs: string[] = [];
afterEach(() => {
  wire.batches.length = wire.bodies.length = wire.urls.length = 0;
  wire.fetch.mockClear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const request = (patch: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'gpt-5.2',
  system: 'system 中文',
  messages: [{ role: 'user', content: 'read' }],
  tools: [],
  maxTokens: 1000,
  thinking: 'off',
  ...patch,
});
const provider = (options: ConstructorParameters<typeof OpenAIProvider>[0] = {}) =>
  new OpenAIProvider({ api: 'responses', apiKey: 'offline-never-sent', ...options });
const end = (type = 'response.completed', extra: Record<string, unknown> = {}) => ({
  type,
  response: {
    status: type === 'response.completed' ? 'completed' : 'incomplete',
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } },
    ...extra,
  },
});
const text = (value = '完成', extra: Record<string, unknown> = {}) => [
  { type: 'response.output_text.delta', delta: value },
  end('response.completed', extra),
];
const call = (id: string, callId: string, args = '') => ({
  id,
  type: 'function_call',
  call_id: callId,
  name: 'read_file',
  arguments: args,
});
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [{ type: 'summary_text', text: '检查文件' }],
  encrypted_content: 'opaque-offline-fixture',
};
const toolEvents = () => [
  { type: 'response.reasoning_summary_text.delta', delta: '检查文件' },
  { type: 'response.output_item.done', output_index: 0, item: reasoning },
  { type: 'response.output_item.added', output_index: 1, item: call('fc_1', 'call_1') },
  { type: 'response.output_item.added', output_index: 2, item: call('fc_2', 'call_2') },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 1,
    delta: '{ "path":',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_2',
    output_index: 2,
    delta: '{"path":"b"}',
  },
  {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 1,
    delta: ' "a" }',
  },
  { type: 'response.function_call_arguments.done', item_id: 'fc_2', arguments: '{"path":"b"}' },
  {
    type: 'response.output_item.done',
    output_index: 2,
    item: call('fc_2', 'call_2', '{"path":"b"}'),
  },
  {
    type: 'response.output_item.done',
    output_index: 1,
    item: call('fc_1', 'call_1', '{ "path": "a" }'),
  },
  end(),
];

describe('OpenAI Responses 传输与协议', () => {
  it.each([
    {
      cached: 0,
      written: 12000,
      ordinary: 0,
      buckets: { ttl_30m_tokens: 12000, ttl_12h_tokens: 0 },
    },
    {
      cached: 4000,
      written: 7000,
      ordinary: 1000,
      buckets: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
    },
    { cached: 12000, written: 0, ordinary: 0, buckets: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 } },
  ])(
    '缓存读 $cached / 写 $written 不重复计入总输入，保留 TTL 与遥测',
    async ({ cached, written, ordinary, buckets }) => {
      wire.batches.push(
        text('完成', {
          usage: {
            input_tokens: 12000,
            output_tokens: 20,
            input_tokens_details: {
              cached_tokens: cached,
              cache_write_tokens: written,
              cache_write_tokens_details: buckets,
            },
          },
        }),
      );
      const events = new EventBus();
      const summary = new ModelUsageSummary();
      const usages: Array<Extract<AgentEvent, { type: 'model_usage' }>> = [];
      events.on('model_request', (event) => summary.request(event));
      events.on('model_usage', (event) => {
        summary.usage(event);
        usages.push(event);
      });
      const result = await collectStreamAsync(
        observedStream(provider(), request({ model: 'gpt-6.1-sol' }), signal(), {
          events,
          purpose: 'agent',
          modelRole: 'main',
        }),
      );
      expect(result.usage).toEqual({
        inputTokens: ordinary,
        outputTokens: 20,
        cacheReadTokens: cached,
        cacheWriteTokens: written,
        cacheWriteTokensByTtl: { '30m': buckets.ttl_30m_tokens, '12h': buckets.ttl_12h_tokens },
      });
      expect(totalInputTokens(result.usage)).toBe(12000);
      expect(usages).toHaveLength(1);
      expect(usages[0].cache).toEqual({ hitTokens: cached, missTokens: 12000 - cached });
      expect(summary.totals).toEqual({
        hitTokens: cached,
        missTokens: 12000 - cached,
        unknownRequests: 0,
      });
    },
  );

  it.each([undefined, null])(
    '新模型缺失写入量（%s）保持未知，不能报告零写入或完整命中率',
    async (written) => {
      wire.batches.push(
        text('完成', {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 60, cache_write_tokens: written },
          },
        }),
      );
      const events: StreamEvent[] = [];
      for await (const event of provider().stream(request({ model: 'gpt-6.1-sol' }), signal()))
        events.push(streamSchema.parse(event));
      const usage = events.find((event) => event.type === 'usage');
      expect(usage).toMatchObject({ inputTokens: 40, cacheReadTokens: 60 });
      expect(usage).not.toHaveProperty('cacheWriteTokens');
      expect(usage).not.toHaveProperty('cacheWriteTokensByTtl');
      expect(cacheUsage(usage!)).toBeUndefined();
    },
  );

  it('部分 TTL 分桶不补零，未知分桶仍可诊断', async () => {
    wire.batches.push(
      text('完成', {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: {
            cached_tokens: 60,
            cache_write_tokens: 20,
            cache_write_tokens_details: { ttl_30m_tokens: 10 },
          },
        },
      }),
    );
    const result = await collectStreamAsync(provider().stream(request(), signal()));
    expect(result.usage.cacheWriteTokensByTtl).toEqual({ '30m': 10 });
    expect(totalInputTokens(result.usage)).toBe(100);
  });

  it('发送 Responses 参数，保留严格性选择、预算、usage 和 transport trace', async () => {
    wire.batches.push(text());
    const p = provider();
    const req = request({
      tools: [
        {
          name: 'read_file',
          description: '读取',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      toolChoice: 'none',
    });
    const traces: unknown[] = [];
    const result = await collectStreamAsync(
      p.stream(req, signal(), { onTransport: (t) => traces.push(t) }),
    );
    expect(wire.urls).toEqual(['https://api.openai.com/v1/responses']);
    expect(wire.bodies[0]).toMatchObject({
      model: req.model,
      instructions: req.system,
      input: req.messages,
      max_output_tokens: 1000,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'none' },
      tool_choice: 'none',
      tools: [
        {
          type: 'function',
          name: 'read_file',
          strict: false,
          parameters: req.tools[0].inputSchema,
        },
      ],
    });
    for (const key of [
      'messages',
      'max_tokens',
      'max_completion_tokens',
      'stream_options',
      'reasoning_effort',
      'previous_response_id',
    ])
      expect(wire.bodies[0]).not.toHaveProperty(key);
    expect(result).toMatchObject({
      stopped: true,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 40,
        outputTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
      },
    });
    expect(result.message.content).toEqual([{ type: 'text', text: '完成' }]);
    expect(p.requestBytes(req)).toBe(Buffer.byteLength(JSON.stringify(wire.bodies[0])));
    expect(p.estimateRequest(req).outputTokens).toBe(1000);
    expect(traces.length).toBeGreaterThan(0);
  });

  it('交错工具调用以 call_id 回填，回放原始参数和加密推理，经会话与 Broker 校验不丢失', async () => {
    wire.batches.push(toolEvents(), text());
    const p = provider();
    const req = request({ thinking: 'high', replayToolArguments: true });
    const events: StreamEvent[] = [];
    async function* stream() {
      for await (const event of p.stream(req, signal())) {
        events.push(event);
        yield streamSchema.parse(event);
      }
    }
    const first = await collectStreamAsync(stream());
    expect(first.stopReason).toBe('tool_use');
    expect(first.message.content.filter((b) => b.type === 'tool_use')).toMatchObject([
      {
        id: 'call_1',
        name: 'read_file',
        input: { path: 'a' },
        replay: { arguments: '{ "path": "a" }' },
      },
      { id: 'call_2', name: 'read_file', input: { path: 'b' } },
    ]);
    expect(events.filter((e) => e.type === 'tool_use_stop')).toHaveLength(2);
    const restored = MessageSchema.parse(JSON.parse(JSON.stringify(first.message))) as Message;
    const next = chatSchema.parse({
      ...req,
      messages: [
        ...req.messages,
        restored,
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: 'a contents' },
            { type: 'tool_result', toolUseId: 'call_2', content: 'denied', isError: true },
            { type: 'text', text: '继续' },
          ],
        },
      ],
    });
    await collectStreamAsync(p.stream(next, signal()));
    expect(wire.bodies[1].input).toEqual([
      ...req.messages,
      reasoning,
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{ "path": "a" }' },
      { type: 'function_call', call_id: 'call_2', name: 'read_file', arguments: '{"path":"b"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a contents' },
      { type: 'function_call_output', call_id: 'call_2', output: 'Error: denied' },
      { role: 'user', content: '继续' },
    ]);
    expect(wire.bodies[0].reasoning).toEqual({ effort: 'high', summary: 'auto' });
    const source = { routeId: p.routeId + ':responses' };
    for (const [routeId, model] of [
      [source.routeId, 'other-model'],
      ['other:responses', req.model],
    ]) {
      const params = toResponsesParams({ ...next, model }, { routeId });
      expect(JSON.stringify(params.input)).not.toContain('encrypted_content');
    }
    expect(JSON.stringify(toAnthropicMessages([restored]))).not.toContain('encrypted_content');
  });

  it.each([
    [
      'response.failed',
      { type: 'response.failed', response: { error: { message: 'private-data' } } },
      'responses_failed',
    ],
    [
      'error',
      { type: 'error', message: 'private-data', code: 'server_error' },
      'responses_stream_error',
    ],
    [
      'content_filter',
      end('response.incomplete', { incomplete_details: { reason: 'content_filter' } }),
      'responses_incomplete',
    ],
  ])('%s 不能伪装成成功响应', async (_name, event, error) => {
    wire.batches.push([event as Record<string, unknown>]);
    await expect(collectStreamAsync(provider().stream(request(), signal()))).rejects.toThrow(error);
  });

  it('截断流与没有结束的工具明确失败', async () => {
    wire.batches.push(
      [{ type: 'response.output_text.delta', delta: 'partial' }],
      [{ type: 'response.output_item.added', item: call('fc_1', 'call_1') }, end()],
    );
    await expect(collectStreamAsync(provider().stream(request(), signal()))).rejects.toThrow(
      'responses_stream_interrupted',
    );
    await expect(collectStreamAsync(provider().stream(request(), signal()))).rejects.toThrow(
      'responses_unfinished_tool',
    );
  });

  it('长度限制映射 max_tokens，拒绝内容照常流式显示', async () => {
    wire.batches.push([
      { type: 'response.refusal.delta', delta: '不能协助' },
      end('response.incomplete', { incomplete_details: { reason: 'max_output_tokens' } }),
    ]);
    const result = await collectStreamAsync(provider().stream(request(), signal()));
    expect(result.stopReason).toBe('max_tokens');
    expect(result.message.content).toEqual([{ type: 'text', text: '不能协助' }]);
  });

  it('取消信号传入 SDK，取消后不发送请求', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectStreamAsync(provider().stream(request(), controller.signal)),
    ).rejects.toThrow();
    expect(wire.fetch).not.toHaveBeenCalled();
  });

  it('默认保持 Chat Completions，按模型覆盖优先于连接默认 API', async () => {
    const chunk = { choices: [{ index: 0, delta: { content: 'legacy' }, finish_reason: 'stop' }] };
    wire.batches.push([chunk], text(), [chunk]);
    const p = new OpenAIProvider({ apiKey: 'offline', models: { special: { api: 'responses' } } });
    await collectStreamAsync(p.stream(request(), signal()));
    await collectStreamAsync(p.stream(request({ model: 'special' }), signal()));
    await collectStreamAsync(
      provider({ models: { legacy: { api: 'chat-completions' } } }).stream(
        request({ model: 'legacy' }),
        signal(),
      ),
    );
    expect(wire.urls.map((url) => new URL(url).pathname)).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/chat/completions',
    ]);
  });

  it.each([false, true])(
    '完整 loop 经权限管线执行或拒绝工具，并回填结果（deny=%s）',
    async (deny) => {
      const cwd = mkdtempProjectSync(join(tmpdir(), 'responses-loop-'));
      dirs.push(cwd);
      writeFileSync(join(cwd, 'a'), 'fixture-file-content');
      wire.batches.push(
        [
          { type: 'response.output_item.added', item: call('fc_1', 'call_1') },
          { type: 'response.output_item.done', item: call('fc_1', 'call_1', '{"path":"a"}') },
          end('response.completed', {
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: {
                cached_tokens: 60,
                cache_write_tokens: 20,
                cache_write_tokens_details: { ttl_30m_tokens: 20, ttl_12h_tokens: 0 },
              },
            },
          }),
        ],
        text('完成', {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: {
              cached_tokens: 60,
              cache_write_tokens: 20,
              cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 20 },
            },
          },
        }),
      );
      const agent = await createAgent(cwd, {
        autoSaveSessions: false,
        config: {
          provider: 'openai',
          model: 'gpt-5.2',
          permissionMode: 'auto',
          permissions: { allow: ['read_file(a)'], deny: deny ? ['read_file(a)'] : [], ask: [] },
          pluginConfig: {
            'agentlab.provider-openai': { api: 'responses' },
            'agentlab.planning': { mode: 'off' },
          },
        },
      });
      const errors: unknown[] = [];
      agent.events.on('error', (e) => errors.push(e));
      try {
        await agent.loop.run('读取 a');
        expect(errors).toEqual([]);
        expect(wire.bodies).toHaveLength(2);
        const results = wire.bodies[1].input.filter(
          (item: any) => item.type === 'function_call_output',
        );
        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
          call_id: 'call_1',
          output: expect.stringContaining(deny ? 'Error:' : 'fixture-file-content'),
        });
        if (deny) expect(JSON.stringify(wire.bodies[1])).not.toContain('fixture-file-content');
        const expected = {
          inputTokens: 40,
          outputTokens: 40,
          cacheReadTokens: 120,
          cacheWriteTokens: 40,
          cacheWriteTokensByTtl: { '30m': 20, '12h': 20 },
        };
        expect(agent.session.tokenUsage).toEqual(expected);
        const saved = await agent.session.save();
        expect(saved).toBeDefined();
        expect(JSON.parse(readFileSync(saved!.path, 'utf8')).usage).toEqual(expected);
      } finally {
        await agent.dispose();
      }
    },
  );

  it('插件和命名连接均能启用 Responses，远程 Broker 保留 API 和不透明思考', async () => {
    const cwd = mkdtempProjectSync(join(tmpdir(), 'responses-config-'));
    dirs.push(cwd);
    const agent = await createAgent(cwd, {
      autoSaveSessions: false,
      config: {
        provider: 'openai',
        model: 'gpt-5.2',
        pluginConfig: {
          'agentlab.provider-openai': { api: 'responses' },
          'agentlab.provider-connections': {
            connections: {
              proxy: { type: 'openai', api: 'responses', baseURL: 'https://fixture.invalid/v1' },
            },
          },
        },
      },
    });
    const broker = new ModelBroker();
    try {
      const main = agent.providers.get('openai');
      const named = agent.providers.get('proxy');
      expect(main.modelCapabilities?.('gpt-5.2')?.api).toBe('responses');
      expect(named.modelCapabilities?.('unknown')?.api).toBe('responses');
      wire.batches.push(
        toolEvents(),
        text('完成', {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: {
              cached_tokens: 60,
              cache_write_tokens: 20,
              cache_write_tokens_details: { ttl_30m_tokens: 5, ttl_12h_tokens: 15 },
            },
          },
        }),
      );
      const d = broker.add(main, {
        name: 'remote',
        kind: 'openai',
        routeId: main.routeId!,
        endpoint: 'https://api.openai.com/v1',
        api: 'responses',
        models: { 'gpt-5.2': { contextWindow: 128000, maxOutputTokens: 2000 } },
        capabilities: { 'gpt-5.2': main.modelCapabilities!('gpt-5.2')! },
      });
      broker.activate();
      const bridge = new BridgeProvider(
        { request: async <T>(m: string, p: unknown) => (await broker.handle(m, p)) as T },
        d,
      );
      expect(bridge.requestBytes(request())).toBe(main.requestBytes!(request()));
      const first = await collectStreamAsync(bridge.stream(request(), signal()));
      const second = await collectStreamAsync(
        bridge.stream(request({ messages: [first.message] }), signal()),
      );
      expect(wire.bodies[1].input[0]).toEqual(reasoning);
      expect(second.usage).toMatchObject({
        inputTokens: 20,
        cacheReadTokens: 60,
        cacheWriteTokens: 20,
        cacheWriteTokensByTtl: { '30m': 5, '12h': 15 },
      });
      expect(totalInputTokens(second.usage)).toBe(100);
    } finally {
      broker.close();
      await agent.dispose();
    }
  });
});
