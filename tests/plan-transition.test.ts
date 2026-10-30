/** 原子计划切换与未执行调用的状态边界；不调用模型或真实命令。 */
import { describe, expect, it } from 'vitest';
import { PlanController } from '../src/core/plan.js';
import { EventBus } from '../src/core/events.js';
import type { PolicyInput, ToolAnalysis } from '../src/sdk/capabilities.js';

function fixture() {
  const events = new EventBus();
  const plan = new PlanController(events);
  plan.create('审查', ['检查', '汇总'], 'auto', true);
  const [first, second] = plan.snapshot!.steps;
  plan.update(plan.snapshot!.revision, { stepId: first.id, status: 'running' });
  plan.toolStarted('read');
  plan.toolFinished('read', false, '已核对');
  const finish = () =>
    plan.update(plan.snapshot!.revision, {
      stepId: first.id,
      status: 'completed',
      evidence: '实际读取',
      nextStepId: second.id,
    });
  return { plan, events, first, second, finish };
}

describe('原子完成并启动步骤', () => {
  it('两步只发布一次变更并失效一次执行绑定；旧 revision 不能重用', () => {
    const { plan, events, first, second, finish } = fixture();
    const revision = plan.snapshot!.revision,
      generation = plan.generation;
    const states: unknown[] = [];
    events.on('plan_changed', (e) => states.push(e.plan));
    finish();
    expect(states).toHaveLength(1);
    expect(plan.generation).toBe(generation + 1);
    expect(plan.snapshot).toMatchObject({
      revision: revision + 1,
      activeStepId: second.id,
      steps: [
        { id: first.id, status: 'completed', evidence: '实际读取' },
        { id: second.id, status: 'running' },
      ],
    });
    const after = plan.snapshot;
    expect(() => plan.update(revision, { stepId: second.id, status: 'running' })).toThrow(
      'plan_stale',
    );
    expect(plan.snapshot).toEqual(after);
    expect(() =>
      plan.update(plan.snapshot!.revision, {
        stepId: second.id,
        status: 'completed',
        evidence: '没有新证据',
      }),
    ).toThrow('No successful execution');
  });

  it.each([
    'missing',
    'same',
    'blocked',
    'inflight',
    'child',
    'only',
    'denied',
    'paused',
    'wrong-status',
    'revise',
  ])('%s 校验失败不改变任何状态、证据或 revision', (kind) => {
    const { plan, events, first, second } = fixture();
    if (kind === 'blocked')
      plan.update(plan.snapshot!.revision, {
        stepId: second.id,
        status: 'blocked',
        reason: '待确认',
      });
    if (kind === 'inflight') plan.toolStarted('pending');
    if (kind === 'child') plan.bindChild(first.id, { agentId: 'child', runId: 'r', name: 'child' });
    if (kind === 'only') plan.configure('only');
    if (kind === 'denied') plan.deny('明确拒绝');
    if (kind === 'paused') plan.stop('paused', '暂停');
    const before = plan.snapshot,
      generation = plan.generation;
    let changed = 0;
    events.on('plan_changed', () => changed++);
    expect(() =>
      plan.update(before!.revision, {
        stepId: first.id,
        status: kind === 'wrong-status' ? 'running' : 'completed',
        evidence: '实际读取',
        nextStepId: kind === 'missing' ? 'missing' : kind === 'same' ? first.id : second.id,
        ...(kind === 'revise'
          ? { steps: before!.steps.map(({ id, title }) => ({ id, title })) }
          : {}),
      }),
    ).toThrow();
    expect(plan.snapshot).toEqual(before);
    expect(plan.generation).toBe(generation);
    expect(changed).toBe(0);
  });
});

describe('显式继续的状态迁移', () => {
  it('重开未完成步骤并保留完成证据、children 与真实进度，旧 revision 仍失效', () => {
    const plan = new PlanController(new EventBus());
    plan.create('目标', ['已完成', '阻塞', '取消', '中断', '待办'], 'auto');
    let p = plan.snapshot!;
    plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
    plan.toolStarted('complete');
    plan.toolFinished('complete', false, '完成结果');
    plan.update(plan.snapshot!.revision, {
      stepId: p.steps[0].id,
      status: 'completed',
      evidence: '保留这份完成证据',
    });
    plan.bindChild(p.steps[1].id, { agentId: 'child', runId: 'run', name: '子任务' });
    plan.update(plan.snapshot!.revision, { stepId: p.steps[1].id, status: 'running' });
    plan.toolStarted('successful');
    plan.toolFinished('successful', false, '真实成功');
    plan.update(plan.snapshot!.revision, {
      stepId: p.steps[1].id,
      status: 'blocked',
      reason: '等待处理',
    });
    plan.update(plan.snapshot!.revision, { stepId: p.steps[2].id, status: 'running' });
    plan.stop('cancelled', '用户取消');
    plan.resume();
    plan.update(plan.snapshot!.revision, {
      stepId: p.steps[1].id,
      status: 'blocked',
      reason: '再次阻塞',
    });
    plan.update(plan.snapshot!.revision, { stepId: p.steps[3].id, status: 'running' });
    plan.stop('interrupted', '执行中断');
    plan.deny('用户拒绝');
    const before = plan.snapshot!;
    const generation = plan.generation;
    const denialGeneration = plan.denialGeneration;
    const completed = before.steps[0];
    const children = before.steps[1].children;

    plan.resume();

    expect(plan.snapshot).toMatchObject({
      phase: 'executing',
      activeStepId: p.steps[1].id,
      denialReason: undefined,
      reason: undefined,
      steps: [
        { status: 'completed', evidence: '保留这份完成证据' },
        { status: 'running', reason: undefined, children },
        { status: 'pending', reason: undefined },
        { status: 'pending', reason: undefined },
        { status: 'pending' },
      ],
    });
    expect(plan.snapshot!.steps[0]).toEqual(completed);
    expect(plan.stepProgress).toEqual({ stepId: p.steps[1].id, successfulCalls: 1 });
    expect(plan.generation).toBe(generation + 1);
    expect(plan.denialGeneration).toBe(denialGeneration + 1);
    expect(() =>
      plan.update(before.revision, { stepId: p.steps[2].id, status: 'running' }),
    ).toThrow('plan_stale');
  });

  it('only 继续不自动启动实施步骤', () => {
    const plan = new PlanController(new EventBus());
    plan.create('只出方案', ['实施一', '实施二'], 'only');
    const p = plan.snapshot!;
    plan.update(p.revision, { stepId: p.steps[0].id, status: 'running' });
    plan.stop('cancelled', '等待用户修订');

    plan.resume();

    expect(plan.snapshot).toMatchObject({
      phase: 'planning',
      activeStepId: undefined,
      steps: [{ status: 'pending' }, { status: 'pending' }],
    });
    expect(plan.current).toBeUndefined();
  });

  it('无计划与已完成计划仍拒绝继续', () => {
    const plan = new PlanController(new EventBus());
    expect(() => plan.resume()).toThrow('No plan');
    plan.create('目标', ['完成'], 'auto');
    const id = plan.snapshot!.steps[0].id;
    plan.update(plan.snapshot!.revision, { stepId: id, status: 'running' });
    plan.toolStarted('done');
    plan.toolFinished('done', false, '完成');
    plan.update(plan.snapshot!.revision, { stepId: id, status: 'completed', evidence: '真实结果' });
    const before = plan.snapshot;
    expect(() => plan.resume()).toThrow('already complete');
    expect(plan.snapshot).toEqual(before);
  });
});

describe('并行工具结算与阻塞原因', () => {
  it('失败后成功不清除阻塞原因，显式重试后的成功才清除', () => {
    const { plan, first } = fixture();
    plan.toolStarted('failed');
    plan.toolStarted('succeeded');
    plan.toolFinished('failed', true, '并行调用失败');
    plan.toolFinished('succeeded', false, '另一调用成功');
    expect(plan.snapshot!.steps[0]).toMatchObject({
      status: 'blocked',
      reason: '并行调用失败',
    });

    plan.update(plan.snapshot!.revision, { stepId: first.id, status: 'running' });
    plan.waiting('等待显式重试');
    plan.toolStarted('retry');
    plan.toolFinished('retry', false, '重试成功');
    expect(plan.snapshot!.steps[0]).toMatchObject({ status: 'running', reason: undefined });
    expect(plan.stepProgress).toEqual({ stepId: first.id, successfulCalls: 2 });
  });

  it('成功后失败保留最后的失败原因', () => {
    const { plan } = fixture();
    plan.toolStarted('succeeded');
    plan.toolStarted('failed');
    plan.toolFinished('succeeded', false, '先行成功');
    plan.toolFinished('failed', true, '随后失败');
    expect(plan.snapshot!.steps[0]).toMatchObject({ status: 'blocked', reason: '随后失败' });
  });
});

describe('收窄计划与真实进度', () => {
  it('可删除已结算的当前未完成步骤，清理 activeStepId 且只发布一次修订', () => {
    const { plan, events, second } = fixture();
    const before = plan.snapshot!;
    let changed = 0;
    events.on('plan_changed', () => changed++);
    plan.update(before.revision, { steps: [{ id: second.id, title: second.title }] });
    expect(plan.snapshot).toMatchObject({
      revision: before.revision + 1,
      steps: [{ id: second.id, status: 'pending' }],
    });
    expect(plan.snapshot?.activeStepId).toBeUndefined();
    expect(plan.stepProgress).toBeUndefined();
    expect(changed).toBe(1);
    plan.update(plan.snapshot!.revision, { stepId: second.id, status: 'running' });
    expect(plan.stepProgress).toEqual({ stepId: second.id, successfulCalls: 0 });
    expect(() =>
      plan.update(plan.snapshot!.revision, {
        stepId: second.id,
        status: 'completed',
        evidence: '伪造依据',
      }),
    ).toThrow('No successful execution');
  });

  it.each(['remove', 'rename'] as const)(
    '%s 不得改变仍有工具在执行的步骤，失败保持原子性',
    (operation) => {
      const { plan, first, second } = fixture();
      plan.toolStarted('pending');
      const before = plan.snapshot!;
      const generation = plan.generation;
      expect(() =>
        plan.update(before.revision, {
          steps:
            operation === 'remove'
              ? [{ id: second.id, title: second.title }]
              : [
                  { id: first.id, title: '不同工作' },
                  { id: second.id, title: second.title },
                ],
        }),
      ).toThrow('in-flight');
      expect(plan.snapshot).toEqual(before);
      expect(plan.generation).toBe(generation);
      plan.toolFinished('pending', false, '实际结果');
      expect(plan.stepProgress).toEqual({ stepId: first.id, successfulCalls: 2 });
    },
  );

  it('保留相同步骤可复用进度，改名不能把旧证据当作新工作的成功记录', () => {
    const { plan, first, second } = fixture();
    plan.update(plan.snapshot!.revision, {
      steps: [
        { id: first.id, title: first.title },
        { id: second.id, title: second.title },
      ],
    });
    expect(plan.stepProgress?.successfulCalls).toBe(1);
    plan.update(plan.snapshot!.revision, {
      steps: [
        { id: first.id, title: '不同工作' },
        { id: second.id, title: second.title },
      ],
    });
    expect(plan.stepProgress?.successfulCalls).toBe(0);
    expect(() =>
      plan.update(plan.snapshot!.revision, {
        stepId: first.id,
        status: 'completed',
        evidence: '旧证据',
      }),
    ).toThrow('No successful execution');
  });

  it('未登记的结果和恢复历史不能增加成功记录，真实失败清除进度', () => {
    const { plan, first } = fixture();
    plan.toolFinished('unregistered', false, '不能伪造');
    expect(plan.stepProgress?.successfulCalls).toBe(1);
    plan.toolStarted('failed');
    plan.toolFinished('failed', true, '执行失败');
    expect(plan.stepProgress).toBeUndefined();
    plan.update(plan.snapshot!.revision, { stepId: first.id, status: 'running' });
    expect(plan.stepProgress?.successfulCalls).toBe(0);
    plan.toolStarted('success');
    plan.toolFinished('success', false, '已执行');
    plan.restore(plan.snapshot);
    plan.resume();
    plan.update(plan.snapshot!.revision, { stepId: first.id, status: 'running' });
    expect(plan.stepProgress?.successfulCalls).toBe(0);
  });

  it.each(['completed', 'child', 'denied'] as const)('收窄计划不能移除 %s 的约束', (condition) => {
    const { plan, first, second } = fixture();
    if (condition === 'completed')
      plan.update(plan.snapshot!.revision, {
        stepId: first.id,
        status: 'completed',
        evidence: '已核对',
      });
    if (condition === 'child')
      plan.bindChild(first.id, { agentId: 'child', runId: 'r', name: 'child' });
    if (condition === 'denied') plan.deny('用户明确拒绝');
    const before = plan.snapshot!;
    expect(() =>
      plan.update(before.revision, { steps: [{ id: second.id, title: second.title }] }),
    ).toThrow();
    expect(plan.snapshot).toEqual(before);
  });
});

describe('只读任务拒绝后的状态边界', () => {
  it.each([
    {
      name: '未知执行与格式化',
      kind: 'execute',
      scope: 'project',
      reasonCode: 'powershell_unresolved',
      completeness: 'partial',
      blocked: false,
    },
    {
      name: '已知执行',
      kind: 'execute',
      scope: 'project',
      completeness: 'complete',
      blocked: true,
    },
    { name: '写入', kind: 'write', scope: 'project', completeness: 'partial', blocked: true },
    { name: '网络', kind: 'network', scope: 'unknown', completeness: 'partial', blocked: true },
    { name: '敏感读取', kind: 'read', scope: 'sensitive', completeness: 'partial', blocked: true },
    { name: '项目外读取', kind: 'read', scope: 'external', completeness: 'partial', blocked: true },
    {
      name: '危险命令',
      kind: 'unknown',
      scope: 'unknown',
      reasonCode: 'shell_dangerous',
      completeness: 'unknown',
      blocked: true,
    },
  ] as const)(
    '$name：拒绝调用，按风险保留步骤状态',
    ({ kind, scope, reasonCode, completeness, blocked }) => {
      const { plan } = fixture();
      const analysis: ToolAnalysis = {
        analyzerId: 'test',
        analyzerVersion: '1',
        completeness,
        effects: [
          { kind: 'unknown', scope: 'unknown' },
          { kind, scope },
        ],
        reasonCode,
      };
      const input: PolicyInput = {
        tool: { name: 'test', description: '', risk: 'execute', inputSchema: {} },
        input: {},
        cwd: process.cwd(),
        toolCallId: 'restricted',
        analysis,
      };
      plan.toolStarted('restricted');
      const reason = plan.restrict(input);
      expect(reason).toContain('task_read_only');
      plan.toolFinished('restricted', true, reason!);
      expect(plan.snapshot!.steps[0].status).toBe(blocked ? 'blocked' : 'running');
    },
  );
});
