/** 两个真实 SDK 都只连接内存 fetch；在最终 JSON 序列化之后观测，绝不回退真实网络。 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => {
  const state = {
    handle: async (_input: unknown, _init?: RequestInit): Promise<Response> => {
      throw new Error('Offline transport not configured');
    },
  };
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => state.handle(input, init));
  return state;
});
import 'openai/shims/web';
// 只注入 fetch；保留真实 SDK 构造请求、JSON序列化和SSE解析，不替换 create/stream。
vi.mock('openai', async (load) => {
  const sdk = await load<typeof import('openai')>();
  return {
    ...sdk,
    default: class extends sdk.default {
      constructor(options: ConstructorParameters<typeof sdk.default>[0]) {
        super({
          ...options,
          maxRetries: 0,
          fetch: ((url, init) => transport.handle(url, init as RequestInit)) as NonNullable<
            ConstructorParameters<typeof sdk.default>[0]
          >['fetch'],
        });
      }
    },
  };
});
import { rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgent, type AgentConfig } from '../src/index.js';
import { definePlugin, type Plugin } from '../src/sdk/index.js';
import type { ChatRequest } from '../src/core/provider.js';
import type { AgentEvent } from '../src/core/events.js';
import { OpenAIProvider, toOpenAIParams } from '../src/providers/openai.js';
import { AnthropicProvider, buildAnthropicBody } from '../src/providers/anthropic.js';
import { STRICT_REVIEWER_SYSTEM } from '../src/builtin/reviewer-model/model.js';
import { requestPlan } from './helpers/runtime-plan.js';
import { mkdtempProject } from './helpers/project.js';
import {
  commonPrefixBytes,
  createTransportPrefixObserver,
  sha256,
  type TransportRole,
} from './helpers/transport-prefix.js';

type Adapter = 'openai' | 'anthropic';
type Reply = { text: string } | { name: string; input: Record<string, unknown> };
type Route = (request: ChatRequest, role: TransportRole) => Reply;
type RequestEvent = Extract<AgentEvent, { type: 'model_request' }>;
// 只用于解释断点标记变化；观测值始终基于未删改的 SDK body。
const withoutCacheAnnotations = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === 'cache_control' ? undefined : item)));
const cleanups: Array<() => Promise<void>> = [];
const captures: Array<ReturnType<ReturnType<typeof createTransportPrefixObserver>['observe']>[]> =
  [];
afterEach(async () => {
  const observations = captures.splice(0);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  transport.handle = async () => {
    throw new Error('Offline transport not configured');
  };
  // 显式开启才输出白名单观测；正文仅在测试内存中用于断言。
  if (process.env.TRANSPORT_PREFIX_EVIDENCE && observations.length)
    await appendFile(
      process.env.TRANSPORT_PREFIX_EVIDENCE,
      JSON.stringify({ test: expect.getState().currentTestName, fixtures: observations }) + '\n',
    );
});
afterAll(() => vi.unstubAllGlobals());

function response(adapter: Adapter, reply: Reply, index: number): Response {
  const tool = 'name' in reply;
  const id = `offline-${index}`;
  const events: Array<Record<string, unknown>> =
    adapter === 'openai'
      ? [
          {
            choices: [
              {
                index: 0,
                delta: tool
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id,
                          type: 'function',
                          function: { name: reply.name, arguments: JSON.stringify(reply.input) },
                        },
                      ],
                    }
                  : { content: reply.text },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
        ]
      : [
          {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              model: 'offline-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: tool
              ? { type: 'tool_use', id, name: reply.name, input: {} }
              : { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: tool
              ? { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) }
              : { type: 'text_delta', text: reply.text },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ];
  const data = events
    .map(
      (event) =>
        `${adapter === 'anthropic' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  return new Response(data + (adapter === 'openai' ? 'data: [DONE]\n\n' : ''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function fixture(
  adapter: Adapter,
  route: Route,
  options: { config?: Partial<AgentConfig>; plugins?: Plugin[] } = {},
) {
  const cwd = await mkdtempProject(join(tmpdir(), 'transport-prefix-'));
  const observer = createTransportPrefixObserver();
  const rows: ReturnType<typeof observer.observe>[] = [];
  captures.push(rows);
  const bodies: Array<Record<string, unknown>> = [];
  const requests: Array<{ request: ChatRequest; role: TransportRole }> = [];
  let currentAuthorization = '';
  const pending = new Map<
    string,
    Array<{ event: RequestEvent; role: TransportRole; actor: string; authorization: string }>
  >();
  const events: AgentEvent[] = [];
  const provider =
    adapter === 'openai'
      ? new OpenAIProvider({ apiKey: 'offline-only-key', baseURL: 'https://offline.invalid' })
      : new AnthropicProvider({
          apiKey: 'offline-only-key',
          apiKeyEnv: 'OFFLINE_ONLY_KEY',
          baseURL: 'https://offline.invalid',
        });
  const expectedBody = (req: ChatRequest) =>
    adapter === 'openai' ? toOpenAIParams(req) : { ...buildAnthropicBody(req).body, stream: true };
  const register = (event: RequestEvent, actor: string) => {
    const role: TransportRole =
      event.purpose === 'judge'
        ? 'judge'
        : event.request.system.startsWith('[agentlab planning')
          ? 'planner'
          : actor === 'root'
            ? 'main'
            : 'child';
    const key = sha256(JSON.stringify(expectedBody(event.request)));
    pending.set(key, [
      ...(pending.get(key) ?? []),
      { event, role, actor, authorization: currentAuthorization },
    ]);
  };
  transport.handle = async (url, init) => {
    // 这个函数没有 realFetch 引用；任何未登记请求都失败关闭。
    expect(String(url)).toMatch(/^https:\/\/offline\.invalid\//);
    expect(typeof init?.body).toBe('string');
    const serialized = init!.body as string;
    const body = JSON.parse(serialized) as Record<string, unknown>;
    // 仅请求关联使用重编码；观测仍使用 SDK 原始 JSON（OpenAI 带缩进）。
    const captured = pending.get(sha256(JSON.stringify(body)))?.shift();
    if (!captured) throw new Error('Unregistered offline SDK body');
    const { event, role, actor, authorization } = captured;
    expect(body).toEqual(JSON.parse(JSON.stringify(expectedBody(event.request))));
    if (role === 'judge')
      expect(JSON.parse(event.request.messages[0].content as string).currentUserRequest.text).toBe(
        authorization,
      );
    if (adapter === 'openai')
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(
        Buffer.byteLength(JSON.stringify(body)),
      );
    const row = observer.observe(serialized, {
      provider: adapter,
      role,
      scopeHash: sha256(JSON.stringify([actor, authorization])),
    });
    rows.push(row);
    bodies.push(body);
    requests.push({ request: event.request, role });
    return response(adapter, route(event.request, role), rows.length);
  };
  const agent = await createAgent(cwd, {
    autoSaveSessions: false,
    plugins: [
      definePlugin({
        manifest: { id: 'test.real-adapter', version: '1.0.0', apiVersion: 1 },
        setup(ctx) {
          ctx.provide.provider('offline-adapter', {
            name: 'offline-adapter',
            capabilities: provider.capabilities,
            stream: provider.stream.bind(provider),
          });
        },
      }),
      ...(options.plugins ?? []),
    ],
    config: {
      provider: 'offline-adapter',
      model: 'deepseek-flash',
      permissionMode: 'auto',
      capabilities: { reviewer: 'model' },
      pluginConfig: { 'agentlab.planning': { mode: 'off' } },
      ...options.config,
    },
  });
  agent.events.onAll((event) => {
    events.push(event);
    if (event.type === 'model_request') register(event, 'root');
    if (event.type === 'subagent_event' && event.detail?.type === 'model_request')
      register(event.detail as RequestEvent, event.agentId);
    if (event.type === 'permission_request') event.resolve({ allow: false });
  });
  cleanups.push(async () => {
    await agent.dispose();
    observer.clear();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    agent,
    cwd,
    rows,
    bodies,
    requests,
    events,
    run(input: string) {
      // 来自本次真实 loop.run 的授权，不从可能被压缩的消息历史推断。
      currentAuthorization = input;
      return agent.loop.run(input);
    },
  };
}

describe.each(['openai', 'anthropic'] as const)('%s SDK最终序列化请求', (adapter) => {
  it('计划更新保持内容前缀；SDK缓存标记变化也如实计入原始公共前缀', async () => {
    let turn = 0;
    const f = await fixture(
      adapter,
      (req, role) => {
        if (role === 'planner')
          return {
            text: JSON.stringify({ goal: '只读', steps: ['读取', '核对'], readOnly: true }),
          };
        expect(role).toBe('main');
        const plan = requestPlan(req);
        switch (turn++) {
          case 0:
          case 3:
            return { name: 'read_file', input: { path: 'sample.txt' } };
          case 1:
          case 4:
            return {
              name: 'plan_update',
              input: {
                revision: plan.revision,
                stepId: plan.steps[turn === 2 ? 0 : 1].id,
                status: 'completed',
                evidence: '已读取实际文件',
              },
            };
          case 2:
            return {
              name: 'plan_update',
              input: { revision: plan.revision, stepId: plan.steps[1].id, status: 'running' },
            };
          default:
            return { text: '已核对' };
        }
      },
      { config: { pluginConfig: { 'agentlab.planning': { mode: 'auto' } } } },
    );
    await writeFile(join(f.cwd, 'sample.txt'), 'EXACT_SAMPLE');
    const result = await f.run('只读取 sample.txt 并核对');
    expect(result.reason).toBe('completed');
    const main = f.rows.filter((row) => row.role === 'main');
    expect(main).toHaveLength(6);
    expect(new Set(main.map((row) => row.parts.system.sha256)).size).toBe(1);
    expect(new Set(main.map((row) => row.parts.tools.sha256)).size).toBe(1);
    for (const row of main.slice(1)) {
      if (adapter === 'openai')
        expect(row.sameScope!.equalLeadingMessages).toBe(row.sameScope!.previousMessageCount);
      const previous = f.bodies[row.sameScope!.previousIndex - 1].messages as unknown[];
      const current = f.bodies[row.index - 1].messages as unknown[];
      expect(withoutCacheAnnotations(current.slice(0, previous.length))).toEqual(
        withoutCacheAnnotations(previous),
      );
      expect(row.sameScope!.bodyPrefixBytes).toBeGreaterThan(0);
    }
    if (adapter === 'anthropic')
      expect(
        main
          .slice(1)
          .some((row) => row.sameScope!.equalLeadingMessages < row.sameScope!.previousMessageCount),
      ).toBe(true);
    expect(f.events.some((e) => e.type === 'permission_request')).toBe(false);
    expect(f.rows.some((row) => row.role === 'judge')).toBe(false);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(JSON.stringify(f.rows)).not.toContain(f.cwd);
    expect(JSON.stringify(f.rows)).not.toContain('EXACT_SAMPLE');
    expect(JSON.stringify(f.rows)).not.toContain('offline-only-key');
  });

  it('恢复与压缩分别观测：恢复保留前缀，压缩真实打断历史前缀但system/tools不变', async () => {
    let turn = 0;
    const f = await fixture(adapter, () =>
      turn++ === 0 ? { name: 'read_file', input: { path: 'sample.txt' } } : { text: '已读取' },
    );
    await writeFile(join(f.cwd, 'sample.txt'), 'RESTORE_SAMPLE');
    await f.run('读取 sample.txt');
    const snapshot = f.agent.loop.exportSession();
    f.agent.loop.importSession(JSON.parse(JSON.stringify(snapshot)));
    await f.run('继续核对');
    const last = f.rows.at(-1)!;
    expect(last.sameScope).toBeNull(); // 新用户输入是新的授权范围。
    const priorMessages = f.bodies[last.adjacent!.previousIndex - 1].messages as unknown[];
    expect(
      withoutCacheAnnotations(
        (f.bodies.at(-1)!.messages as unknown[]).slice(0, priorMessages.length),
      ),
    ).toEqual(withoutCacheAnnotations(priorMessages));
    let compactions = 0;
    let compactTurn = 0;
    const compact = definePlugin({
      manifest: { id: 'test.transport-compact', version: '1.0.0', apiVersion: 1 },
      setup(ctx) {
        ctx.provide.compactor('transport-compact', {
          async compact() {
            return [{ role: 'user', source: 'summary', content: `合成摘要 ${++compactions}` }];
          },
        });
      },
    });
    const c = await fixture(
      adapter,
      () =>
        compactTurn++ === 0
          ? { name: 'read_file', input: { path: 'sample.txt' } }
          : { text: '压缩后核对完成' },
      {
        plugins: [compact],
        config: {
          compactThreshold: 1,
          capabilities: { reviewer: 'model', compactor: 'transport-compact' },
        },
      },
    );
    await writeFile(join(c.cwd, 'sample.txt'), 'COMPACT_SAMPLE');
    expect((await c.run('读取 sample.txt')).reason).toBe('completed');
    expect(c.events.some((event) => event.type === 'compacted')).toBe(true);
    expect(c.rows).toHaveLength(2);
    const [before, after] = c.rows;
    expect(after.sameScope!.equalLeadingMessages).toBe(0);
    expect(after.parts.system.sha256).toBe(before.parts.system.sha256);
    expect(after.parts.tools.sha256).toBe(before.parts.tools.sha256);
    expect(after.parts.messages.sha256).not.toBe(before.parts.messages.sha256);
  });

  it('同授权写入经真实审批和执行；动态输入及历史变化可逐段测量，不伪造批准缓存', async () => {
    let turn = 0;
    const f = await fixture(adapter, (req, role) => {
      if (role === 'judge') {
        expect(req.system).toBe(STRICT_REVIEWER_SYSTEM);
        const evidence = JSON.parse(req.messages[0].content as string);
        expect(evidence.currentUserRequest.text).toContain('严格');
        expect(evidence.operation.input.content).toBe('EXACT');
        return {
          text: JSON.stringify({
            decision: 'allow',
            reasonCode: 'controlled_exact_write',
            reason: '受控模型核对完整输入',
          }),
        };
      }
      if (turn < 2)
        return {
          name: 'write_file',
          input: { path: `${turn++ === 0 ? 'a' : 'b'}.txt`, content: 'EXACT' },
        };
      return { text: '完成' };
    });
    expect((await f.run('只写 a.txt 和 b.txt，内容严格为 EXACT')).reason).toBe('completed');
    for (const name of ['a.txt', 'b.txt'])
      expect(await readFile(join(f.cwd, name), 'utf8')).toBe('EXACT');
    const judge = f.rows.filter((row) => row.role === 'judge');
    expect(judge).toHaveLength(2);
    expect(judge[0].parts.system).toEqual(judge[1].parts.system);
    expect(judge[0].evidence.currentUserRequest).toEqual(judge[1].evidence.currentUserRequest);
    expect(judge[0].evidence.operation.sha256).not.toBe(judge[1].evidence.operation.sha256);
    expect(judge[0].evidence.previousReviews.bytes).toBeLessThan(
      judge[1].evidence.previousReviews.bytes,
    );
    expect(judge[1].sameScope!.previousIndex).toBe(judge[0].index);
    expect(judge[1].adjacent!.previousIndex).not.toBe(judge[0].index);
    expect(f.events.some((e) => e.type === 'permission_request')).toBe(false);
  });

  it('父子工具数组分别观测；受限child只有真实获准工具，不能混进父级样本', async () => {
    let childTurn = 0;
    let parentTurn = 0;
    let agent: Awaited<ReturnType<typeof fixture>>['agent'];
    const f = await fixture(adapter, (req, role) => {
      if (role === 'child') {
        expect(req.tools.map((tool) => tool.name)).toEqual(['read_file']);
        return childTurn++ === 0
          ? { name: 'read_file', input: { path: 'sample.txt' } }
          : { text: '实际读取得到 3' };
      }
      if (parentTurn++ === 0)
        return {
          name: 'agent_spawn',
          input: {
            task: '只读 sample.txt 并核对数字',
            readOnly: true,
            allowedTools: ['read_file'],
          },
        };
      const child = agent.agents.status()[0];
      if (child.runs.at(-1)?.status !== 'completed')
        return {
          name: 'agent_wait',
          input: {
            agentId: child.agentId,
            runId: child.runs.at(-1)!.runId,
            timeoutMs: 2000,
          },
        };
      return { text: '已根据子任务核对 3' };
    });
    agent = f.agent;
    await writeFile(join(f.cwd, 'sample.txt'), 'COUNT = 3');
    expect((await f.run('只委派一次读取 sample.txt 并等候结果')).reason).toBe('completed');
    await f.agent.agents.whenSettled();
    const main = f.rows.filter((row) => row.role === 'main');
    const child = f.rows.filter((row) => row.role === 'child');
    expect(child).toHaveLength(2);
    expect(child[0].parts.tools.sha256).not.toBe(main[0].parts.tools.sha256);
    expect(child[0].sameScope).toBeNull();
    expect(child[1].sameScope!.previousIndex).toBe(child[0].index);
    expect(f.events.some((e) => e.type === 'permission_request')).toBe(false);
    expect(f.rows.some((row) => row.role === 'judge')).toBe(false);
  });
});

it('观测按原始UTF8字节计算，不排序键；仅白名单元数据可输出，超限不截断', () => {
  const observer = createTransportPrefixObserver();
  const scope = { provider: 'openai' as const, role: 'main' as const, scopeHash: sha256('scope') };
  const a = '{"messages":[{"role":"user","content":"秘密甲"}],"model":"offline"}';
  const b = '{"messages":[{"role":"user","content":"秘密乙"}],"model":"offline"}';
  const first = observer.observe(a, { ...scope, secret: 'must-not-leak' } as typeof scope);
  const second = observer.observe(b, scope);
  expect(first.body.bytes).toBe(Buffer.byteLength(a));
  expect(second.sameScope!.bodyPrefixBytes).toBe(commonPrefixBytes(Buffer.from(a), Buffer.from(b)));
  expect(JSON.stringify([first, second])).not.toMatch(/秘密|must-not-leak/);
  const reordered = observer.observe(
    '{"model":"offline","messages":[{"role":"user","content":"秘密乙"}]}',
    scope,
  );
  expect(reordered.body.sha256).not.toBe(second.body.sha256);
  expect(reordered.parts.messages).toEqual(second.parts.messages);
  expect(() => observer.observe('x'.repeat(1024 * 1024 + 1), scope)).toThrow('1MiB');
  expect(() => observer.observe(a, { ...scope, scopeHash: '/private/user/path' })).toThrow('scope');
  observer.clear();
  expect(observer.observe(a, scope).sameScope).toBeNull();
});

it('解析失败和伪造范围对象均只返回固定错误，不回显秘密正文', () => {
  const observer = createTransportPrefixObserver();
  const scope = { provider: 'openai' as const, role: 'main' as const, scopeHash: sha256('scope') };
  const malformed = 'SECRET_PRIVATE_INPUT { invalid json';
  expect(() => observer.observe(malformed, scope)).toThrow(/^Invalid transport JSON$/);
  for (const body of ['null', '[]', '{"messages":[null]}', '{"messages":[{"role":"SECRET"}]}'])
    expect(() => observer.observe(body, scope)).toThrow(
      /^(Invalid transport JSON|Expected JSON messages)$/,
    );
  for (const content of [malformed, 'null', '[]'])
    expect(() =>
      observer.observe(JSON.stringify({ messages: [{ role: 'user', content }] }), {
        ...scope,
        role: 'judge',
      }),
    ).toThrow(/^Invalid reviewer evidence JSON$/);
  const forged = { secret: 'SECRET_PRIVATE_INPUT', toString: () => scope.scopeHash };
  expect(() =>
    observer.observe('{"messages":[]}', { ...scope, scopeHash: forged } as unknown as typeof scope),
  ).toThrow(/^Invalid redacted transport scope$/);
});

it('同范围分组受角色和授权约束；第九范围淘汰最旧范围且保留实际相邻比较', () => {
  const observer = createTransportPrefixObserver();
  const body = '{"messages":[{"role":"user","content":"synthetic"}]}';
  const scope = { provider: 'openai' as const, role: 'main' as const, scopeHash: sha256('scope') };
  observer.observe(body, scope);
  const child = observer.observe(body, { ...scope, role: 'child' });
  expect(child.sameScope).toBeNull();
  expect(child.adjacent!.bodyPrefixBytes).toBe(Buffer.byteLength(body));
  for (let i = 0; i < 7; i++)
    expect(observer.observe(body, { ...scope, scopeHash: sha256(String(i)) }).sameScope).toBeNull();
  const evicted = observer.observe(body, scope);
  expect(evicted.sameScope).toBeNull();
  expect(evicted.adjacent!.previousIndex).toBe(9);
});
