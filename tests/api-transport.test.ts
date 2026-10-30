/** 实际 SDK + 内存 fetch，验证 HTTP 观测不产生额外请求、不泄露认证、不串并发调用。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: Record<string, unknown> }>,
  handler: undefined as
    undefined | ((url: string, body: Record<string, unknown>) => Promise<Response>),
  fetch: vi.fn(),
}));
import 'openai/shims/web';
vi.mock('openai', async (load) => {
  const sdk = await load<typeof import('openai')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ConstructorParameters<typeof sdk.default>[0]) {
        super({ ...options, maxRetries: 1, fetch: fixture.fetch });
      }
    },
  };
});
vi.mock('@anthropic-ai/sdk', async (load) => {
  const sdk = await load<typeof import('@anthropic-ai/sdk')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ConstructorParameters<typeof sdk.default>[0]) {
        super({ ...options, maxRetries: 1, fetch: fixture.fetch });
      }
    },
  };
});
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { observedStream, type Provider } from '../src/core/provider.js';
import { collectStreamAsync } from '../src/core/protocol/types.js';
import { redactedEvent } from '../src/builtin/telemetry-jsonl/index.js';
import { TransportCapture, observeSDKFetch } from '../src/providers/transport-trace.js';
import type { ApiTransport } from '../src/core/protocol/transport.js';
import { SessionDebugTrace } from '../desktop/worker/debug-trace.js';
import { mkdtempSync, copyFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
const sse = (model = 'fixture-model', text = 'fixture answer') =>
  new Response(
    'data: ' +
      JSON.stringify({
        id: 'fixture',
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 7,
          total_tokens: 107,
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }) +
      '\n\ndata: [DONE]\n\n',
    {
      headers: {
        'content-type': 'text/event-stream',
        'x-request-id': 'fixture-request',
        'set-cookie': 'fictional-hidden-cookie',
      },
    },
  );
beforeEach(() => {
  fixture.calls = [];
  fixture.handler = undefined;
  fixture.fetch.mockReset();
  fixture.fetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    fixture.calls.push({ url: String(url), body });
    return fixture.handler ? fixture.handler(String(url), body) : sse(String(body.model));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function call(provider: Provider, model = 'fixture-model') {
  const events = new EventBus(),
    seen: AgentEvent[] = [];
  events.onAll((event) => seen.push(event));
  const result = await collectStreamAsync(
    observedStream(
      provider,
      {
        model,
        system: 'private system',
        messages: [{ role: 'user', content: 'private prompt' }],
        tools: [],
        maxTokens: 8192,
        thinking: 'off',
      },
      new AbortController().signal,
      { events, purpose: 'agent' },
    ),
  );
  return {
    result,
    seen,
    transport: seen.filter((e) => e.type === 'model_transport').map((e) => e.transport),
  };
}
it('OpenAI/DeepSeek 保留最终 URL、JSON 与原始 SSE 对象；认证头永不进入事件', async () => {
  const { result, seen, transport } = await call(
    new OpenAIProvider({
      apiKey: 'fictional-api-key-should-never-appear',
      baseURL: 'https://api.deepseek.com',
    }),
    'deepseek-flash',
  );
  expect(result.message.content).toContainEqual({ type: 'text', text: 'fixture answer' });
  expect(fixture.calls).toHaveLength(1);
  const request = transport.find((event) => event.phase === 'request')!;
  expect(request.url).toBe('https://api.deepseek.com/chat/completions');
  expect(request.body).toEqual(fixture.calls[0].body);
  expect(request.body).toMatchObject({
    model: 'deepseek-flash',
    stream: true,
    thinking: { type: 'disabled' },
  });
  expect(request.headers?.authorization).toBe('[已隐藏]');
  expect(request.headers?.['content-type']).toContain('application/json');
  expect(transport.find((event) => event.phase === 'headers')).toMatchObject({
    status: 200,
    headers: { 'set-cookie': '[已隐藏]' },
  });
  expect(transport.find((event) => event.phase === 'body')?.body).toMatchObject([
    { model: 'deepseek-flash', choices: [{ delta: { content: 'fixture answer' } }] },
  ]);
  expect(JSON.stringify(transport)).not.toContain('fictional-api-key-should-never-appear');
  expect(JSON.stringify(seen.map(redactedEvent))).not.toMatch(
    /private system|private prompt|fixture answer/,
  );
  if (process.env.AGENTLAB_DEBUG_FIXTURE) {
    const root = mkdtempSync(join(tmpdir(), 'api-trace-fixture-'));
    try {
      const trace = new SessionDebugTrace();
      trace.configure(root, 'sdk-fixture');
      for (const event of seen) trace.record(event);
      mkdirSync(dirname(process.env.AGENTLAB_DEBUG_FIXTURE), { recursive: true });
      copyFileSync(join(root, 'debug/sdk-fixture.jsonl'), process.env.AGENTLAB_DEBUG_FIXTURE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
it('SDK 内部重试每次独立记录，仍只消费一次模型响应', async () => {
  fixture.handler = async (_url, body) =>
    fixture.calls.length === 1
      ? new Response(JSON.stringify({ error: { message: 'fixture rate limited' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '0' },
        })
      : sse(String(body.model));
  const { seen, transport } = await call(
    new OpenAIProvider({ apiKey: 'fictional-api-key', baseURL: 'https://fixture.invalid/v1' }),
  );
  expect(fixture.calls).toHaveLength(2);
  const requests = transport.filter((event) => event.phase === 'request');
  expect(requests.map((event) => event.attempt)).toEqual([1, 2]);
  expect(requests[0].id).not.toBe(requests[1].id);
  expect(
    transport.filter((event) => event.phase === 'headers').map((event) => event.status),
  ).toEqual([429, 200]);
  expect(seen.filter((event) => event.type === 'model_request')).toHaveLength(1);
  expect(seen.filter((event) => event.type === 'model_response')).toHaveLength(1);
});
it('共享 Provider 并发调用不会互相借用 requestId、请求体或响应事件', async () => {
  fixture.handler = async (_url, body) => {
    await new Promise((resolve) => setTimeout(resolve, body.model === 'request-a' ? 15 : 1));
    return sse(String(body.model), String(body.model));
  };
  const provider = new OpenAIProvider({
    apiKey: 'fictional-api-key',
    baseURL: 'https://fixture.invalid/v1',
  });
  const [a, b] = await Promise.all([call(provider, 'request-a'), call(provider, 'request-b')]);
  for (const [result, model] of [
    [a, 'request-a'],
    [b, 'request-b'],
  ] as const) {
    expect(result.transport.find((event) => event.phase === 'request')?.body).toMatchObject({
      model,
    });
    expect(result.transport.find((event) => event.phase === 'body')?.body).toMatchObject([
      { model },
    ]);
    const ids = new Set(
      result.seen
        .filter((event) => event.type.startsWith('model_'))
        .map((event) => ('requestId' in event ? event.requestId : '')),
    );
    expect(ids.size).toBe(1);
  }
  expect(fixture.calls).toHaveLength(2);
});
it('Anthropic 保留 messages API 的实际 system 结构和服务事件', async () => {
  fixture.handler = async () =>
    new Response(
      [
        {
          type: 'message_start',
          message: {
            id: 'fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture-messages-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'fixture anthropic' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const { result, transport } = await call(
    new AnthropicProvider({
      apiKey: 'fictional-anthropic-key',
      baseURL: 'https://fixture.invalid',
    }),
    'fixture-messages-model',
  );
  expect(result.message.content).toContainEqual({ type: 'text', text: 'fixture anthropic' });
  expect(transport.find((event) => event.phase === 'request')).toMatchObject({
    url: 'https://fixture.invalid/v1/messages',
    protocol: 'Anthropic Messages',
    body: { system: 'private system', stream: true },
  });
  expect(transport.find((event) => event.phase === 'request')?.headers?.['x-api-key']).toBe(
    '[已隐藏]',
  );
  expect(transport.find((event) => event.phase === 'body')?.body).toMatchObject([
    { type: 'message_start' },
    { type: 'content_block_start' },
    { type: 'content_block_delta' },
    { type: 'content_block_stop' },
    { type: 'message_delta' },
    { type: 'message_stop' },
  ]);
  expect(fixture.calls).toHaveLength(1);
});
it('HTTP 认证失败保留服务错误结构，不伪造成功响应或触发额外请求', async () => {
  fixture.handler = async () =>
    new Response(
      JSON.stringify({ error: { type: 'invalid_api_key', message: 'fixture key rejected' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  const seen: AgentEvent[] = [],
    events = new EventBus();
  events.onAll((event) => seen.push(event));
  const provider = new OpenAIProvider({
    apiKey: 'fictional-api-key',
    baseURL: 'https://fixture.invalid/v1',
  });
  await expect(
    collectStreamAsync(
      observedStream(
        provider,
        { model: 'fixture', system: '', messages: [], tools: [] },
        new AbortController().signal,
        { events, purpose: 'agent' },
      ),
    ),
  ).rejects.toThrow();
  const transport = seen
    .filter((event) => event.type === 'model_transport')
    .map((event) => event.transport);
  expect(transport.find((event) => event.phase === 'headers')?.status).toBe(401);
  expect(transport.find((event) => event.phase === 'body')).toMatchObject({
    format: 'json',
    errorCode: 'http_401',
    body: { type: 'invalid_api_key' },
  });
  expect(seen.find((event) => event.type === 'model_response')).toMatchObject({
    response: { status: 'error', errorCode: 'http_401' },
  });
  expect(fixture.calls).toHaveLength(1);
});
it('观察者和诊断字段失败不改变 SDK fetch 的参数或返回值', async () => {
  const result = new Response('unchanged');
  const fetch = vi.fn(async (_input: unknown, _init?: unknown) => result);
  const client = { fetch };
  observeSDKFetch(client);
  const events: ApiTransport[] = [];
  const capture = new TransportCapture(
    {
      onTransport: (event) => {
        events.push(event);
        throw new Error('observer failed');
      },
    },
    'fixture',
  );
  const init = { method: 'POST', headers: [['authorization', 'fictional-never-record']] };
  expect(
    await capture.run(() => client.fetch('https://fixture.invalid', init) as Promise<Response>),
  ).toBe(result);
  expect(fetch).toHaveBeenCalledWith('https://fixture.invalid', init);
  expect(JSON.stringify(events)).not.toContain('fictional-never-record');
});
