/** 真实代理路由与 SDK，所有 HTTP 响应由 MockAgent 返回，禁止连接真实网络。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Agent, EnvHttpProxyAgent, MockAgent, ProxyAgent, type Dispatcher } from 'undici';
import { EnvironmentProxyTransport } from '../src/runtime/http-proxy.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { complete } from '../src/core/provider.js';
import { McpClientManager } from '../src/mcp/plugin.js';

// 只关闭重试延迟；保留 SDK 的请求构造、代理 fetch 和流式解析。
vi.mock('openai', async (load) => {
  const sdk = await load<typeof import('openai')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ConstructorParameters<typeof sdk.default>[0]) {
        super({ ...options, maxRetries: 0 });
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
        super({ ...options, maxRetries: 0 });
      }
    },
  };
});

let offline: MockAgent;
let proxies: ProxyAgent[];
let direct: string[];
const resources: Array<{ dispose(): Promise<void> }> = [];
function offlineDispatch(
  opts: Agent.DispatchOptions,
  handler: Dispatcher.DispatchHandler,
): boolean {
  const body = opts.body;
  if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
    // fetch 在 dispatcher 边界使用异步 body；离线服务先收齐，再按最终 JSON 断言。
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      offline.dispatch({ ...opts, body: Buffer.concat(chunks) }, handler);
    })().catch((error) => handler.onError?.(error));
    return true;
  }
  return offline.dispatch(opts, handler);
}
beforeEach(() => {
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ])
    vi.stubEnv(name, undefined);
  proxies = [];
  direct = [];
  const agent = new Agent();
  offline = new MockAgent({ agent });
  offline.disableNetConnect();
  const dispatch = Agent.prototype.dispatch;
  vi.spyOn(Agent.prototype, 'dispatch').mockImplementation(function (this: Agent, opts, handler) {
    if (this === agent) return dispatch.call(this, opts, handler);
    direct.push(String(opts.origin));
    return offlineDispatch(opts, handler);
  });
  vi.spyOn(ProxyAgent.prototype, 'dispatch').mockImplementation(function (
    this: ProxyAgent,
    opts,
    handler,
  ) {
    proxies.push(this);
    return offlineDispatch(opts, handler);
  });
});
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.dispose()));
  await offline.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function transport() {
  const value = new EnvironmentProxyTransport();
  resources.push(value);
  return value;
}
async function get(value: EnvironmentProxyTransport, url: string) {
  const parsed = new URL(url);
  offline.get(parsed.origin).intercept({ path: parsed.pathname }).reply(200, 'offline');
  const response = await value.options().fetch!(url);
  expect(await response.text()).toBe('offline');
}

it('未配置代理保留客户端默认 fetch，不改写全局网络', () => {
  const original = globalThis.fetch;
  expect(transport().options()).toEqual({});
  expect(globalThis.fetch).toBe(original);
});

it('HTTP 与 HTTPS 选择各自代理；HTTPS 缺省时复用 HTTP 代理', async () => {
  vi.stubEnv('HTTP_PROXY', 'http://http-proxy.invalid:8000');
  vi.stubEnv('HTTPS_PROXY', 'https://https-proxy.invalid:8443');
  const separate = transport();
  await get(separate, 'http://fixture.invalid/one');
  await get(separate, 'https://fixture.invalid/two');
  expect(proxies[0]).not.toBe(proxies[1]);
  vi.stubEnv('HTTPS_PROXY', undefined);
  const fallback = transport();
  await get(fallback, 'http://fixture.invalid/three');
  await get(fallback, 'https://fixture.invalid/four');
  expect(proxies[2]).toBe(proxies[3]);
  expect(direct).toEqual([]);
});

it('只设置 HTTPS_PROXY 时 HTTP 保持直连', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://proxy.invalid:8000');
  const value = transport();
  await get(value, 'http://fixture.invalid/one');
  await get(value, 'https://fixture.invalid/two');
  expect(direct).toEqual(['http://fixture.invalid']);
  expect(proxies).toHaveLength(1);
});

it.each([
  ['localhost,127.0.0.1,[::1]', 'http://127.0.0.1/one', false],
  ['localhost,127.0.0.1,[::1]', 'http://[::1]/one', false],
  ['.example.invalid', 'https://api.example.invalid/one', false],
  ['*.example.invalid', 'https://api.example.invalid/one', false],
  ['example.invalid', 'https://badexample.invalid/one', true],
  ['localhost:3000', 'http://localhost:3000/one', false],
  ['localhost:3000', 'http://localhost:3001/one', true],
  ['other.invalid fixture.invalid', 'https://fixture.invalid/one', false],
  ['*', 'https://fixture.invalid/one', false],
] as const)('NO_PROXY=%s 对 %s 的代理选择为 %s', async (noProxy, url, proxied) => {
  vi.stubEnv('HTTP_PROXY', 'http://proxy.invalid:8000');
  vi.stubEnv('NO_PROXY', noProxy);
  await get(transport(), url);
  expect(proxies).toHaveLength(proxied ? 1 : 0);
  expect(direct).toHaveLength(proxied ? 0 : 1);
});

it('小写优先且空值可屏蔽大写，配置在创建时快照', async () => {
  vi.stubEnv('HTTP_PROXY', 'not-a-valid-proxy');
  vi.stubEnv('http_proxy', 'http://lowercase.invalid:8000');
  vi.stubEnv('NO_PROXY', '*');
  vi.stubEnv('no_proxy', '');
  const value = transport();
  vi.stubEnv('http_proxy', 'changed-invalid');
  await get(value, 'https://fixture.invalid/one');
  expect(proxies).toHaveLength(1);
  vi.stubEnv('http_proxy', '');
  expect(transport().options()).toEqual({});
});

it.each(['not-a-url-with-secret', 'socks5://user:secret@proxy.invalid:1080'])(
  '非法代理给出安全错误',
  (proxy) => {
    vi.stubEnv('HTTPS_PROXY', proxy);
    expect(() => transport().options()).toThrow('HTTPS_PROXY/https_proxy 配置无效');
    try {
      transport().options();
    } catch (error) {
      expect(String(error)).not.toContain('secret');
      expect((error as Error).cause).toBeUndefined();
    }
  },
);

it('传递取消信号，代理失败不发起直连回退，并销毁传输', async () => {
  vi.stubEnv('HTTP_PROXY', 'http://proxy.invalid:8000');
  const value = transport();
  const destroy = vi.spyOn(EnvHttpProxyAgent.prototype, 'destroy');
  const fetch = value.options().fetch!;
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetch('https://fixture.invalid/aborted', { signal: controller.signal }),
  ).rejects.toThrow();
  expect(proxies).toHaveLength(0);
  offline
    .get('https://fixture.invalid')
    .intercept({ path: '/failed' })
    .replyWithError(new Error('offline proxy failure'));
  await expect(fetch('https://fixture.invalid/failed')).rejects.toThrow();
  expect(proxies).toHaveLength(1);
  expect(direct).toEqual([]);
  await value.dispose();
  expect(destroy).toHaveBeenCalled();
  const calls = destroy.mock.calls.length;
  await value.dispose();
  expect(destroy).toHaveBeenCalledTimes(calls);
});

it.each(['openai', 'anthropic'] as const)('%s SDK 经代理发送最终请求并解析 SSE', async (kind) => {
  vi.stubEnv('HTTPS_PROXY', 'http://user:proxy-password@proxy.invalid:8000');
  const provider =
    kind === 'openai'
      ? new OpenAIProvider({ apiKey: 'offline-key-never-sent', baseURL: 'https://fixture.invalid' })
      : new AnthropicProvider({
          apiKey: 'offline-key-never-sent',
          baseURL: 'https://fixture.invalid',
        });
  resources.push(provider);
  const body =
    kind === 'openai'
      ? 'data: ' +
        JSON.stringify({
          id: 'fixture',
          choices: [{ index: 0, delta: { content: 'offline answer' }, finish_reason: 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n'
      : [
          [
            'message_start',
            {
              message: {
                id: 'fixture',
                role: 'assistant',
                model: 'fixture',
                content: [],
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
          ],
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          [
            'content_block_delta',
            { index: 0, delta: { type: 'text_delta', text: 'offline answer' } },
          ],
          ['content_block_stop', { index: 0 }],
          ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
          ['message_stop', {}],
        ]
          .map(
            ([type, data]) =>
              `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
          )
          .join('');
  let headers: unknown;
  offline
    .get('https://fixture.invalid')
    .intercept({
      path: kind === 'openai' ? '/chat/completions' : '/v1/messages',
      method: 'POST',
    })
    .reply((request) => {
      headers = request.headers;
      expect(JSON.parse(String(request.body)).model).toBe('fixture');
      return {
        statusCode: 200,
        data: body,
        responseOptions: { headers: { 'content-type': 'text/event-stream' } },
      };
    });
  const result = await complete(
    provider,
    {
      model: 'fixture',
      system: 'offline rules',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      maxTokens: 32,
    },
    new AbortController().signal,
  );
  expect(result.text).toBe('offline answer');
  expect(proxies).toHaveLength(1);
  expect(direct).toEqual([]);
  expect(JSON.stringify(headers)).not.toContain('proxy-password');
});

it('HTTP MCP 的初始化、通知、工具列表和会话关闭共用代理 fetch', async () => {
  vi.stubEnv('HTTP_PROXY', 'http://proxy.invalid:8000');
  const manager = new McpClientManager();
  const pool = offline.get('http://mcp.invalid');
  pool.intercept({ path: '/mcp', method: 'POST' }).reply((request) => {
    const message = JSON.parse(String(request.body));
    expect(message.method).toBe('initialize');
    return {
      statusCode: 200,
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'offline', version: '1' },
        },
      }),
      responseOptions: {
        headers: { 'content-type': 'application/json', 'mcp-session-id': 'offline-session' },
      },
    };
  });
  pool.intercept({ path: '/mcp', method: 'POST' }).reply(202);
  pool.intercept({ path: '/mcp', method: 'GET' }).reply(405);
  pool.intercept({ path: '/mcp', method: 'POST' }).reply((request) => {
    const message = JSON.parse(String(request.body));
    expect(message.method).toBe('tools/list');
    return {
      statusCode: 200,
      data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }),
      responseOptions: { headers: { 'content-type': 'application/json' } },
    };
  });
  try {
    const client = await manager.connect('offline', { url: 'http://mcp.invalid/mcp' });
    expect((await client.listTools()).tools).toEqual([]);
  } finally {
    await manager.closeAll();
  }
  expect(proxies.length).toBeGreaterThanOrEqual(3);
  expect(direct).toEqual([]);
});
