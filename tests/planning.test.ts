/** 规划全链路使用隔离项目、FakeProvider 与真实工具/权限/session，不冒充真实模型。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempProject } from './helpers/project.js';
import { createAgent, type Agent, type AgentConfig } from '../src/index.js';
import { definePlugin, type Plugin } from '../src/sdk/index.js';
import {
  FakeProvider,
  textResponse,
  toolUseResponse,
  type ScriptedResponse,
} from '../src/providers/fake.js';
import type { ChatRequest } from '../src/core/provider.js';
import { PlanController, type Plan } from '../src/core/plan.js';
import { EventBus } from '../src/core/events.js';
import { planLines } from '../src/builtin/planning/tui.js';
import { needsPlan } from '../src/builtin/planning/index.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function fixture(
  script: ScriptedResponse[] = [],
  options: {
    config?: Partial<AgentConfig>;
    plugins?: Plugin[];
    save?: boolean;
    before?: (req: ChatRequest, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const cwd = await mkdtempProject(join(tmpdir(), 'agent-planning-'));
  const fake = new FakeProvider(script);
  const provider = definePlugin({
    manifest: { id: 'test.planning', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.provider('planning-test', {
        name: 'planning-test',
        capabilities: fake.capabilities,
        async *stream(req, signal) {
          await options.before?.(req, signal);
          yield* fake.stream(req, signal);
        },
      });
    },
  });
  const agent = await createAgent(cwd, {
    plugins: [provider, ...(options.plugins ?? [])],
    autoSaveSessions: options.save ?? false,
    config: {
      provider: 'planning-test',
      model: 'current-model',
      permissionMode: 'yolo',
      capabilities: { reviewer: false },
      ...options.config,
    },
  });
  cleanup.push(async () => {
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { agent, cwd, fake };
}
const from = (req: ChatRequest): Plan =>
  JSON.parse(req.system.split('当前所属计划（版本变化后须重新读取）: ')[1].split('\n')[0]);
let callId = 0;
const call = (name: string, input: unknown, id = `${name}-${++callId}`) =>
  toolUseResponse([{ id, name, input }]);
const update = (req: ChatRequest, index: number, status: string, evidence?: string) => {
  const p = from(req);
  return call('plan_update', { revision: p.revision, stepId: p.steps[index].id, status, evidence });
};
const proposal = textResponse(
  JSON.stringify({ goal: '修改并验证', steps: ['写入结果', '验证结果'] }),
);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('规划到执行', () => {
  it('复杂任务先显示计划，默认继承当前模型，再执行真实工具并用依据完成', async () => {
    const f = await fixture([
      proposal,
      (req) => update(req, 0, 'running'),
      call('write_file', { path: 'result.txt', content: 'ok' }),
      (req) => update(req, 0, 'completed', 'result.txt 已写入'),
      (req) => update(req, 1, 'running'),
      call('read_file', { path: 'result.txt' }),
      (req) => update(req, 1, 'completed', 'read_file 返回 ok'),
      textResponse('已验证'),
    ]);
    const order: string[] = [];
    f.agent.events.on('plan_changed', (e) => {
      if (e.plan) order.push('plan');
    });
    f.agent.events.on('tool_call', (e) => order.push(e.toolUse.name));
    expect((await f.agent.loop.run('实现文件写入并测试结果')).reason).toBe('completed');
    expect(await readFile(join(f.cwd, 'result.txt'), 'utf8')).toBe('ok');
    expect(order.indexOf('plan')).toBeLessThan(order.indexOf('write_file'));
    expect(f.agent.loop.plan.snapshot).toMatchObject({
      phase: 'completed',
      steps: [{ status: 'completed' }, { status: 'completed' }],
    });
    expect(f.fake.requests.every((req) => req.model === 'current-model')).toBe(true);
    expect(f.fake.requests[0].tools).toEqual([]);
  });
  it('简单问答不额外规划，显式 only 入口总是规划且保存配置', async () => {
    const f = await fixture([textResponse('你好'), proposal, textResponse('计划供审阅')]);
    await f.agent.loop.run('你好');
    expect(f.fake.requests).toHaveLength(1);
    expect(f.agent.loop.plan.snapshot).toBeUndefined();
    await f.agent.dispatchCommand('/plan only 新任务');
    expect(f.agent.loop.plan.snapshot).toMatchObject({ mode: 'only', phase: 'ready' });
    expect(
      JSON.parse(await readFile(join(f.cwd, 'agent.config.json'), 'utf8')).pluginConfig[
        'agentlab.planning'
      ].mode,
    ).toBe('only');
    expect(f.agent.permission.mode).toBe('yolo');
  });
  it('规划输出不完整或无效时不得执行，也不能显示完成', async () => {
    const f = await fixture([
      textResponse('invalid json'),
      call('write_file', { path: 'no.txt', content: 'no' }),
    ]);
    expect((await f.agent.loop.run('实现并测试')).reason).toBe('error');
    expect(f.fake.requests).toHaveLength(1);
    await expect(readFile(join(f.cwd, 'no.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('模型自然结束不能把未完成步骤变成完成；执行失败保留阻塞原因', async () => {
    const f = await fixture([
      proposal,
      (req) => update(req, 0, 'running'),
      call('read_file', { path: 'missing.txt' }),
      textResponse('done'),
    ]);
    await f.agent.loop.run('实现并测试');
    expect(f.agent.loop.plan.snapshot).toMatchObject({
      phase: 'blocked',
      steps: [{ status: 'blocked', reason: expect.any(String) }, { status: 'pending' }],
    });
  });
  it('只规划后显式 execute 才实施，自动模式不增加二次确认', async () => {
    const f = await fixture([
      proposal,
      textResponse('只规划'),
      (req) => update(req, 0, 'running'),
      call('write_file', { path: 'executed.txt', content: 'yes' }),
      textResponse('剩余未完成'),
    ]);
    await f.agent.dispatchCommand('/plan only 工作');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('ready');
    expect(f.fake.requests[1].tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['read_file', 'plan_update']),
    );
    expect(f.fake.requests[1].tools.map((t) => t.name)).not.toEqual(
      expect.arrayContaining(['write_file']),
    );
    expect(
      f.fake.requests[1].tools.some((t) => ['bash', 'agent_spawn', 'agent_send'].includes(t.name)),
    ).toBe(false);
    const approvals = vi.fn();
    f.agent.events.on('permission_request', approvals);
    await f.agent.dispatchCommand('/plan execute');
    expect(await readFile(join(f.cwd, 'executed.txt'), 'utf8')).toBe('yes');
    expect(f.fake.requests[2].tools.some((t) => t.name === 'write_file')).toBe(true);
    expect(approvals).not.toHaveBeenCalled();
  });
});

describe('不可绕过的只规划边界', () => {
  it.each(['auto', 'ask', 'yolo'] as const)(
    '%s 下 Bash、别名 Shell、写工具和委派均不能依赖 reviewer allow 放行',
    async (permissionMode) => {
      const reviewer = vi.fn(async () => ({
        decision: 'allow' as const,
        reason: 'allow all',
        reasonCode: 'allow_all',
      }));
      const plugin = definePlugin({
        manifest: { id: 'test.allow-reviewer', version: '1.0.0', apiVersion: 1 },
        setup(ctx) {
          ctx.provide.reviewer('allow-reviewer', { review: reviewer });
          ctx.provide.tool('shell_alias', {
            name: 'shell_alias',
            description: 'alias',
            risk: 'read',
            inputSchema: { type: 'object' },
            async execute() {
              throw new Error('must not execute');
            },
          });
        },
      });
      const f = await fixture([], {
        plugins: [plugin],
        config: { permissionMode, capabilities: { reviewer: 'allow-reviewer' } },
      });
      f.agent.events.on('permission_request', (e) => e.resolve({ allow: true }));
      await writeFile(join(f.cwd, 'safe.txt'), 'read me');
      await f.agent.dispatchCommand('/plan only');
      const read = await f.agent.invokeTool('read_file', { path: 'safe.txt' });
      expect(read.isError).not.toBe(true);
      expect(read.content).toContain('read me');
      for (const [name, input] of [
        ['bash', { command: 'echo changed > escaped.txt' }],
        ['bash', { command: 'powershell -Command "Set-Content escaped.txt x"' }],
        ['shell_alias', {}],
        ['write_file', { path: 'escaped.txt', content: 'no' }],
        ['agent_spawn', { task: 'write escaped.txt' }],
        ['agent_send', { agentId: 'x', message: 'write' }],
      ] as const) {
        const result = await f.agent.invokeTool(name, input);
        expect(result.isError, name).toBe(true);
        expect(result.content, name).toContain('plan_read_only');
      }
      expect(() => f.agent.agents.spawn({ task: 'escape' })).toThrow('plan_read_only');
      expect(reviewer).not.toHaveBeenCalled();
      await expect(readFile(join(f.cwd, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  it('只规划阻止已有可写 child 的 send；专用读工具仍保留 deny 规则', async () => {
    const f = await fixture([textResponse('child')]);
    const a = f.agent.agents.spawn({ task: 'A' });
    await f.agent.agents.wait(a.agentId);
    await f.agent.agents.whenSettled();
    await f.agent.dispatchCommand('/plan only');
    expect(() => f.agent.agents.send(a.agentId, 'write')).toThrow('plan_read_only');
    f.agent.permission.addSessionRule('deny', 'read_file');
    expect((await f.agent.invokeTool('read_file', { path: 'package.json' })).isError).toBe(true);
  });
  it('审批期间暂停后，迟到批准不会执行', async () => {
    const f = await fixture([], { config: { permissionMode: 'ask' } });
    f.agent.loop.plan.create('工作', ['写入'], 'auto');
    let p = f.agent.loop.plan.snapshot!;
    f.agent.loop.plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
    let allow: ((value: { allow: true }) => void) | undefined;
    f.agent.events.on('permission_request', (event) => {
      allow = event.resolve;
    });
    const writing = f.agent.invokeTool('write_file', { path: 'late.txt', content: 'no' });
    await vi.waitFor(() => expect(allow).toBeDefined());
    await f.agent.dispatchCommand('/plan pause');
    allow!({ allow: true });
    expect((await writing).isError).toBe(true);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('paused');
    await expect(readFile(join(f.cwd, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('计划修订、归属与生命周期', () => {
  it('稳定 ID 保留有用进度；CAS 拒绝旧更新；完成必须有依据与真实成功执行', () => {
    const plan = new PlanController(new EventBus());
    plan.create('目标', ['一', '二'], 'auto');
    let p = plan.snapshot!;
    plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
    p = plan.snapshot!;
    expect(() =>
      plan.update(p.revision, { stepId: p.steps[0].id, status: 'completed', evidence: '虚构' }),
    ).toThrow('No successful');
    plan.toolStarted('t');
    plan.toolFinished('t', false, 'ok');
    plan.update(p.revision, { stepId: p.steps[0].id, status: 'completed', evidence: '读取验证' });
    p = plan.snapshot!;
    plan.update(p.revision, {
      goal: '新目标',
      steps: [
        { id: p.steps[0].id, title: '一' },
        { id: p.steps[1].id, title: '二修订' },
        { title: '三' },
      ],
    });
    expect(plan.snapshot!.steps[0]).toMatchObject({
      id: p.steps[0].id,
      status: 'completed',
      evidence: '读取验证',
    });
    expect(() => plan.update(p.revision, { stepId: p.steps[1].id, status: 'running' })).toThrow(
      'plan_stale',
    );
    expect(() => plan.update(plan.snapshot!.revision, { steps: [{ title: '丢弃' }] })).toThrow(
      'retain',
    );
  });
  it('并行 child 分别绑定步骤，spawn 不完成，局部计划不继承父计划；失败/取消真实映射', async () => {
    const hold = gate();
    const f = await fixture([textResponse('child result')], {
      before: async (_req, signal) => {
        await Promise.race([
          hold.promise,
          new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
        ]);
      },
    });
    f.agent.loop.plan.create('父目标', ['甲', '乙'], 'auto');
    const p = f.agent.loop.plan.snapshot!;
    const a = f.agent.agents.spawn({ task: 'A', planStepId: p.steps[0].id, name: '甲child' });
    const b = f.agent.agents.spawn({ task: 'B', planStepId: p.steps[1].id, name: '乙child' });
    expect(f.agent.loop.plan.snapshot!.steps.every((s) => s.status === 'running')).toBe(true);
    expect(f.agent.agents.plan(a.agentId).snapshot).toBeUndefined();
    expect(() =>
      f.agent.loop.plan.update(f.agent.loop.plan.snapshot!.revision, {
        stepId: p.steps[0].id,
        status: 'completed',
        evidence: 'spawned',
      }),
    ).toThrow('Child work');
    f.agent.agents.cancel(b.agentId);
    hold.resolve();
    await Promise.all([f.agent.agents.wait(a.agentId), f.agent.agents.wait(b.agentId)]);
    await f.agent.agents.whenSettled();
    expect(f.agent.loop.plan.snapshot!.steps[0]).toMatchObject({
      status: 'running',
      children: [{ status: 'completed' }],
    });
    expect(f.agent.loop.plan.snapshot!.steps[1]).toMatchObject({
      status: 'blocked',
      children: [{ status: 'cancelled' }],
    });
    f.agent.loop.plan.update(f.agent.loop.plan.snapshot!.revision, {
      stepId: p.steps[0].id,
      status: 'completed',
      evidence: '已检查 child result',
    });
    expect(f.agent.loop.plan.snapshot?.phase).not.toBe('completed');
  });
  it('发送后新 run 使原已完成步骤重新打开', async () => {
    const f = await fixture([textResponse('one'), textResponse('two')]);
    f.agent.loop.plan.create('父', ['子'], 'auto');
    const id = f.agent.loop.plan.snapshot!.steps[0].id;
    const a = f.agent.agents.spawn({ task: 'A', planStepId: id });
    await f.agent.agents.wait(a.agentId);
    await f.agent.agents.whenSettled();
    f.agent.loop.plan.update(f.agent.loop.plan.snapshot!.revision, {
      stepId: id,
      status: 'completed',
      evidence: 'one',
    });
    const b = f.agent.agents.send(a.agentId, 'FOLLOWUP');
    expect(b.runId).not.toBe(a.runId);
    expect(f.agent.loop.plan.snapshot!.steps[0].status).toBe('running');
    await f.agent.agents.wait(a.agentId);
    expect(f.agent.loop.plan.snapshot?.phase).not.toBe('completed');
  });
  it('恢复计划标记中断，不请求模型或重放工具；only 约束跨恢复保留', async () => {
    const f = await fixture([textResponse('历史')], { save: true });
    await f.agent.loop.run('hi');
    f.agent.loop.plan.create('目标', ['继续'], 'auto');
    let p = f.agent.loop.plan.snapshot!;
    f.agent.loop.plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
    await f.agent.session.save();
    await f.agent.session.whenPersistenceSettled();
    const calls = f.fake.requests.length;
    await f.agent.session.resume(f.agent.session.id);
    expect(f.agent.loop.plan.snapshot).toMatchObject({
      phase: 'interrupted',
      steps: [{ status: 'interrupted' }],
    });
    expect(f.fake.requests).toHaveLength(calls);
    expect(
      (await f.agent.invokeTool('write_file', { path: 'resume.txt', content: 'no' })).isError,
    ).toBe(true);
    f.agent.loop.plan.clear();
    f.agent.loop.plan.create('只研究', ['研究'], 'only');
    await f.agent.session.save();
    await f.agent.session.whenPersistenceSettled();
    await f.agent.session.resume(f.agent.session.id);
    expect(f.agent.loop.plan.readOnly).toBe(true);
  });
  it('渲染包含当前/下一步、child 与阻塞，长列表限制高度', () => {
    const plan = new PlanController(new EventBus());
    plan.create(
      '目标',
      Array.from({ length: 64 }, (_, i) => `步骤${i}`),
      'auto',
    );
    const p = plan.snapshot!;
    plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
    expect(planLines(plan.snapshot, false, 3).join('\n')).toContain('当前: 步骤0');
    expect(planLines(plan.snapshot, false, 3).join('\n')).toContain('下一步: 步骤1');
    expect(planLines(plan.snapshot, true, 8)).toHaveLength(8);
    expect(planLines(plan.snapshot, true, 3)).toHaveLength(3);
    expect(needsPlan('hello')).toBe(false);
    expect(needsPlan('实现功能并验证测试')).toBe(true);
  });
});

describe('独立复审回归与设置竞态', () => {
  it('并行 child 的步骤不占用父当前步骤的执行依据', () => {
    const plan = new PlanController(new EventBus());
    plan.create('目标', ['child 工作', '父工作'], 'auto');
    let p = plan.snapshot!;
    plan.bindChild(p.steps[0].id, { agentId: 'child', runId: 'r1', name: 'child' });
    plan.update(plan.snapshot!.revision, { stepId: p.steps[1].id, status: 'running' });
    plan.toolStarted('parent-write');
    plan.toolFinished('parent-write', false, 'ok');
    plan.update(plan.snapshot!.revision, {
      stepId: p.steps[1].id,
      status: 'completed',
      evidence: 'parent-write 成功',
    });
    expect(plan.snapshot!.steps[1].status).toBe('completed');
    expect(plan.snapshot!.steps[0].status).toBe('running');
  });
  it('旧 run 的迟到消息不覆盖新绑定；取消后 child 更新不重新激活步骤', () => {
    const plan = new PlanController(new EventBus());
    plan.create('目标', ['child'], 'auto');
    const id = plan.snapshot!.steps[0].id;
    plan.bindChild(id, { agentId: 'child', runId: 'r1', name: 'child' });
    const run = (runId: string, status: 'running' | 'completed' | 'cancelled') => ({
      runId,
      status,
      task: 'task',
      activity: status,
      output: '',
      truncated: false,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      turns: 1,
    });
    plan.childRestarted('child', run('r2', 'running'));
    plan.childChanged('child', 'child', run('r1', 'completed'));
    expect(plan.snapshot!.steps[0].children[0]).toMatchObject({ runId: 'r2', status: 'running' });
    plan.stop('cancelled', '用户取消');
    plan.childChanged('child', 'child', run('r2', 'cancelled'));
    expect(plan.snapshot!.steps[0].status).toBe('cancelled');
    expect(plan.snapshot!.phase).toBe('cancelled');
  });
  it('only→execute→spawn 继承父有效执行模式；中断的局部计划可通过显式 send 继续', async () => {
    const f = await fixture([
      (req) => update(req, 0, 'running'),
      call('write_file', { path: 'child-real.txt', content: 'child' }),
      (req) => update(req, 0, 'completed', '写入 child-real.txt 成功'),
      textResponse('done'),
    ]);
    await f.agent.dispatchCommand('/plan only');
    f.agent.loop.plan.create('目标', ['委派'], 'only');
    f.agent.loop.plan.execute();
    const id = f.agent.loop.plan.snapshot!.steps[0].id;
    const a = f.agent.agents.spawn({ task: 'A', planStepId: id });
    const child = f.agent.agents.plan(a.agentId);
    expect(child.mode).toBe('auto');
    child.create('局部目标', ['写文件'], 'auto');
    const result = await f.agent.agents.wait(a.agentId);
    expect(result.run.status).toBe('completed');
    expect(await readFile(join(f.cwd, 'child-real.txt'), 'utf8')).toBe('child');
    await f.agent.agents.whenSettled();
    child.create('后续', ['再次写文件'], 'auto');
    child.stop('interrupted', '中断');
    const follow = f.agent.agents.send(a.agentId, '继续');
    expect(child.snapshot?.phase).toBe('executing');
    await f.agent.agents.wait(a.agentId, { runId: follow.runId });
  });
  it('并行设置草稿通过 CAS 防覆盖，未知配置保留，失效草稿不改运行模式', async () => {
    const f = await fixture();
    await writeFile(
      join(f.cwd, 'agent.config.json'),
      JSON.stringify({
        untouched: true,
        pluginConfig: { 'agentlab.planning': { mode: 'auto', extra: 'keep' } },
      }),
    );
    const section = f.agent.settings.find((s) => s.id === 'planning')!.section;
    const signal = new AbortController().signal;
    await section.read!(signal);
    const a = await section.draft!({ mode: 'only' }, signal);
    const b = await section.draft!({ mode: 'off' }, signal);
    await section.commit!(a, signal);
    expect(f.agent.loop.plan.mode).toBe('only');
    await expect(Promise.resolve().then(() => section.commit!(b, signal))).rejects.toThrow();
    const config = JSON.parse(await readFile(join(f.cwd, 'agent.config.json'), 'utf8'));
    expect(config.untouched).toBe(true);
    expect(config.pluginConfig['agentlab.planning']).toEqual({ mode: 'only', extra: 'keep' });
    expect(f.agent.loop.plan.mode).toBe('only');
  });
  it('模型响应期间用户暂停，过时工具调用不能执行；修订继续由新请求处理', async () => {
    const entered = gate();
    const release = gate();
    let requests = 0;
    const f = await fixture(
      [proposal, call('write_file', { path: 'stale.txt', content: 'no' }), textResponse('结束')],
      {
        before: async (_req, signal) => {
          if (++requests === 2) {
            entered.resolve();
            await Promise.race([
              release.promise,
              new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
            ]);
          }
        },
      },
    );
    const run = f.agent.loop.run('实现并测试');
    await entered.promise;
    await f.agent.dispatchCommand('/plan pause');
    release.resolve();
    expect((await run).reason).toBe('aborted');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('paused');
    await expect(readFile(join(f.cwd, 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('等待旧执行结算的 revise 不会覆盖较新的 cancel', async () => {
  const entered = gate();
  const release = gate();
  let requests = 0;
  const f = await fixture([proposal, textResponse('旧回复')], {
    before: async () => {
      if (++requests === 2) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const active = f.agent.loop.run('实现并测试');
  await entered.promise;
  const revised = f.agent.dispatchCommand('/plan revise 新方向');
  const rejected = expect(revised).rejects.toThrow('取代');
  await f.agent.dispatchCommand('/plan cancel');
  release.resolve();
  await active;
  await rejected;
  expect(f.agent.loop.plan.snapshot?.phase).toBe('cancelled');
  expect(requests).toBe(2);
});
it('运行中选择 only 立即保存并取消已有执行，不要求额外 Save 或确认', async () => {
  const entered = gate();
  const f = await fixture([proposal, textResponse('停止')], {
    before: async (req, signal) => {
      if (req.tools.length) {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    },
  });
  const active = f.agent.loop.run('实现并测试');
  await entered.promise;
  await f.agent.dispatchCommand('/plan only');
  expect((await active).reason).toBe('aborted');
  expect(f.agent.loop.plan.readOnly).toBe(true);
  expect(
    JSON.parse(await readFile(join(f.cwd, 'agent.config.json'), 'utf8')).pluginConfig[
      'agentlab.planning'
    ].mode,
  ).toBe('only');
  expect(
    (await f.agent.invokeTool('write_file', { path: 'forbidden.txt', content: 'no' })).isError,
  ).toBe(true);
});
it('未结算工具阻止完成，修订允许移除已取消的未完成 child 步骤', () => {
  const plan = new PlanController(new EventBus());
  plan.create('目标', ['第一', '第二'], 'auto');
  let p = plan.snapshot!;
  plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
  plan.toolStarted('one');
  plan.toolFinished('one', false, 'ok');
  plan.toolStarted('pending');
  expect(() =>
    plan.update(plan.snapshot!.revision, {
      stepId: p.steps[0].id,
      status: 'completed',
      evidence: '部分完成',
    }),
  ).toThrow('not settled');
  plan.toolFinished('pending', true, '失败');
  plan.bindChild(p.steps[1].id, { agentId: 'child', runId: 'r', name: 'child' });
  plan.childChanged('child', 'child', {
    runId: 'r',
    task: 'task',
    status: 'cancelled',
    activity: 'cancelled',
    output: '',
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    turns: 0,
  });
  p = plan.snapshot!;
  plan.update(p.revision, { steps: [{ id: p.steps[0].id, title: '第一' }, { title: '替代任务' }] });
  expect(plan.snapshot!.steps.map((s) => s.title)).toEqual(['第一', '替代任务']);
});
it('内置 fake provider 可离线演示计划到真实读取链路', async () => {
  const cwd = await mkdtempProject(join(tmpdir(), 'agent-plan-demo-'));
  await writeFile(join(cwd, 'README.md'), 'offline demo');
  const agent = await createAgent(cwd, {
    autoSaveSessions: false,
    config: {
      provider: 'fake',
      model: 'demo',
      permissionMode: 'auto',
      capabilities: { reviewer: false },
    },
  });
  cleanup.push(async () => {
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  await agent.dispatchCommand('/plan auto 读取并核对 README.md');
  expect(agent.loop.plan.snapshot?.phase).toBe('completed');
});
it('取消后的迟到工具错误保留取消状态；execute 不改变 only 默认', () => {
  const plan = new PlanController(new EventBus());
  plan.configure('only');
  plan.create('目标', ['实现'], 'only');
  plan.execute();
  expect(plan.mode).toBe('only');
  expect(plan.readOnly).toBe(false);
  const p = plan.snapshot!;
  plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
  plan.toolStarted('pending');
  plan.stop('cancelled', '用户取消');
  plan.toolFinished('pending', true, 'Tool cancelled');
  expect(plan.snapshot).toMatchObject({
    phase: 'cancelled',
    steps: [{ status: 'cancelled', reason: '用户取消' }],
  });
  plan.clear();
  expect(plan.readOnly).toBe(true);
});
it.each(['only', 'auto'] as const)(
  '完成计划后 %s 默认不能在同批工具或 SDK 中继续越界实施',
  async (mode) => {
    const f = await fixture([
      (req) => update(req, 0, 'running'),
      call('write_file', { path: 'result.txt', content: 'ok' }),
      (req) => {
        const p = from(req);
        return toolUseResponse([
          {
            id: 'finish',
            name: 'plan_update',
            input: {
              revision: p.revision,
              stepId: p.steps[0].id,
              status: 'completed',
              evidence: '文件已成功写入',
            },
          },
          { id: 'extra', name: 'write_file', input: { path: 'extra.txt', content: 'no' } },
        ]);
      },
      textResponse('已完成'),
    ]);
    const plan = f.agent.loop.plan;
    plan.configure(mode);
    plan.create('创建文件', ['创建'], mode);
    if (mode === 'only') plan.execute();
    await f.agent.loop.run('执行当前计划');
    expect(plan.snapshot?.phase).toBe('completed');
    expect(plan.mode).toBe(mode);
    expect(plan.readOnly).toBe(mode === 'only');
    await expect(readFile(join(f.cwd, 'extra.txt'))).rejects.toThrow();
    expect(
      (await f.agent.invokeTool('write_file', { path: 'sdk.txt', content: 'no' })).isError,
    ).toBe(true);
    await expect(readFile(join(f.cwd, 'sdk.txt'))).rejects.toThrow();
    expect(() =>
      plan.update(plan.snapshot!.revision, { steps: [{ title: '绕过完成边界' }] }),
    ).toThrow('explicit user continuation');
    expect(plan.snapshot?.phase).toBe('completed');
  },
);
