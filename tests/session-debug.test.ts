/** 会话调试端到端回归：隔离 HOME、真实执行器与 FakeProvider，不访问真实模型。 */
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  linkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { observedStream } from '../src/core/provider.js';
import { ResponseTrace, modelErrorCode } from '../src/core/protocol/response-trace.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import { collectStreamAsync } from '../src/core/protocol/types.js';
import { redactedEvent } from '../src/builtin/telemetry-jsonl/index.js';
import { SessionDebugTrace, redactDebug } from '../desktop/worker/debug-trace.js';
import { DesktopController } from '../desktop/worker/controller.js';
let root: string, stateRoot: string;
const controllers: DesktopController[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlab-session-debug-'));
  const home = join(root, 'home');
  mkdirSync(home);
  stateRoot = join(root, 'state');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('AGENTLAB_DEMO_KEY', 'fictional-debug-only-key');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const request = (id: string, extra: Record<string, unknown> = {}): AgentEvent =>
  ({
    type: 'model_request',
    requestId: id,
    provider: 'fake',
    purpose: 'agent',
    modelRole: 'main',
    request: {
      model: 'offline',
      system: '学习系统指令',
      messages: [{ role: 'user', content: '读文件' }],
      tools: [],
      maxTokens: 8192,
    },
    ...extra,
  }) as AgentEvent;
const response = (
  id: string,
  tools: Array<{ id: string; name: string; arguments: string }> = [],
): AgentEvent => ({
  type: 'model_response',
  requestId: id,
  response: {
    status: 'completed',
    text: '## 结果\n\n已完成',
    thinking: '服务返回的思考',
    tools,
    chunks: 5,
    truncated: false,
    stopReason: 'end_turn',
  },
});

it('每个模型请求都有独立响应与用量；失败不冒充成功，默认 telemetry 不泄漏正文', async () => {
  for (const fail of [false, true]) {
    const events = new EventBus(),
      seen: AgentEvent[] = [];
    events.onAll((e) => seen.push(e));
    const provider = new FakeProvider([
      () => {
        if (fail) throw new Error('sensitive-provider-message');
        return textResponse('模型正文');
      },
    ]);
    const stream = collectStreamAsync(
      observedStream(
        provider,
        { model: 'fake', system: 'S', messages: [], tools: [] },
        new AbortController().signal,
        { events, purpose: 'agent' },
      ),
    );
    if (fail) await expect(stream).rejects.toThrow('sensitive-provider-message');
    else await stream;
    const start = seen.find((e) => e.type === 'model_request')!,
      end = seen.find((e) => e.type === 'model_response')!;
    expect(start.type === 'model_request' && end.type === 'model_response' && start.requestId).toBe(
      end.type === 'model_response' && end.requestId,
    );
    expect(end.type === 'model_response' && end.response.status).toBe(fail ? 'error' : 'completed');
    expect(seen.filter((e) => e.type === 'model_usage')).toHaveLength(1);
    expect(JSON.stringify(redactedEvent(end))).not.toMatch(/模型正文|sensitive-provider-message/);
  }
});
it('取消保留已收到的部分响应，工具参数按调用 ID 关联', async () => {
  const events = new EventBus(),
    seen: AgentEvent[] = [];
  events.onAll((e) => seen.push(e));
  const abort = new AbortController();
  const provider = {
    name: 'fixture',
    capabilities: { thinking: true, streaming: true },
    async *stream() {
      yield { type: 'message_start' } as const;
      yield { type: 'text_delta', text: '部分响应' } as const;
      abort.abort();
      throw new Error('aborted');
    },
  };
  await expect(
    collectStreamAsync(
      observedStream(
        provider,
        { model: 'fake', system: '', messages: [], tools: [] },
        abort.signal,
        { events, purpose: 'agent' },
      ),
    ),
  ).rejects.toThrow();
  expect(seen.find((e) => e.type === 'model_response')).toMatchObject({
    response: { status: 'aborted', text: '部分响应' },
  });
  const toolEvents = new EventBus(),
    toolSeen: AgentEvent[] = [];
  toolEvents.onAll((e) => toolSeen.push(e));
  await collectStreamAsync(
    observedStream(
      new FakeProvider([
        toolUseResponse([{ name: 'read_file', input: { path: 'README.md' }, id: 'tool-one' }]),
      ]),
      { model: 'fake', system: '', messages: [], tools: [] },
      new AbortController().signal,
      { events: toolEvents, purpose: 'agent' },
    ),
  );
  expect(toolSeen.find((e) => e.type === 'model_response')).toMatchObject({
    response: { tools: [{ id: 'tool-one', name: 'read_file', arguments: '{"path":"README.md"}' }] },
  });
});
it('调试输出有明确边界，错误只保留标准代码，不读取 SDK 错误正文', () => {
  const trace = new ResponseTrace();
  trace.push({ type: 'text_delta', text: 'a'.repeat(1_000_001) });
  expect(trace.finish()).toMatchObject({ status: 'interrupted', truncated: true });
  expect(trace.finish().text).toHaveLength(1_000_000);
  expect(modelErrorCode({ status: 401, message: 'sensitive-key' })).toBe('http_401');
  expect(modelErrorCode({ code: 'sensitive-key' })).toBe('provider_error');
  expect(
    modelErrorCode({
      get status() {
        throw new Error('getter');
      },
    }),
  ).toBe('provider_error');
});
it('结构字段、工具 JSON、环境文本和 URL 凭据脱敏，不修改原始内容', () => {
  const raw = {
    DEEPSEEK_API_KEY: 'private-six',
    apiKey: 'private-one',
    nested: '{"Authorization":"Bearer private-two","path":"src/a.ts"}',
    text: 'DEEPSEEK_API_KEY=private-three\nhttps://user:password@test.local/v1?token=private-four',
    env: { KEY: 'private-five' },
    model: 'fake',
  };
  const result = JSON.stringify(redactDebug(raw));
  expect(result).not.toMatch(
    /private-one|private-two|private-three|private-four|private-five|private-six|user:password/,
  );
  expect(result).toContain('src/a.ts');
  expect(raw.apiKey).toBe('private-one');
});
it('乱序并发请求的工具审计不串线；重启恢复和分页可查看所有请求并导出', () => {
  const trace = new SessionDebugTrace();
  trace.configure(stateRoot, 'session-one');
  const a = randomUUID(),
    b = randomUUID();
  trace.record(request(a));
  trace.record(request(b));
  trace.record(response(a, [{ id: 'tool-a', name: 'read_file', arguments: '{}' }]));
  trace.record(response(b, [{ id: 'tool-b', name: 'read_file', arguments: '{}' }]));
  trace.record({
    type: 'tool_result',
    toolUseId: 'tool-a',
    name: 'read_file',
    result: { content: 'only-a' },
  });
  trace.record({
    type: 'tool_result',
    toolUseId: 'tool-b',
    name: 'read_file',
    result: { content: 'only-b' },
  });
  for (let i = 0; i < 45; i++) {
    const id = randomUUID();
    trace.record(request(id));
    trace.record(response(id));
  }
  trace.select(1, 0, a);
  const detail = JSON.stringify(trace.snapshot().detail);
  expect(detail).toContain('only-a');
  expect(detail).not.toContain('only-b');
  expect(trace.snapshot().totalRequests).toBe(47);
  expect(trace.snapshot().requests).toHaveLength(7);
  trace.select(0, 0, undefined, undefined, { query: a });
  expect(trace.snapshot().filteredRequests).toBe(1);
  expect(trace.snapshot().requests[0].id).toBe(a);
  trace.select(0, 0, undefined, undefined, { order: 'oldest' });
  expect(trace.snapshot().requests[0].id).toBe(a);
  trace.select(0, 0, undefined, undefined, {});
  const restored = new SessionDebugTrace();
  restored.configure(stateRoot, 'session-one');
  expect(restored.snapshot().totalRequests).toBe(47);
  restored.select(1, 0, a);
  expect(JSON.stringify(restored.snapshot().detail)).toContain('only-a');
  restored.exportReport();
  const report = restored.snapshot().report!.markdown;
  expect(report).toContain('请求 47');
  expect(report).toContain('only-a');
  expect(report).toContain('完整会话时间线');
});
it('未结束请求恢复为中断，会话切换不泄漏旧详情，旧记录不被重放执行', () => {
  const trace = new SessionDebugTrace(),
    id = randomUUID();
  trace.configure(stateRoot, 'old-session');
  trace.record(request(id));
  trace.configure(stateRoot, 'old-session');
  expect(trace.snapshot().requests[0].status).toBe('interrupted');
  trace.configure(stateRoot, 'new-session');
  expect(trace.snapshot().totalRequests).toBe(0);
  expect(() => trace.select(0, 0, id)).toThrow(/不属于/);
  trace.configure(stateRoot, 'old-session');
  expect(trace.snapshot().totalRequests).toBe(1);
});
it('子 Agent 请求与审批模型请求保留身份和关联', () => {
  const trace = new SessionDebugTrace();
  trace.configure(stateRoot, 'session');
  const parent = randomUUID(),
    judge = randomUUID(),
    child = randomUUID();
  trace.record(request(parent));
  trace.record(response(parent, [{ id: 'tool-one', name: 'bash', arguments: '{}' }]));
  trace.record(request(judge, { modelRole: 'judge', purpose: 'judge', toolCallId: 'tool-one' }));
  trace.record(response(judge));
  trace.record({
    type: 'subagent_event',
    agentId: randomUUID(),
    runId: randomUUID(),
    name: '学习助手',
    seq: 1,
    kind: 'status',
    status: 'running',
    activity: '等待模型',
    detail: request(child),
  } as unknown as AgentEvent);
  trace.select(0, 0, parent);
  expect(trace.snapshot().detail?.entries.some((e) => e.requestId === judge)).toBe(true);
  expect(trace.snapshot().requests.find((r) => r.id === child)?.agent).toBe('学习助手');
});
it('损坏尾部与不安全文件只暂停调试，不覆盖已有记录或中止 Agent', () => {
  const trace = new SessionDebugTrace();
  trace.configure(stateRoot, 'session');
  trace.record(request(randomUUID()));
  const file = join(stateRoot, 'debug/session.jsonl');
  appendFileSync(file, '{incomplete');
  trace.configure(stateRoot, 'session');
  expect(trace.snapshot().warning).toBeTruthy();
  expect(trace.snapshot().totalRequests).toBe(1);
  const before = readFileSync(file, 'utf8');
  trace.record(response(randomUUID()));
  expect(readFileSync(file, 'utf8')).toBe(before);
  const target = join(root, 'outside');
  writeFileSync(target, 'unchanged');
  linkSync(target, join(stateRoot, 'debug/unsafe.jsonl'));
  trace.configure(stateRoot, 'unsafe');
  expect(trace.snapshot().warning).toBeTruthy();
  trace.input('never append');
  expect(readFileSync(target, 'utf8')).toBe('unchanged');
});
it('桌面真实工具循环在执行中可读调试，仍须批准；保存后恢复原请求详情', async () => {
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# 学习项目\n');
  const controller = new DesktopController(() => {});
  controllers.push(controller);
  await controller.initialize(project, true, randomUUID());
  const send = (payload: Record<string, unknown>) =>
    controller.handle({
      ...payload,
      generation: controller.snapshot!.generation,
      sessionId: controller.snapshot!.sessionId,
    });
  await send({ type: 'submit', text: '离线学习', invocationId: randomUUID() });
  await vi.waitFor(() => expect(controller.snapshot!.approvals).toHaveLength(1), { timeout: 8000 });
  const approval = controller.snapshot!.approvals[0];
  const summary = controller.snapshot!.debug!;
  expect(summary.totalRequests).toBeGreaterThan(0);
  expect(summary.detail).toBeUndefined();
  await send({ type: 'debug-read', page: 0, eventPage: 0, requestId: summary.requests[0].id });
  expect(controller.snapshot!.approvals).toHaveLength(1);
  expect(
    controller.snapshot!.debug!.detail!.entries.some(
      (entry) => entry.type === 'permission_request',
    ),
  ).toBe(true);
  await send({ type: 'approve', approvalId: approval.id, allow: true });
  await vi.waitFor(() => expect(controller.snapshot!.busy).toBe(false), { timeout: 8000 });
  const sessionId = controller.snapshot!.sessionId,
    count = controller.snapshot!.debug!.totalRequests;
  expect(controller.snapshot!.debug!.requests.every((r) => r.status === 'completed')).toBe(true);
  await send({ type: 'resume', id: sessionId });
  await vi.waitFor(() => expect(controller.snapshot!.busy).toBe(false), { timeout: 8000 });
  expect(controller.snapshot!.debug!.totalRequests).toBe(count);
  await send({ type: 'debug-export' });
  expect(controller.snapshot!.debug!.report!.markdown).toContain('工具执行管线');
});
