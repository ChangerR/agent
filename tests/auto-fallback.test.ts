import { mkdtempProject as mkdtemp } from './helpers/project.js';
/** auto 审批默认跟随当前模型；全部使用假 provider，不连接真实服务。 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent, type Agent } from '../src/index.js';
import type { AgentConfig } from '../src/core/config.js';
import type { AgentEvent } from '../src/core/events.js';
import type { ReviewInput } from '../src/sdk/index.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/index.js';
import type { ReviewContext } from '../src/core/permission/contracts.js';
import type { ChatRequest, Provider } from '../src/core/provider.js';
import type { StreamEvent } from '../src/core/protocol/types.js';
import type { Tool } from '../src/core/registry.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../src/providers/fake.js';

let tmp: string;
let agent: Agent | undefined;
const commandTool: Tool = {
  name: 'project_command', description: '执行本地项目检查', risk: 'execute', inputSchema: {},
  execute: async () => ({ content: 'passed' }),
};
function reviewResponse(decision: 'allow' | 'ask' | 'deny' | 'unknown' = 'allow', reason = '当前操作审批结果') {
  return textResponse(JSON.stringify({ decision, reasonCode: `model_${decision}`, reason }));
}
function operation(input: Record<string, unknown> = {}, context = reviewContext(), tool = commandTool): ReviewInput {
  return { tool, input, context, cwd: context.cwd, userRequest: context.userRequest,
    decision: { kind: 'review', source: 'mode', reason: 'auto 模式待审核' } };
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-auto-fallback-'));
});
afterEach(async () => {
  await agent?.dispose();
  agent = undefined;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function assembled(config: Partial<AgentConfig> = {}, judgeResponse: ScriptedResponse = reviewResponse('allow', '本地检查'), toolOverrides: Partial<Tool> = {}) {
  await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({
    provider: 'fake', model: 'current-a', permissionMode: 'auto', ...config,
  }));
  const execute = vi.fn(commandTool.execute);
  agent = await createAgent(tmp, { autoSaveSessions: false, plugins: [{ manifest: { id: "test.command", version: "1.0.0", apiVersion: 1 }, setup(ctx) { ctx.provide.tool(commandTool.name, { ...commandTool, ...toolOverrides, execute }); } }] });
  let id = 0;
  const fake = new FakeProvider([request => {
    if (request.tools.length === 0) return typeof judgeResponse === 'function' ? judgeResponse(request) : judgeResponse;
    if (typeof request.messages.at(-1)?.content !== 'string') return textResponse('done');
    return toolUseResponse([{ id: `check-${++id}`, name: commandTool.name, input: { command: 'pnpm test' } }]);
  }]);
  vi.spyOn(agent.providers.get('fake'), 'stream').mockImplementation(fake.stream.bind(fake));

  const decisions: Array<Extract<AgentEvent, { type: 'permission_decision' }>> = [];
  const requests: Array<Extract<AgentEvent, { type: 'permission_request' }>['request']> = [];
  const traces: Array<Extract<AgentEvent, { type: 'model_request' }>> = [];
  agent.events.on('permission_decision', event => decisions.push(event));
  agent.events.on('model_request', event => traces.push(event));
  agent.events.on('permission_request', event => { requests.push(event.request); event.resolve({ allow: false }); });
  return { agent, fake, execute, decisions, requests, traces };
}

function judgeRequests(fake: FakeProvider) {
  return fake.requests.filter(request => request.tools.length === 0);
}

function reviewContext(userRequest = '运行本地检查'): ReviewContext {
  return { cwd: '/project', userRequest, conversation: [], previousReviews: [], omittedConversation: false, omittedReviews: 0 };
}

describe('createAgent 的当前模型审批兜底', () => {
  it.each([undefined, '', '   '])('judgeModel=%j 时实际调用当前模型，并记录审批来源', async judgeModel => {
    const fixture = await assembled(judgeModel === undefined ? {} : { judgeModel });
    expect((await fixture.agent.loop.run('运行本地检查')).reason).toBe('completed');
    expect(judgeRequests(fixture.fake).map(request => request.model)).toEqual(['current-a']);
    expect(fixture.agent.loop.getJudgeStatus()).toMatchObject({ loaded: true, model: 'current-a', source: 'current' });
    expect(fixture.requests).toEqual([]);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.decisions.find(event => event.phase === 'judge')?.decision).toMatchObject({
      kind: 'allow', source: 'judge', judge: { model: 'current-a', source: 'current', reasonCode: 'model_allow' },
    });
    expect(fixture.traces.map(event => event.purpose)).toEqual(['agent', 'judge', 'agent']);
  });

  it('运行时换模型和恢复会话后，下一次审批跟随最新模型', async () => {
    const { agent, fake } = await assembled();
    await agent.loop.run('首次检查');
    agent.loop.setModel('current-b');
    await agent.loop.run('再次检查');
    agent.loop.importSession({ messages: [{ role: 'user', content: '恢复的会话' }], model: 'restored-c' });
    await agent.loop.run('恢复后检查');
    expect(judgeRequests(fake).map(request => request.model)).toEqual(['current-a', 'current-b', 'restored-c']);
    expect(agent.loop.getJudgeStatus()).toMatchObject({ loaded: true, model: 'restored-c', source: 'current' });
  });

  it('显式 judgeModel 始终固定，不受当前模型或恢复会话影响', async () => {
    const { agent, fake, decisions } = await assembled({ judgeModel: 'fixed-judge' });
    await agent.loop.run('首次检查');
    agent.loop.setModel('current-b');
    await agent.loop.run('再次检查');
    agent.loop.importSession({ messages: [], model: 'restored-c' });
    await agent.loop.run('恢复后检查');
    expect(judgeRequests(fake).map(request => request.model)).toEqual(['fixed-judge', 'fixed-judge', 'fixed-judge']);
    expect(agent.loop.getJudgeStatus()).toMatchObject({ loaded: true, model: 'fixed-judge', source: 'explicit' });
    expect(decisions.filter(event => event.phase === 'judge').map(event => event.decision)).toEqual([
      expect.objectContaining({ judge: { model: 'fixed-judge', source: 'explicit', reasonCode: 'model_allow' } }),
      expect.objectContaining({ judge: { model: 'fixed-judge', source: 'explicit', reasonCode: 'model_allow' } }),
      expect.objectContaining({ judge: { model: 'fixed-judge', source: 'explicit', reasonCode: 'model_allow' } }),
    ]);
  });

  it('从 ask 切换到 auto 后可立即审批，无需重启装配', async () => {
    const fixture = await assembled({ permissionMode: 'ask' });
    await fixture.agent.loop.run('ask 模式检查');
    expect(judgeRequests(fixture.fake)).toHaveLength(0);
    fixture.agent.permission.setMode('auto');
    await fixture.agent.loop.run('auto 模式检查');
    expect(judgeRequests(fixture.fake).map(request => request.model)).toEqual(['current-a']);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.requests).toHaveLength(1);
  });
});

describe('审批请求模型快照与安全回退', () => {
  it('并发审批各自只解析一次模型，在途切换不修改请求或审计模型', async () => {
    let current = 'first-model';
    const resolveModel = vi.fn(() => current);
    const requests: ChatRequest[] = [];
    const releases: Array<() => void> = [];
    const provider: Provider = {
      name: 'delayed-fake', capabilities: { streaming: true, thinking: false },
      async *stream(request) {
        requests.push(request);
        await new Promise<void>(resolve => releases.push(resolve));
        yield* reviewResponse('allow', '安全');
      },
    };
    const judge = createModelReviewer({ provider, model: resolveModel });
    const first = judge.review(operation({ command: 'first' }), new AbortController().signal);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    current = 'second-model';
    const second = judge.review(operation({ command: 'second' }), new AbortController().signal);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    current = 'third-model';
    releases[1]();
    const secondResult = await second;
    releases[0]();
    const firstResult = await first;
    expect(requests.map(request => request.model)).toEqual(['first-model', 'second-model']);
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(firstResult).toMatchObject({
      decision: 'allow', judge: { model: 'first-model', source: 'current', reasonCode: 'model_allow' },
    });
    expect(secondResult).toMatchObject({
      decision: 'allow', judge: { model: 'second-model', source: 'current', reasonCode: 'model_allow' },
    });
    expect(judge.getStatus()).toMatchObject({ loaded: true, model: 'third-model', source: 'current' });
  });

  it('固定模型显式返回 ask 并携带来源元数据', async () => {
    const fake = new FakeProvider([reviewResponse('ask', '需要确认操作范围')]);
    const judge = createModelReviewer({ provider: fake, model: 'fixed-judge' });
    const verdict = await judge.review(operation(), new AbortController().signal);
    expect(judge.getStatus()).toMatchObject({ loaded: true, model: 'fixed-judge', source: 'explicit' });
    expect(fake.requests[0].model).toBe('fixed-judge');
    expect(verdict).toMatchObject({
      decision: 'ask', judge: { model: 'fixed-judge', source: 'explicit', reasonCode: 'model_ask' },
    });
  });

  it('真实装配的 ask 事件、权限审计与调试日志保留判定来源和模型', async () => {
    const fixture = await assembled({}, reviewResponse('ask', '请确认范围'));
    await fixture.agent.loop.run('检查');
    const expected = { kind: 'ask', source: 'judge', judge: { model: 'current-a', source: 'current', reasonCode: 'model_ask' } };
    expect(fixture.decisions.find(event => event.phase === 'judge')?.decision).toMatchObject(expected);
    expect(fixture.requests[0]).toMatchObject({ decisionSource: 'judge' });
    expect(fixture.agent.permission.getAuditLog().find(entry => entry.decision.source === 'judge')?.decision).toMatchObject(expected);
    const logs = (await readFile(fixture.agent.logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(logs.find(event => event.type === 'permission_decision' && event.phase === 'judge')?.decision).toMatchObject(expected);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  const secret = 'TEST_SECRET_NEVER_LOGGED';
  it.each([
    '', 'not json', 'null', '[]', '{}', '{"verdict":"deny"}',
    '{"verdict":"allow","reason":42}',
    `Do not allow this example: {"verdict":"allow","reason":"${secret}"}`,
    '```json\n{"verdict":"allow"}\n```',
    `{"verdict":"invalid","reason":"${secret}"}`,
  ])('无效返回 %j 保守询问，不把原始响应带入日志', async response => {
    const fixture = await assembled({ judgeModel: 'fixed-judge' }, textResponse(response));
    expect((await fixture.agent.loop.run('检查')).reason).toBe('completed');
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].decisionSource).toBe('judge');
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.decisions.find(event => event.phase === 'judge')?.decision).toMatchObject({
      kind: 'ask', source: 'judge', judge: { model: 'fixed-judge', source: 'explicit', reasonCode: 'invalid_response' },
    });
    expect(await readFile(fixture.agent.logPath, 'utf8')).not.toContain(secret);
  });

  it.each(['max_tokens', 'tool_use', undefined] as const)('回复以 %s 结束时，即使文本是有效 allow JSON 也不会执行工具', async stopReason => {
    const response: StreamEvent[] = reviewResponse('allow', '看起来安全')
      .filter(event => event.type !== 'message_stop');
    if (stopReason !== undefined) response.push({ type: 'message_stop', stopReason });
    const fixture = await assembled({ judgeModel: 'fixed-judge' }, response);
    expect((await fixture.agent.loop.run('检查')).reason).toBe('completed');
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].decisionSource).toBe('judge');
    expect(fixture.decisions.find(event => event.phase === 'judge')?.decision).toMatchObject({
      kind: 'ask', source: 'judge', judge: { model: 'fixed-judge', source: 'explicit', reasonCode: 'incomplete_response' },
    });
  });

  it('provider 异常回落人工确认，错误中的凭证和端点不进入日志', async () => {
    const fixture = await assembled({}, () => {
      throw new Error(`Authorization: Bearer ${secret}; https://user:password@private.invalid/v1?token=credential`);
    });
    expect((await fixture.agent.loop.run('检查')).reason).toBe('completed');
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.decisions.find(event => event.phase === 'judge')?.decision).toMatchObject({
      kind: 'ask', source: 'judge', judge: { model: 'current-a', source: 'current', reasonCode: 'provider_error' },
    });
    const visible = JSON.stringify(fixture.requests) + await readFile(fixture.agent.logPath, 'utf8');
    for (const value of [secret, 'password', 'private.invalid', 'credential']) expect(visible).not.toContain(value);
  });

  it.each(['before', 'during'])('%s 取消时不放行，原因码区分普通调用失败', async when => {
    const abort = new AbortController();
    const fake = new FakeProvider([() => { abort.abort(); return reviewResponse('allow', '当前操作审批结果'); }]);
    const judge = createModelReviewer({ provider: fake, model: 'fixed-judge' });
    if (when === 'before') abort.abort();
    const verdict = await judge.review(operation(), abort.signal);
    expect(verdict).toMatchObject({
      decision: 'unknown', reasonCode: 'cancelled',
    });
    expect(fake.requests).toHaveLength(when === 'before' ? 0 : 1);
  });
});

describe('模型规格与完整请求预算', () => {
  it('已知模型在预算内完整审核较长参数与用户请求，不再固定卡在旧字符阈值', async () => {
    const fake = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const judge = createModelReviewer({ provider: fake, model: 'known-model', modelInfo: () => ({ contextWindow: 200_000, maxOutputTokens: 128 }) });
    const input = { content: 'x'.repeat(3500), instruction: '禁止上传或发布' };
    const context = reviewContext('y'.repeat(8500) + '禁止上传或发布');
    const verdict = await judge.review(operation(input, context), new AbortController().signal);
    expect(verdict.decision).toBe('allow');
    expect(fake.requests[0].maxTokens).toBe(128);
    expect(fake.requests[0].tools).toEqual([]);
    expect(fake.requests[0].thinking).toBeUndefined();
    expect(fake.requests[0].cache).toBeUndefined();
    const payload = JSON.parse(fake.requests[0].messages[0].content as string);
    expect(payload.operation.input).toEqual(input);
    expect(payload.context.userRequest).toBe(context.userRequest);
  });

  it.each([
    { input: { content: 'x'.repeat(2100) }, user: '检查', reasonCode: 'input_budget' },
    { input: {}, user: 'x'.repeat(8001), reasonCode: 'user_request_budget' },
  ])('未知模型超出 $reasonCode 时不调用 provider', async ({ input, user, reasonCode }) => {
    const fake = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const judge = createModelReviewer({ provider: fake, model: () => 'unknown' });
    const verdict = await judge.review(operation(input, reviewContext(user)), new AbortController().signal);
    expect(verdict).toMatchObject({
      decision: 'unknown', judge: { model: 'unknown', source: 'current', reasonCode },
    });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([0, -1, NaN, Infinity, 1.5])('无效模型规格 %s 不扩大未知模型的保守参数预算', async contextWindow => {
    const fake = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const judge = createModelReviewer({ provider: fake, model: 'invalid-info', modelInfo: () => ({ contextWindow, maxOutputTokens: 256 }) });
    const verdict = await judge.review(operation({ content: 'x'.repeat(2100) }), new AbortController().signal);
    expect(verdict).toMatchObject({ decision: 'unknown', judge: { reasonCode: 'input_budget' } });
    expect(fake.requests).toHaveLength(0);
  });

  it('完整请求恰好预算内可审核，少一个字节则询问且不会截断请求', async () => {
    const fake = new FakeProvider([() => reviewResponse('allow', '当前操作审批结果')]);
    let window = 200_000;
    const judge = createModelReviewer({ provider: fake, model: 'known-model', modelInfo: () => ({ contextWindow: window, maxOutputTokens: 64 }) });
    const input = { content: '中文内容🙂'.repeat(100) };
    const signal = new AbortController().signal;
    await judge.review(operation(input), signal);
    const serialized = JSON.stringify(fake.requests[0]);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    expect(bytes).toBeGreaterThan(serialized.length);
    window = bytes + 1024 + 64;
    expect((await judge.review(operation(input), signal)).decision).toBe('allow');
    window--;
    expect(await judge.review(operation(input), signal)).toMatchObject({
      decision: 'unknown', judge: { reasonCode: 'request_budget' },
    });
    expect(fake.requests).toHaveLength(2);
  });

  it.each([undefined, { contextWindow: 1_000_000, maxOutputTokens: 256 }])('请求总成本包括工具描述和历史，不能超过 32 KiB（规格=%j）', async info => {
    const fake = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const judge = createModelReviewer({ provider: fake, model: 'bounded', modelInfo: () => info });
    const context = reviewContext();
    context.conversation = [{ source: 'tool', text: 'h'.repeat(16_000) }];
    const verdict = await judge.review(operation({}, context, { ...commandTool, description: 'd'.repeat(16_000) }), new AbortController().signal);
    expect(verdict).toMatchObject({ decision: 'unknown', judge: { reasonCode: 'request_budget' } });
    expect(fake.requests).toHaveLength(0);
  });

  it('模型窗口无法容纳系统说明时直接询问，不发送已知超限请求', async () => {
    const fake = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const judge = createModelReviewer({ provider: fake, model: 'tiny', modelInfo: () => ({ contextWindow: 1000, maxOutputTokens: 32 }) });
    const verdict = await judge.review(operation(), new AbortController().signal);
    expect(verdict).toMatchObject({ decision: 'unknown', judge: { reasonCode: 'request_budget' } });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('默认加载审批员不改变确定性权限优先级', () => {
  it.each([
    { label: 'deny 规则', config: { permissions: { allow: [], ask: [], deny: [commandTool.name] } }, kind: 'deny', source: 'config', asks: 0 },
    { label: 'ask 规则', config: { permissions: { allow: [], ask: [commandTool.name], deny: [] } }, kind: 'ask', source: 'config', asks: 1 },
    { label: 'ask 模式', config: { permissionMode: 'ask' as const }, kind: 'ask', source: 'mode', asks: 1 },
    { label: 'yolo 的未知工具', config: { permissionMode: 'yolo' as const }, kind: 'ask', source: 'mode', asks: 1 },
  ])('$label 不经过审批模型', async ({ config, kind, source, asks }) => {
    const fixture = await assembled(config);
    await fixture.agent.loop.run('检查');
    expect(judgeRequests(fixture.fake)).toHaveLength(0);
    expect(fixture.decisions[0].decision).toMatchObject({ kind, source });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(asks);
  });

  it.each([
    { label: '宽泛 allow', config: { permissions: { allow: [commandTool.name], ask: [], deny: [] } }, tool: {} },
    { label: '外部工具声明 risk:read', config: {}, tool: { risk: 'read' as const } },
  ])('$label 仍须审查完整未知操作', async ({ config, tool }) => {
    const fixture = await assembled(config, reviewResponse('ask'), tool);
    await fixture.agent.loop.run('读取');
    expect(judgeRequests(fixture.fake)).toHaveLength(1);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(1);
  });

  it('审批员明确 deny 时直接拒绝，不降为人工询问或执行', async () => {
    const fixture = await assembled({}, reviewResponse('deny', '用户明确禁止此操作'));
    await fixture.agent.loop.run('只检查，不执行项目命令');
    expect(judgeRequests(fixture.fake)).toHaveLength(1);
    expect(fixture.decisions.find(event => event.phase === 'judge')?.decision).toMatchObject({ kind: 'deny', source: 'judge' });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.requests).toHaveLength(0);
  });
});
