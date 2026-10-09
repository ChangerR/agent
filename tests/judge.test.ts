/**
 * 模型审批员集成测试：确定性策略只委托未决操作，所有批准仍经过执行门。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextManager } from '../src/core/context/coordinator.js';
import { SummaryCompactor } from '../src/builtin/compaction-summary/implementation.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { createJsonlTelemetry } from '../src/builtin/telemetry-jsonl/index.js';
import { AgentLoop } from '../src/core/loop.js';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/index.js';
import type { Reviewer } from '../src/sdk/index.js';
import { ReviewHistory } from '../src/builtin/reviewer-model/review-context.js';
import type { ChatRequest } from '../src/core/provider.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { builtinToolDefinitions } from '../src/tools/index.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-judge-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

function makeLoop(opts: { script: ScriptedResponse[]; reviewer?: Reviewer; events?: EventBus }) {
  const events = opts.events ?? new EventBus();
  const tools = new ToolRegistry();
  const hooks = new HookRunner();
  for (const tool of builtinToolDefinitions) tools.register({ ...tool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
  const policy = createDeterministicPolicy({ cwd: tmp, mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
  const permission = policy.controller!;
  const context = new ContextManager({ compactThreshold: 1_000_000, compactor: new SummaryCompactor() });
  const loop = new AgentLoop({
    provider: new FakeProvider(opts.script),
    model: 'fake',
    tools,
    policy,
    hooks,
    events,
    context,
    systemPrompt: 'test',
    maxTurns: 10,
    cwd: tmp,
    reviewer: opts.reviewer,
  });
  return { loop, events, permission, tools, hooks, context };
}

function reviewResponse(decision: 'allow' | 'ask' | 'deny' | 'unknown', reason = '当前操作审批结果') {
  return textResponse(JSON.stringify({ decision, reasonCode: `model_${decision}`, reason }));
}

function payload(request: ChatRequest) {
  return JSON.parse(request.messages[0].content as string) as {
    operation: { input: Record<string, unknown> };
    context: ReturnType<ReviewHistory['build']>;
  };
}

// 命令审批测试只模拟工具执行，不运行真实 shell。
const commandTool: Tool = {
  name: 'command', description: '运行项目命令', risk: 'execute', inputSchema: {},
  execute: async () => ({ content: 'tests passed' }),
};

describe('LLM 审批员', () => {
  it('PR 任务把普通推送、创建及语法重试连起来审核，自动放行静默但日志完整', async () => {
    const branch = 'fix/session-metadata-durability-concurrency';
    const createPrefix = `$title = '会话修复'\n$body = '补回会话修复'\n`;
    const commands = [
      `cmd /c "git push -u origin ${branch} 2>&1"`,
      `${createPrefix}cmd /c "gh pr create --base master --head ${branch} --title $title --body-file -" <<< $body`,
      `${createPrefix}gh pr create --base master --head ${branch} --title $title --body $body`,
    ];
    const judgeProvider = new FakeProvider([req => {
      // 假审批员只验证任务上下文的传递，不调用真实模型或 GitHub。
      const context = payload(req).context;
      return reviewResponse(context.userRequest === '可以帮我新建一条pr吗' ? 'allow' : 'ask');
    }]);
    const { loop, tools, events } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      ...commands.map((command, i) => toolUseResponse([{ id: `pr-${i}`, name: 'bash', input: { command } }])),
      textResponse('PR created'),
    ] });
    vi.spyOn(tools.get('bash')!, 'execute').mockImplementation(async (input) => input.command === commands[1]
      ? { content: 'ParserError: MissingFileSpecification; command did not execute', isError: true }
      : { content: input.command === commands[0] ? 'new branch pushed' : 'PR created' });
    const decisions: Array<Extract<AgentEvent, { type: 'permission_decision' }>> = [];
    const notices: string[] = [];
    let asks = 0;
    events.on('permission_decision', (e) => decisions.push(e));
    events.on('notice', (e) => notices.push(e.text));
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: false }); });
    const logPath = join(tmp, 'permission-events.jsonl');
    const telemetry = createJsonlTelemetry({ path: logPath, includeBodies: true });
    events.onAll(event => { void telemetry.onEvent(event); });
    expect((await loop.run('可以帮我新建一条pr吗')).reason).toBe('completed');
    expect(asks).toBe(0);
    expect(notices).toEqual([]);
    expect(decisions.map((e) => e.phase)).toEqual(['pipeline', 'judge', 'pipeline', 'judge', 'pipeline', 'judge']);
    const retryContext = payload(judgeProvider.requests[2]).context;
    expect(retryContext.previousReviews.find((entry) => entry.input?.command === commands[1])).toMatchObject({ sameOperation: false, outcome: 'error' });
    expect(judgeProvider.requests[0].system).toContain('sameOperation、一次模型 allow、一次人工同意、成功或失败都不能自动变成此次授权');
    const logged = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(logged.filter((e) => e.type === 'permission_decision')).toMatchObject(JSON.parse(JSON.stringify(decisions)));
  });

  it('人工允许的 PR 创建因语法失败后重试，仍带上原批准和失败证据', async () => {
    const original = 'gh pr create --head fix/session --body-file - <<< $body';
    const retry = 'gh pr create --head fix/session --body $body';
    const judgeProvider = new FakeProvider([reviewResponse('ask', '当前操作审批结果'), reviewResponse('allow', '当前操作审批结果')]);
    const { loop, tools, events } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'original', name: 'bash', input: { command: original } }]),
      toolUseResponse([{ id: 'retry', name: 'bash', input: { command: retry } }]), textResponse('ok'),
    ] });
    vi.spyOn(tools.get('bash')!, 'execute').mockImplementation(async (input) => input.command === original ? { content: 'shell syntax error; no remote operation', isError: true } : { content: 'PR created' });
    let asks = 0;
    const phases: string[] = [];
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: true }); });
    events.on('permission_decision', (e) => phases.push(`${e.phase}:${e.decision.kind}`));
    await loop.run('创建这个 PR');
    expect(asks).toBe(1);
    expect(payload(judgeProvider.requests[1]).context.previousReviews[0]).toMatchObject({
      sameOperation: false, input: { command: original }, outcome: 'error', decision: { kind: 'allow', source: 'user' },
    });
    expect(phases).toEqual(['pipeline:ask', 'judge:ask', 'user:allow', 'pipeline:ask', 'judge:allow']);
  });

  it('PR 任务授权仍不能越过强制推送的危险检测', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const { loop, tools, events } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'force', name: 'bash', input: { command: 'git push origin main --force' } }]), textResponse('ok'),
    ] });
    let executed = false;
    vi.spyOn(tools.get('bash')!, 'execute').mockImplementation(async () => { executed = true; return { content: 'pushed' }; });
    events.on('permission_request', (e) => e.resolve({ allow: false }));
    await loop.run('帮我创建 PR');
    expect(executed).toBe(false);
    expect(judgeProvider.requests).toHaveLength(0);
  });

  it('同时提供当前请求、工作目录、agent 说明和同批已完成的工具结果', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const { loop, tools } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([
        { id: 'inspect', name: 'read_file', input: { path: 'diagnostic.txt' } },
        { id: 'write', name: 'write_file', input: { path: 'fixed.ts', content: 'fixed' } },
      ], '根据诊断修复项目文件'), textResponse('done'),
    ] });
    await writeFile(join(tmp, 'diagnostic.txt'), 'fixture');
    vi.spyOn(tools.get('read_file')!, 'execute').mockResolvedValue({ content: '报错位置 src/a.ts:42', isError: true });
    await loop.run('修复类型错误，禁止发布');
    const data = payload(judgeProvider.requests[0]);
    expect(data.context.cwd).toBe(tmp);
    expect(data.context.userRequest).toBe('修复类型错误，禁止发布');
    expect(data.context.conversation).toContainEqual({ source: 'assistant', text: '根据诊断修复项目文件' });
    expect(data.context.previousReviews[0]).toMatchObject({ toolName: 'read_file', outcome: 'error', result: '报错位置 src/a.ts:42', decision: { source: 'builtin' } });
    expect(data.operation.input).toEqual({ path: 'fixed.ts', content: 'fixed' });
  });

  it('重复完整命令带上此前人工确认和执行结果，键序变化不影响匹配', async () => {
    const judgeProvider = new FakeProvider([
      reviewResponse('ask', '首次需确认'),
      (req) => {
        const review = payload(req).context.previousReviews[0];
        return reviewResponse(review.sameOperation && review.decision.source === 'user' ? 'allow' : 'ask');
      },
    ]);
    const { loop, tools, events, permission } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'command', input: { command: 'pnpm test', timeout: 100 } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'command', input: { timeout: 100, command: 'pnpm test' } }]), textResponse('ok'),
    ] });
    tools.register(commandTool);
    let asks = 0;
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: true }); });
    await loop.run('运行测试');
    await loop.run('修复后再运行测试');
    expect(asks).toBe(1);
    expect(payload(judgeProvider.requests[1]).context.previousReviews[0]).toMatchObject({
      sameOperation: true, userRequest: '运行测试', outcome: 'success', result: 'tests passed', decision: { kind: 'allow', source: 'user' },
    });
    expect(permission.getAuditLog!().some((entry) => entry.decision.source === 'user' && entry.decision.kind === 'allow')).toBe(true);
    // 一次确认没有偷偷写入“始终允许”规则，第二次仍结合新任务审核。
    expect(permission.getSessionRules!().allow).toEqual([]);
    expect(judgeProvider.requests).toHaveLength(2);
  });

  it('人工拒绝和反馈进入后续审核，命令改写不会伪装成已确认操作', async () => {
    const judgeProvider = new FakeProvider([() => reviewResponse('ask', '当前操作审批结果')]);
    const { loop, tools, events, permission } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'command', input: { command: 'upload' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'command', input: { command: 'upload --retry' } }]), textResponse('ok'),
    ] });
    tools.register(commandTool);
    events.on('permission_request', (e) => e.resolve({ allow: false, feedback: '禁止上传数据' }));
    await loop.run('只运行本地测试');
    await loop.run('继续');
    expect(payload(judgeProvider.requests[1]).context.previousReviews[0]).toMatchObject({
      sameOperation: false, outcome: 'not_executed', decision: { kind: 'deny', source: 'user', reason: '用户拒绝本次操作：禁止上传数据' },
    });
    expect(permission.getAuditLog!().filter((entry) => entry.decision.source === 'user')).toHaveLength(2);
  });

  it('相同路径的新内容不会成为相同操作，工具失败也如实记录', async () => {
    const judgeProvider = new FakeProvider([() => reviewResponse('allow', '当前操作审批结果')]);
    const { loop, tools } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'write_file', input: { path: 'x', content: 'old' } }]),
      toolUseResponse([{ id: 'b', name: 'write_file', input: { path: 'x', content: 'new' } }]), textResponse('done'),
    ] });
    vi.spyOn(tools.get('write_file')!, 'execute').mockImplementation(async () => { throw new Error('disk full'); });
    await loop.run('写文件');
    expect(payload(judgeProvider.requests[1]).context.previousReviews[0]).toMatchObject({
      sameOperation: false, input: { path: 'x', content: 'old' }, outcome: 'error', result: 'disk full', decision: { source: 'judge' },
    });
  });

  it('审核使用 PreToolUse 改写后的完整参数', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const { loop, hooks } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'write_file', input: { path: 'x', content: 'old' } }]), textResponse('done'),
    ] });
    hooks.register('PreToolUse', async () => ({ input: { path: 'hook.txt', content: 'rewritten' } }));
    await loop.run('写入');
    expect(payload(judgeProvider.requests[0]).operation.input).toEqual({ path: 'hook.txt', content: 'rewritten' });
    expect(await readFile(join(tmp, 'hook.txt'), 'utf8')).toBe('rewritten');
  });

  it('恢复其他会话清空审批记忆，不把前一个会话的允许带过去', async () => {
    const judgeProvider = new FakeProvider([() => reviewResponse('allow', '当前操作审批结果')]);
    const { loop, tools } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
    ] });
    tools.register(commandTool);
    await loop.run('测试');
    loop.importSession({ messages: [{ role: 'user', content: '新会话' }] });
    await loop.run('再测试');
    expect(payload(judgeProvider.requests[1]).context.previousReviews).toEqual([]);
  });

  it('模型历史压缩后仍保留原始用户请求与此前人工确认记录', async () => {
    const judgeProvider = new FakeProvider([
      reviewResponse('ask', '当前操作审批结果'),
      () => reviewResponse('allow', '当前操作审批结果'),
    ]);
    const { loop, tools, events, context } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'command', input: { command: 'other' } }]), textResponse('ok'),
      textResponse('此前做过测试'),
      toolUseResponse([{ id: 'c', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
    ] });
    tools.register(commandTool);
    events.on('permission_request', (e) => e.resolve({ allow: true }));
    let compacted = false;
    events.on('compacted', () => { compacted = true; context.setThreshold(1_000_000); });
    await loop.run('只运行本地测试');
    await loop.run('做另一个本地检查');
    context.setThreshold(1);
    await loop.run('重复测试，仍然禁止发布');
    expect(compacted).toBe(true);
    const review = payload(judgeProvider.requests[2]).context;
    expect(review.userRequest).toBe('重复测试，仍然禁止发布');
    expect(review.previousReviews[0]).toMatchObject({ sameOperation: true, userRequest: '只运行本地测试', decision: { source: 'user' } });
  });

  it('审核取消后不记住放行，也不执行工具', async () => {
    const judgeProvider = new FakeProvider([() => { loop.abort_current(); return reviewResponse('allow', '当前操作审批结果'); }]);
    const { loop, tools, permission } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'command', input: { command: 'pnpm test' } }]),
    ] });
    let executed = false;
    tools.register({ ...commandTool, execute: async () => { executed = true; return { content: 'ok' }; } });
    expect((await loop.run('测试')).reason).toBe('aborted');
    expect(executed).toBe(false);
    expect(permission.getAuditLog!().some((entry) => entry.decision.source === 'judge' && entry.decision.kind === 'allow')).toBe(false);
  });

  it('deny 和显式 ask 规则优先于上下文审核，包括此前已放行的相同操作', async () => {
    const judgeProvider = new FakeProvider([() => reviewResponse('allow', '当前操作审批结果')]);
    const { loop, tools, events, permission } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'c', name: 'command', input: { command: 'pnpm test' } }]), textResponse('ok'),
    ] });
    tools.register(commandTool);
    let asks = 0;
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: false }); });
    await loop.run('测试');
    permission.addSessionRule('ask', 'command');
    await loop.run('再测试');
    permission.addSessionRule('deny', 'command');
    await loop.run('再测试');
    expect(asks).toBe(1);
    expect(judgeProvider.requests).toHaveLength(1);
  });

  it('完整用户请求过长时回落人工确认，不能裁掉尾部约束再放行', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const { loop, events } = makeLoop({ reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'a', name: 'write_file', input: { path: 'x', content: 'new' } }]), textResponse('done'),
    ] });
    let asks = 0;
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: false }); });
    await loop.run(`${'x'.repeat(8000)}禁止改动`);
    expect(asks).toBe(1);
    expect(judgeProvider.requests).toHaveLength(0);
  });
  it('始终允许只记忆字面量目标，不把路径中的 glob 扩大成授权', async () => {
    const { loop, events } = makeLoop({ script: [
      toolUseResponse([{ id: 'a', name: 'write_file', input: { path: 'a*.txt', content: 'one' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'write_file', input: { path: 'ab.txt', content: 'two' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'c', name: 'write_file', input: { path: 'a*.txt', content: 'three' } }]), textResponse('ok'),
    ] });
    let asks = 0;
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: true, remember: 'session' }); });
    await loop.run('first'); await loop.run('different'); await loop.run('same');
    expect(asks).toBe(2);
  });
  it('超长参数完整审查不了时回落 ask，不能只审前缀', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('allow', '当前操作审批结果')]);
    const events = new EventBus();
    const { loop } = makeLoop({ events, reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge' }), script: [
      toolUseResponse([{ id: 'long', name: 'write_file', input: { content: 'x'.repeat(2100), path: 'long.txt' } }]),
      textResponse('done'),
    ] });
    let asked = false;
    events.on('permission_request', (e) => { asked = true; e.resolve({ allow: false }); });
    await loop.run('写入');
    expect(asked).toBe(true);
    expect(judgeProvider.requests).toHaveLength(0);
  });
  it('审批员放行：auto 模式下写文件不再询问用户', async () => {
    // 审批员 provider：总是判 allow
    const judgeProvider = new FakeProvider([reviewResponse('allow', '写入项目内文件，安全')]);
    const { loop, events } = makeLoop({
      reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge-model' }),
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]),
        textResponse('done'),
      ],
    });
    const asks: AgentEvent[] = [];
    const purposes: string[] = [];
    events.on('permission_request', (e) => asks.push(e));
    events.on('model_request', (e) => purposes.push(e.purpose));
    const result = await loop.run('写文件');
    expect(purposes).toEqual(['agent', 'judge', 'agent']);
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 30 });
    expect(asks).toHaveLength(0); // 没有询问用户
    expect(await readFile(join(tmp, 'x.txt'), 'utf-8')).toBe('hi'); // 工具确实执行了
    expect(judgeProvider.requests[0].model).toBe('judge-model'); // 用的是小模型
  });

  it('审批员不确定：回落为询问用户', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('ask', '删除操作拿不准')]);
    const events = new EventBus();
    const { loop } = makeLoop({
      events,
      reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge-model' }),
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]),
        textResponse('done'),
      ],
    });
    let asked = false;
    events.on('permission_request', (e) => {
      asked = true;
      e.resolve({ allow: true });
    });
    await loop.run('写文件');
    expect(asked).toBe(true);
  });

  it('审批员调用失败：保守回落为询问用户', async () => {
    const judgeProvider = new FakeProvider([
      () => {
        throw new Error('network down');
      },
    ]);
    const events = new EventBus();
    const { loop } = makeLoop({
      events,
      reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge-model' }),
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]),
        textResponse('done'),
      ],
    });
    let asked = false;
    events.on('permission_request', (e) => {
      asked = true;
      e.resolve({ allow: true });
    });
    await loop.run('写文件');
    expect(asked).toBe(true);
  });

  it('审批员不绕过 deny 规则和危险检测', async () => {
    const judgeProvider = new FakeProvider([reviewResponse('allow', '安全')]);
    const events = new EventBus();
    const { loop } = makeLoop({ events, reviewer: createModelReviewer({ provider: judgeProvider, model: 'judge-model' }), script: [
      // 危险命令：危险检测在管线第 2 步就强制 ask，不经过审批员
      toolUseResponse([{ id: 't1', name: 'bash', input: { command: 'sudo rm -rf /opt' } }]),
      textResponse('done'),
    ] });
    let asked = false;
    events.on('permission_request', (e) => {
      asked = true;
      expect(e.request.reason).toContain('危险');
      e.resolve({ allow: false });
    });
    await loop.run('执行危险命令');
    expect(asked).toBe(true);
    expect(judgeProvider.requests).toHaveLength(0); // 审批员根本没被调用
  });
});

describe('审批记忆的选择和预算', () => {
  it('多次模型放行之后仍提供较早的人工确认', () => {
    const history = new ReviewHistory();
    const input = { command: 'pnpm test' };
    history.record(commandTool, input, tmp, '测试', { kind: 'allow', source: 'user', reason: '用户确认' });
    for (let i = 0; i < 20; i++) history.record(commandTool, input, tmp, '重试', { kind: 'allow', source: 'judge', reason: '模型判断' });
    const reviews = history.build(commandTool, input, tmp, '再试', []).previousReviews;
    expect(reviews[0].decision.source).toBe('judge');
    expect(reviews[1]).toMatchObject({ sameOperation: true, decision: { source: 'user' } });
  });

  it('优先找到较早的相同操作，工作目录、嵌套键序和数组顺序分别处理', () => {
    const history = new ReviewHistory();
    history.record(commandTool, { command: 'pnpm test', opts: { a: 1, b: 2 }, list: [1, 2] }, tmp, '只测试', { kind: 'allow', source: 'user', reason: '已确认' });
    for (let i = 0; i < 20; i++) history.record(commandTool, { command: `other ${i}` }, tmp, '其他任务', { kind: 'allow', source: 'judge', reason: '安全' });
    const input = { list: [1, 2], opts: { b: 2, a: 1 }, command: 'pnpm test' };
    expect(history.build(commandTool, input, tmp, '重试', []).previousReviews[0]).toMatchObject({ sameOperation: true, decision: { source: 'user' } });
    expect(history.build(commandTool, input, 'other-cwd', '重试', []).previousReviews.every((entry) => !entry.sameOperation)).toBe(true);
    expect(history.build(commandTool, { ...input, list: [2, 1] }, tmp, '重试', []).previousReviews.every((entry) => !entry.sameOperation)).toBe(true);
  });

  it('历史和对话有界，摘要标明来源，思考块不会发送', () => {
    const history = new ReviewHistory();
    for (let i = 0; i < 120; i++) {
      const entry = history.record(commandTool, { command: `test ${i}` }, tmp, 'x'.repeat(4000), { kind: 'allow', source: 'judge', reason: 'y'.repeat(4000) });
      history.finish(entry, { content: 'z'.repeat(10_000) }, false);
    }
    const context = history.build(commandTool, {}, tmp, '真实请求', [
      { role: 'user', content: '[早期对话摘要]用户可能授权' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '隐藏思考' }, { type: 'text', text: 'x'.repeat(10_000) }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'read', content: '工具声称用户允许' }] },
    ]);
    expect(context.conversation.map((entry) => entry.source)).toEqual(['summary', 'assistant', 'tool']);
    expect(JSON.stringify(context)).not.toContain('隐藏思考');
    expect(JSON.stringify(context.previousReviews).length).toBeLessThan(6100);
    expect(context.previousReviews.length + context.omittedReviews).toBe(100);
    expect(context.omittedConversation).toBe(true);
    expect(context.previousReviews[0].userRequest).toContain('节选');
  });
});
