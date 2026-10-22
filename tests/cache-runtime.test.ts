/** 真实 SDK + 内存 fetch。任何模型请求都只能收到本文件构造的 SSE。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({
  bodies: [] as any[],
  mode: 'text',
  toolName: 'read_file',
  raw: '{ "path": "demo.ts", "limit": 3 }',
  fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    wire.bodies.push(body);
    const chunks = body.model.startsWith('claude')
      ? [
          {
            type: 'message_start',
            message: {
              id: 'offline',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                input_tokens: 10,
                output_tokens: 0,
                cache_read_input_tokens: 2000,
                cache_creation_input_tokens: 50,
                cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
              },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'offline summary' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ]
      : [
          {
            id: 'offline',
            object: 'chat.completion.chunk',
            model: body.model,
            created: 0,
            choices: [
              {
                index: 0,
                delta:
                  wire.mode === 'tool'
                    ? {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'call1',
                            type: 'function',
                            function: { name: wire.toolName, arguments: wire.raw },
                          },
                        ],
                      }
                    : { content: wire.mode === 'planner' ? 'null' : 'offline summary' },
                finish_reason: wire.mode === 'tool' ? 'tool_calls' : 'stop',
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 3,
              total_tokens: 103,
              prompt_tokens_details: {
                cached_tokens: 40,
                cache_write_tokens: 20,
                cache_write_tokens_details: { ttl_30m_tokens: 20, ttl_12h_tokens: 0 },
              },
            },
          },
        ];
    if (wire.mode === 'tool') wire.mode = 'text';
    return new Response(
      chunks
        .map(
          (chunk) =>
            (body.model.startsWith('claude') ? `event: ${(chunk as any).type}\n` : '') +
            `data: ${JSON.stringify(chunk)}\n\n`,
        )
        .join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }),
}));
import 'openai/shims/web';
vi.mock('openai', async (load) => {
  const sdk = await load<typeof import('openai')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: any) {
        super({ ...options, maxRetries: 0, fetch: wire.fetch });
      }
    },
  };
});
vi.mock('@anthropic-ai/sdk', async (load) => {
  const sdk = await load<typeof import('@anthropic-ai/sdk')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: any) {
        super({ ...options, maxRetries: 0, fetch: wire.fetch });
      }
    },
  };
});
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider, buildAnthropicBody } from '../src/providers/anthropic.js';
import {
  prepareModelRequest,
  UsageAnchors,
  withRequestBudget,
} from '../src/core/context/request-budget.js';
import { collectStreamAsync } from '../src/core/protocol/types.js';
import type { ChatRequest, Provider } from '../src/core/provider.js';
import { observedStream } from '../src/core/provider.js';
import { planningStrategy } from '../src/builtin/planning/index.js';
import { SummaryCompactor } from '../src/builtin/compaction-summary/implementation.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/model.js';
import { EventBus } from '../src/core/events.js';
import { ModelUsageSummary } from '../src/cli/usage.js';
import { AgentLoop } from '../src/core/loop.js';
import { ToolRegistry } from '../src/core/registry.js';
import { HookRunner } from '../src/core/hooks.js';
import { ContextManager } from '../src/core/context/coordinator.js';
import { McpResultStore } from '../src/mcp/results.js';
import { mkdtempProject } from './helpers/project.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent } from '../src/index.js';
import { createModelCatalog } from '../src/builtin/model-catalog/index.js';
const signal = () => new AbortController().signal;
const request = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'deepseek-flash',
  system: 'fixed',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  maxTokens: 1000,
  ...extra,
});
const deepseek = () =>
  new OpenAIProvider({ apiKey: 'offline-only', baseURL: 'https://api.deepseek.com' });
afterEach(() => {
  wire.bodies.length = 0;
  wire.mode = 'text';
  wire.toolName = 'read_file';
  wire.raw = '{ "path": "demo.ts", "limit": 3 }';
  wire.fetch.mockClear();
});

describe('全部模型角色的最终预算', () => {
  it('planner 在 SDK fetch 前拦截 system + 输出超窗，输出请求遵守具体模型上限', async () => {
    const provider = withRequestBudget(deepseek(), () => ({
      contextWindow: 5000,
      maxOutputTokens: 500,
    }));
    const input = {
      input: 'review',
      messages: [{ role: 'user' as const, content: 'review' }],
      systemPrompt: '文'.repeat(4000),
      mode: 'auto' as const,
      force: false,
      provider,
      model: 'deepseek-flash',
      thinking: 'off' as const,
      signal: signal(),
      events: new EventBus(),
      runId: 'offline',
    };
    await expect(planningStrategy.prepare(input)).rejects.toThrow('context_budget_exceeded');
    expect(wire.fetch).not.toHaveBeenCalled();
    wire.mode = 'planner';
    await planningStrategy.prepare({ ...input, systemPrompt: 'small' });
    expect(wire.bodies[0].max_tokens).toBe(500);
    expect(wire.bodies[0].thinking).toEqual({ type: 'disabled' });
  });
  it('summary 经过相同预算门，已知小模型的输出不再固定2048', async () => {
    const provider = withRequestBudget(deepseek(), () => ({
      contextWindow: 10000,
      maxOutputTokens: 500,
    }));
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: 'user' as const,
      content: 'message ' + i,
    }));
    await new SummaryCompactor().compact(messages, provider, signal(), 'deepseek-flash');
    expect(wire.bodies[0].max_tokens).toBe(500);
    await new SummaryCompactor().compact(
      messages.map((m) => ({ ...m, content: '文'.repeat(4000) })),
      provider,
      signal(),
      'deepseek-flash',
    );
    expect(wire.fetch).toHaveBeenCalledTimes(1);
  });
  it('judge 字节和 token 分开检查；不能悄悄降低 thinking 来适应窗口', async () => {
    const provider = withRequestBudget(deepseek(), () => ({
      contextWindow: 100000,
      maxOutputTokens: 500,
    }));
    const reviewer = createModelReviewer({
      provider,
      model: 'deepseek-flash',
      maxRequestBytes: 100000,
      thinking: 'high',
    });
    await reviewer.review(
      {
        tool: { name: 'write_file', description: '', risk: 'write', inputSchema: {} },
        input: { path: 'result.txt', content: 'fixture' },
        cwd: '/fixture',
        userRequest: '创建 result.txt',
        decision: { kind: 'review', source: 'mode', reason: 'fixture' },
      },
      signal(),
    );
    expect(wire.bodies[0].max_tokens).toBe(500);
    expect(wire.bodies[0].thinking).toEqual({ type: 'enabled' });
    expect(wire.bodies[0].reasoning_effort).toBe('high');
    const anthropic = withRequestBudget(new AnthropicProvider({ apiKey: 'offline' }), () => ({
      contextWindow: 100000,
      maxOutputTokens: 1000,
    }));
    expect(() =>
      prepareModelRequest(anthropic, request({ model: 'claude-fixture', thinking: 'high' })),
    ).toThrow('output_budget_exceeded');
  });
});

it('usage 锚点只用于相同包络与 append-only 前缀；改历史、换模型都不继承', () => {
  const anchors = new UsageAnchors();
  const a = request();
  const base = { inputTokens: 100, outputTokens: 1000, totalTokens: 1100 };
  anchors.observe(a, base, { inputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 0 });
  const b = { ...a, messages: [...a.messages, { role: 'user' as const, content: 'next' }] };
  expect(anchors.estimate(b, { ...base, inputTokens: 150 }).inputTokens).toBe(550);
  expect(
    anchors.estimate({ ...b, model: 'other' }, { ...base, inputTokens: 150 }).inputTokens,
  ).toBe(150);
  expect(
    anchors.estimate({ ...a, messages: [{ role: 'user', content: 'changed' }] }, base).calibrated,
  ).toBe(false);
});

it('Anthropic 真实 SDK 发送分段静态边界、合法混合TTL及最多四断点，并解析写入桶', async () => {
  const provider = new AnthropicProvider({ apiKey: 'offline' });
  const req = request({
    model: 'claude-fixture',
    system: 'stable\nenv=A',
    systemSegments: [
      { text: 'stable', stable: true },
      { text: '\nenv=A', stable: false },
    ],
    tools: [{ name: 't', description: '', inputSchema: {} }],
    messages: [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ],
    cache: { system: true, tools: true, messageBreakpoints: [0, 1], staticTtl: '1h', ttl: '5m' },
  });
  const { usage } = await collectStreamAsync(provider.stream(req, signal()));
  const body = wire.bodies[0];
  expect(body.system).toHaveLength(2);
  expect(body.system[0].cache_control.ttl).toBe('1h');
  expect(body.system[1].cache_control).toBeUndefined();
  expect(JSON.stringify(body).match(/cache_control/g) ?? []).toHaveLength(4);
  expect(usage.cacheWriteTokensByTtl).toEqual({ '5m': 20, '1h': 30 });
  expect(() =>
    buildAnthropicBody({ ...req, cache: { ...req.cache, staticTtl: '5m', ttl: '1h' } }),
  ).toThrow('invalid_cache_ttl_order');
});

it('原始参数仅来源路由/模型和解析结果都匹配时回放，修改后失效；执行仍用解析对象', async () => {
  wire.mode = 'tool';
  const provider = deepseek();
  const req = request({
    tools: [{ name: 'read_file', description: '', inputSchema: {} }],
    replayToolArguments: true,
  });
  const { message } = await collectStreamAsync(provider.stream(req, signal()));
  expect((message.content[0] as any).input).toEqual({ path: 'demo.ts', limit: 3 });
  wire.mode = 'text';
  const next = {
    ...req,
    messages: [
      message,
      {
        role: 'user' as const,
        content: [{ type: 'tool_result' as const, toolUseId: 'call1', content: 'fixture' }],
      },
    ],
  };
  await collectStreamAsync(provider.stream(next, signal()));
  expect(wire.bodies[1].messages[1].tool_calls[0].function.arguments).toBe(wire.raw);
  (message.content[0] as any).input.path = 'changed.ts';
  await collectStreamAsync(provider.stream(next, signal()));
  expect(JSON.parse(wire.bodies[2].messages[1].tool_calls[0].function.arguments).path).toBe(
    'changed.ts',
  );
  const other = new OpenAIProvider({ apiKey: 'offline', baseURL: 'https://proxy.invalid' });
  await collectStreamAsync(other.stream(next, signal()));
  expect(wire.bodies[3].messages[1].tool_calls[0].function.arguments).not.toBe(wire.raw);
});

it('原前缀摘要显式开启、同路由才使用，禁止工具并保留完整用户限制；不满足条件回退', async () => {
  const provider = deepseek();
  const messages = Array.from({ length: 8 }, (_, i) => ({
    role: 'user' as const,
    content: i === 0 ? '仅云端；不付费；不要修改文件。' : 'history ' + i,
  }));
  const req = request({
    messages,
    tools: [{ name: 'write_file', description: '', inputSchema: {} }],
  });
  const result = await new SummaryCompactor({ strategy: 'prefix' }).compact(
    messages,
    provider,
    signal(),
    req.model,
    undefined,
    req,
  );
  expect(wire.bodies[0].messages[0].content).toBe('fixed');
  expect(wire.bodies[0].tool_choice).toBe('none');
  expect(JSON.stringify(result)).toContain('仅云端；不付费；不要修改文件。');
  const generic = new OpenAIProvider({ apiKey: 'offline', baseURL: 'https://generic.invalid' });
  await new SummaryCompactor({ strategy: 'prefix' }).compact(
    messages,
    generic,
    signal(),
    req.model,
    undefined,
    req,
  );
  expect(wire.bodies[1].tools).toBeUndefined();
  expect(wire.bodies[1].messages[0].content).toContain('压缩器');
});

it('模型/API 能力区别于兼容端点，真实 SDK 使用指定输出参数', async () => {
  const provider = new OpenAIProvider({ apiKey: 'offline' });
  await collectStreamAsync(
    provider.stream(request({ model: 'gpt-5.2', thinking: 'off' }), signal()),
  );
  expect(wire.bodies[0].max_completion_tokens).toBe(1000);
  expect(wire.bodies[0].max_tokens).toBeUndefined();
  expect(wire.bodies[0].reasoning_effort).toBe('none');
  await expect(
    collectStreamAsync(provider.stream(request({ model: 'gpt-4o', thinking: 'high' }), signal())),
  ).rejects.toThrow('unsupported_thinking_level');
  expect(wire.fetch).toHaveBeenCalledTimes(1);
});

it('统计包含脱敏路由、角色、TTFT和估算误差；缺失分桶保持未知', async () => {
  const events = new EventBus();
  const rows: any[] = [];
  const summary = new ModelUsageSummary();
  events.on('model_request', (e) => {
    rows.push(e);
    summary.request(e);
  });
  events.on('model_usage', (e) => {
    rows.push(e);
    summary.usage(e);
  });
  await collectStreamAsync(
    observedStream(deepseek(), request(), signal(), {
      events,
      purpose: 'agent',
      modelRole: 'planner',
    }),
  );
  expect(rows[0].routeId).toMatch(/^openai:[a-f0-9]+$/);
  expect(rows[1].metrics.ttftMs).toBeGreaterThanOrEqual(0);
  expect(rows[1].usage.cacheWriteTokensByTtl).toEqual({ '30m': 20, '12h': 0 });
  summary.request({
    requestId: 'unknown',
    provider: 'other',
    purpose: 'judge',
    request: { model: 'fixture' },
  });
  summary.usage({ requestId: 'unknown', usageReported: false });
  expect(summary.describe()).toContain('未知');
  expect(summary.describe()).toContain('planner');
});

it('真实 SDK 主循环续读MCP结果，权限门保留，已发送的历史不会被分页改写', async () => {
  const cwd = await mkdtempProject(join(tmpdir(), 'cache-wire-mcp-'));
  const store = new McpResultStore(1024);
  const preview = await store.retain(
    { content: '中😀IMPORTANT\n'.repeat(1000) },
    { cwd, signal: signal() },
  );
  const id = /result_id=([0-9a-f-]+)/.exec(preview.content)![1];
  const tools = new ToolRegistry();
  tools.register(store.reader());
  wire.mode = 'tool';
  wire.toolName = 'mcp_read_result';
  wire.raw = JSON.stringify({ result_id: id, offset: 20, limit: 200 });
  const events = new EventBus();
  const records: any[] = [];
  events.on('model_usage', (e) => records.push(e));
  const loop = new AgentLoop({
    provider: deepseek(),
    model: 'deepseek-flash',
    modelInfo: () => ({ contextWindow: 10000, maxOutputTokens: 500 }),
    tools,
    hooks: new HookRunner(),
    events,
    context: new ContextManager({ compactThreshold: 10000, compactor: new SummaryCompactor() }),
    systemPrompt: 'fixture',
    maxTurns: 2,
    cwd,
    policy: {
      decide: () => ({ kind: 'allow', source: 'config', reason: 'fixture read authorization' }),
    },
  });
  try {
    expect((await loop.run(preview.content)).reason).toBe('completed');
    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[1].messages.slice(0, wire.bodies[0].messages.length)).toEqual(
      wire.bodies[0].messages,
    );
    expect(
      wire.bodies[1].messages.some(
        (m: any) => m.role === 'tool' && m.content.includes('MCP result'),
      ),
    ).toBe(true);
    expect(records[0].metrics.ttftMs).toBeGreaterThanOrEqual(0);
    expect(preview.content).toContain(id);
  } finally {
    await loop.dispose();
    await store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

it('PreToolUse改写参数后原串回放失效，实际执行和审批仍使用校验对象', async () => {
  const tools = new ToolRegistry();
  const executed = vi.fn(async (_input: Record<string, unknown>) => ({ content: 'fixture' }));
  tools.register({
    name: 'read_file',
    description: '',
    risk: 'read',
    inputSchema: { type: 'object' },
    execute: executed,
  });
  const hooks = new HookRunner();
  hooks.register('PreToolUse', () => ({ input: { path: 'allowed.ts', limit: 3 } }));
  wire.mode = 'tool';
  const loop = new AgentLoop({
    provider: deepseek(),
    model: 'deepseek-flash',
    tools,
    hooks,
    events: new EventBus(),
    context: new ContextManager({ compactThreshold: 100000, compactor: new SummaryCompactor() }),
    replayToolArguments: true,
    systemPrompt: 'fixture',
    maxTurns: 2,
    cwd: '/fixture',
    policy: {
      decide: (input) => {
        expect(input.input.path).toBe('allowed.ts');
        return { kind: 'allow', source: 'config', reason: 'fixture authorization' };
      },
    },
  });
  try {
    expect((await loop.run('read fixture')).reason).toBe('completed');
    expect(executed.mock.calls[0][0]).toEqual({ path: 'allowed.ts', limit: 3 });
    const replay = wire.bodies[1].messages.find((m: any) => m.role === 'assistant').tool_calls[0]
      .function.arguments;
    expect(replay).not.toBe(wire.raw);
    expect(JSON.parse(replay)).toEqual({ path: 'demo.ts', limit: 3 });
    expect(
      (loop.getMessages().find((m) => m.role === 'assistant')!.content[0] as any).replay,
    ).toBeUndefined();
  } finally {
    await loop.dispose();
  }
});

it('独立摘要也遵守字节限额；adaptive模型明确thinking on/off，保留输出上限', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    role: 'user' as const,
    content: 'message ' + i,
  }));
  await new SummaryCompactor({ maxRequestBytes: 1 }).compact(
    messages,
    deepseek(),
    signal(),
    'deepseek-flash',
  );
  expect(wire.fetch).not.toHaveBeenCalled();
  const provider = new AnthropicProvider({
    apiKey: 'offline',
    models: {
      'claude-fixture': {
        api: 'messages',
        thinkingMode: 'adaptive',
        thinkingLevels: ['off', 'high'],
      },
    },
  });
  await collectStreamAsync(
    provider.stream(request({ model: 'claude-fixture', thinking: 'high' }), signal()),
  );
  expect(wire.bodies[0].thinking).toEqual({ type: 'adaptive' });
  expect(wire.bodies[0].max_tokens).toBe(1000);
  await collectStreamAsync(
    provider.stream(request({ model: 'claude-fixture', thinking: 'off' }), signal()),
  );
  expect(wire.bodies[1].thinking).toEqual({ type: 'disabled' });
});

it('配置辅助角色provider/model/thinking真正进入SDK，模型规格按路由优先匹配', async () => {
  const catalog = createModelCatalog({
    fixture: { contextWindow: 100000, maxOutputTokens: 8192 },
    'openai/fixture': { contextWindow: 3000, maxOutputTokens: 500 },
    'openai:route/fixture': { contextWindow: 2000, maxOutputTokens: 300 },
  });
  expect(catalog.get('fixture', 'openai:other')?.contextWindow).toBe(3000);
  expect(catalog.get('fixture', 'openai:route')?.maxOutputTokens).toBe(300);
  const cwd = await mkdtempProject(join(tmpdir(), 'cache-roles-'));
  const agent = await createAgent(cwd, {
    autoSaveSessions: false,
    config: {
      provider: 'fake',
      model: 'offline',
      compactThreshold: 1,
      pluginConfig: {
        'agentlab.planning': { mode: 'off' },
        'agentlab.compaction-summary': {
          provider: 'openai',
          model: 'gpt-4o',
          thinking: 'off',
          maxOutputTokens: 700,
        },
      },
    },
  });
  try {
    agent.loop.importSession({
      messages: Array.from({ length: 8 }, (_, i) => ({
        role: 'user' as const,
        content: 'old ' + i,
      })),
    });
    await agent.loop.run('continue');
    expect(wire.bodies[0].model).toBe('gpt-4o');
    expect(wire.bodies[0].max_tokens).toBe(700);
    expect(wire.bodies[0].thinking).toBeUndefined();
  } finally {
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

it('前缀摘要遇到模型工具输出或换路由时回退，完整原始限制仍保留', async () => {
  const provider = deepseek();
  const restriction = '只读，不付费，不删除文件。' + '保持限制。'.repeat(200);
  const messages = Array.from({ length: 8 }, (_, i) => ({
    role: 'user' as const,
    content: i === 0 ? restriction : 'old ' + i + ' history'.repeat(400),
  }));
  const req = request({
    messages,
    tools: [{ name: 'write_file', description: '', inputSchema: {} }],
  });
  wire.mode = 'tool';
  const result = await new SummaryCompactor({ strategy: 'prefix' }).compact(
    messages,
    provider,
    signal(),
    req.model,
    undefined,
    req,
  );
  expect(wire.bodies).toHaveLength(2);
  expect(wire.bodies[0].tool_choice).toBe('none');
  expect(wire.bodies[1].tools).toBeUndefined();
  expect(JSON.stringify(result)).toContain(restriction);
  const other = new OpenAIProvider({
    apiKey: 'offline',
    baseURL: 'https://proxy.invalid',
    dialect: 'deepseek',
  });
  await new SummaryCompactor({ strategy: 'prefix', provider: () => other }).compact(
    messages,
    provider,
    signal(),
    req.model,
    undefined,
    req,
  );
  expect(wire.bodies[2].tools).toBeUndefined();
});

it('真实SDK usage成为下一次追加请求的预算锚点，校准后越界不会发出请求', async () => {
  let window = 10000;
  const provider = withRequestBudget(deepseek(), () => ({
    contextWindow: window,
    maxOutputTokens: 20,
  }));
  const a = request({ maxTokens: 20 });
  const first = provider.estimateRequest!(a);
  await collectStreamAsync(provider.stream(a, signal()));
  const b = { ...a, messages: [...a.messages, { role: 'user' as const, content: 'next' }] };
  const next = provider.estimateRequest!(b);
  expect(next.calibrated).toBe(true);
  expect(next.inputTokens).toBe(100 + next.baseInputTokens! - first.baseInputTokens!);
  window = next.totalTokens - 1;
  await expect(collectStreamAsync(provider.stream(b, signal()))).rejects.toThrow(
    'context_budget_exceeded',
  );
  expect(wire.fetch).toHaveBeenCalledTimes(1);
});

it('统计快照和树汇总不共享TTL可变对象，不会因查看统计而放大真实计数', async () => {
  const cwd = await mkdtempProject(join(tmpdir(), 'cache-usage-copy-'));
  const agent = await createAgent(cwd, {
    autoSaveSessions: false,
    config: { provider: 'fake', model: 'offline' },
  });
  try {
    agent.events.emit({
      type: 'model_usage',
      requestId: 'fixture',
      purpose: 'agent',
      usageReported: true,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 10,
        cacheWriteTokensByTtl: { '5m': 10 },
      },
    });
    const first = agent.agents.usage();
    first.tree.cacheWriteTokensByTtl!['5m'] = 999;
    expect(first.self.cacheWriteTokensByTtl!['5m']).toBe(10);
    expect(agent.session.tokenUsage.cacheWriteTokensByTtl!['5m']).toBe(10);
    agent.session.tokenUsage.cacheWriteTokensByTtl!['5m'] = 888;
    expect(agent.session.tokenUsage.cacheWriteTokensByTtl!['5m']).toBe(10);
  } finally {
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
