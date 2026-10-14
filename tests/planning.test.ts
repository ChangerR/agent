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
import type { UserMessage } from '../src/core/protocol/types.js';
import { PlanController, type Plan } from '../src/core/plan.js';
import { EventBus } from '../src/core/events.js';
import { planLines } from '../src/builtin/planning/tui.js';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { requestPlan } from './helpers/runtime-plan.js';
import { toOpenAIMessages } from '../src/providers/openai.js';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import type { AgentEvent } from '../src/core/events.js';
import { assertSafeHistory } from '../src/core/session/history.js';
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
    platform?: NodeJS.Platform;
    /** 语义规划请求单独编排，执行剧本不再隐式假定规划器存在。 */
    planning?: ScriptedResponse[];
  } = {},
) {
  const cwd = await mkdtempProject(join(tmpdir(), 'agent-planning-'));
  const fake = new FakeProvider(script);
  const planner = new FakeProvider(options.planning ?? [() => textResponse('null')]);
  const provider = definePlugin({
    manifest: { id: 'test.planning', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.provider('planning-test', {
        name: 'planning-test',
        capabilities: fake.capabilities,
        async *stream(req, signal) {
          if (req.system.startsWith('[agentlab planning:auto]')) {
            yield* planner.stream(req, signal);
            return;
          }
          await options.before?.(req, signal);
          yield* fake.stream(req, signal);
        },
      });
    },
  });
  const agent = await createAgent(cwd, {
    plugins: [
      provider,
      ...(options.platform
        ? [
            definePlugin({
              manifest: { id: 'test.planning-platform', version: '1.0.0', apiVersion: 1 },
              setup(ctx) {
                ctx.provide.policy(
                  'planning-platform',
                  createDeterministicPolicy({
                    cwd,
                    platform: options.platform,
                    mode: options.config?.permissionMode ?? 'yolo',
                    rules: options.config?.permissions ?? { allow: [], ask: [], deny: [] },
                  }),
                );
              },
            }),
          ]
        : []),
      ...(options.plugins ?? []),
    ],
    autoSaveSessions: options.save ?? false,
    config: {
      provider: 'planning-test',
      model: 'current-model',
      permissionMode: 'yolo',
      capabilities: {
        reviewer: false,
        ...(options.platform ? { policy: 'planning-platform' } : {}),
      },
      ...options.config,
    },
  });
  cleanup.push(async () => {
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return { agent, cwd, fake, planner };
}
const from = requestPlan;
let callId = 0;
const call = (name: string, input: unknown, id = `${name}-${++callId}`) =>
  toolUseResponse([{ id, name, input }]);
const update = (req: ChatRequest, index: number, status: string, evidence?: string) => {
  const p = from(req);
  return call('plan_update', { revision: p.revision, stepId: p.steps[index].id, status, evidence });
};
const proposal: ScriptedResponse = (req) =>
  req.tools.length === 0
    ? textResponse(JSON.stringify({ goal: '修改并验证', steps: ['写入结果', '验证结果'] }))
    : call('plan_update', {
        revision: 0,
        goal: '修改并验证',
        steps: [{ title: '写入结果' }, { title: '验证结果' }],
      });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('项目浏览的委派与综合结案', () => {
  it('完成前一步后未启动下一步的 root 读取被计划门拦截；启动后原参数正常只读执行', async () => {
    const f = await fixture(
      [
        call('read_file', { path: 'ordinary.txt' }),
        (req) => {
          const p = from(req);
          return toolUseResponse([
            {
              id: 'finish-first',
              name: 'plan_update',
              input: {
                revision: p.revision,
                stepId: p.steps[0].id,
                status: 'completed',
                evidence: '已实际读取 ordinary.txt',
              },
            },
            { id: 'before-running', name: 'read_file', input: { path: 'ordinary.txt' } },
          ]);
        },
        (req) => update(req, 1, 'running'),
        call('read_file', { path: 'ordinary.txt' }, 'after-running'),
        (req) => update(req, 1, 'completed', '已实际读回 ordinary.txt'),
        textResponse('核对完成'),
      ],
      {
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
        planning: [textResponse(JSON.stringify({ goal: '核对', steps: ['读取', '验证'] }))],
      },
    );
    await writeFile(join(f.cwd, 'ordinary.txt'), 'EXACT_READ');
    const events: AgentEvent[] = [];
    f.agent.events.onAll((event) => events.push(event));
    expect((await f.agent.loop.run('只读取 ordinary.txt 并核对')).reason).toBe('completed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_execution',
        toolCallId: 'before-running',
        reasonCode: 'plan_step_required',
        decision: 'deny',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'after-running',
        result: expect.objectContaining({ content: expect.stringContaining('EXACT_READ') }),
      }),
    );
    expect(events.some((event) => event.type === 'permission_request')).toBe(false);
    expect(
      events.some((event) => event.type === 'model_request' && event.purpose === 'judge'),
    ).toBe(false);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
  });

  it.each(['off', 'auto'] as const)(
    '首次 %s 无计划仍传递模式，后续请求不重复追加相同空状态',
    async (mode) => {
      const f = await fixture([textResponse('收到'), textResponse('收到后续请求')], {
        config: {
          permissionMode: 'auto',
          capabilities: { reviewer: 'model' },
          pluginConfig: { 'agentlab.planning': { mode } },
        },
      });
      await f.agent.loop.run('你好');
      await f.agent.loop.run('再确认一下');
      expect(f.fake.requests).toHaveLength(2);
      for (const request of f.fake.requests) {
        const states = request.messages.filter(
          (message) => message.role === 'user' && message.source === 'runtime',
        );
        expect(states).toHaveLength(1);
        expect(JSON.parse(states[0].content as string)).toEqual({
          source: 'runtime_plan',
          owner: 'root',
          planningMode: mode,
          planningOnly: false,
          plan: null,
        });
      }
    },
  );

  it('失败后恢复历史再读取时不重复追加相同状态，也不重放失败请求', async () => {
    let first = true;
    const f = await fixture(
      [call('read_file', { path: 'ordinary.txt' }), textResponse('恢复后已读取')],
      {
        config: {
          permissionMode: 'auto',
          capabilities: { reviewer: 'model' },
          pluginConfig: { 'agentlab.planning': { mode: 'off' } },
        },
        before: async () => {
          if (first) {
            first = false;
            throw new Error('受控 provider 失败');
          }
        },
      },
    );
    await writeFile(join(f.cwd, 'ordinary.txt'), 'RESTORED_READ_OK');
    expect((await f.agent.loop.run('只读 ordinary.txt')).reason).toBe('error');
    expect(f.fake.requests).toHaveLength(0);
    const snapshot = f.agent.loop.exportSession();
    const original = snapshot.messages.find(
      (message) => message.role === 'user' && message.source === 'runtime',
    );
    expect(original).toBeDefined();
    f.agent.loop.importSession(JSON.parse(JSON.stringify(snapshot)));
    expect((await f.agent.loop.run('重试只读 ordinary.txt')).reason).toBe('completed');
    expect(f.fake.requests).toHaveLength(2);
    for (const request of f.fake.requests) {
      expect(
        request.messages.filter(
          (message) => message.role === 'user' && message.source === 'runtime',
        ),
      ).toEqual([original]);
    }
    expect(JSON.stringify(f.fake.requests[1].messages)).toContain('RESTORED_READ_OK');
  });

  it('压缩去掉旧状态后重新追加当前状态，保留真实工具结果与协议邻接', async () => {
    const compact = definePlugin({
      manifest: { id: 'test.runtime-compact', version: '1.0.0', apiVersion: 1 },
      setup(ctx) {
        ctx.provide.compactor('runtime-compact', {
          async compact(messages) {
            return messages.filter(
              (message) => message.role !== 'user' || message.source !== 'runtime',
            );
          },
        });
      },
    });
    const f = await fixture(
      [call('read_file', { path: 'ordinary.txt' }), textResponse('压缩后已核对')],
      {
        plugins: [compact],
        config: {
          permissionMode: 'auto',
          capabilities: { reviewer: 'model', compactor: 'runtime-compact' },
          pluginConfig: { 'agentlab.planning': { mode: 'off' } },
          compactThreshold: 1,
        },
      },
    );
    await writeFile(join(f.cwd, 'ordinary.txt'), 'COMPACT_READ_OK');
    const compacted = vi.fn();
    f.agent.events.on('compacted', compacted);
    expect((await f.agent.loop.run('只读 ordinary.txt')).reason).toBe('completed');
    expect(compacted).toHaveBeenCalled();
    expect(f.fake.requests).toHaveLength(2);
    for (const request of f.fake.requests) {
      const states = request.messages.filter(
        (message) => message.role === 'user' && message.source === 'runtime',
      );
      expect(states).toHaveLength(1);
      expect(JSON.parse(states[0].content as string)).toMatchObject({
        planningMode: 'off',
        planningOnly: false,
        plan: null,
      });
      assertSafeHistory(request.messages);
      expect(toOpenAIMessages(request.messages)).toBeDefined();
      expect(toAnthropicMessages(request.messages)).toBeDefined();
    }
    expect(JSON.stringify(f.fake.requests[1].messages)).toContain('COMPACT_READ_OK');
  });

  it('auto 真实读取与计划更新只追加状态，两个 adapter 保留之前完整前缀且不调用审批模型', async () => {
    const f = await fixture(
      [
        (req) => update(req, 0, 'running'),
        call('read_file', { path: 'ordinary.txt' }),
        (req) => update(req, 0, 'completed', '已读取 ordinary.txt 的真实内容'),
        (req) => update(req, 1, 'running'),
        call('read_file', { path: 'ordinary.txt' }),
        (req) => update(req, 1, 'completed', '重新读取并核对内容'),
        textResponse('两次读取已核对。'),
      ],
      {
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
        planning: [
          textResponse(
            JSON.stringify({ goal: '只读核对', steps: ['读取', '核对'], readOnly: true }),
          ),
        ],
      },
    );
    await writeFile(join(f.cwd, 'ordinary.txt'), 'PREFIX_READ_OK');
    const events: AgentEvent[] = [];
    f.agent.events.onAll((event) => events.push(event));
    expect((await f.agent.loop.run('只读 ordinary.txt 并再次核对，不修改文件')).reason).toBe(
      'completed',
    );
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(events.filter((event) => event.type === 'permission_request')).toHaveLength(0);
    expect(
      events.filter((event) => event.type === 'model_request' && event.purpose === 'judge'),
    ).toHaveLength(0);
    const results = events.filter(
      (event) => event.type === 'tool_result' && event.name === 'read_file',
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      if (result.type === 'tool_result') {
        expect(result.result.isError).not.toBe(true);
        expect(result.result.content).toContain('PREFIX_READ_OK');
      }
    }
    const requests = f.fake.requests;
    expect(new Set(requests.map((request) => request.system)).size).toBe(1);
    expect(requests[0].system).not.toContain('只读核对');
    expect(requests[0].system).not.toContain(f.agent.loop.plan.snapshot!.id);
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1];
      const current = requests[index];
      expect(current.tools).toEqual(previous.tools);
      for (const translate of [toOpenAIMessages, toAnthropicMessages]) {
        const prefix = translate(previous.messages);
        expect(translate(current.messages).slice(0, prefix.length)).toEqual(prefix);
      }
    }
    const states = requests
      .at(-1)!
      .messages.filter((message) => message.role === 'user' && message.source === 'runtime');
    expect(states.length).toBeGreaterThan(1);
    const payloads = states.map((state) => JSON.parse(state.content as string));
    expect(new Set(payloads.map((state) => state.plan.revision)).size).toBe(payloads.length);
    expect(
      payloads.every((state) => state.source === 'runtime_plan' && state.owner === 'root'),
    ).toBe(true);
    expect(
      events
        .filter((event) => event.type === 'model_usage')
        .map((event) => (event.type === 'model_usage' ? event.modelRole : undefined)),
    ).toContain('planner');
    expect(
      events
        .filter((event) => event.type === 'model_usage')
        .map((event) => (event.type === 'model_usage' ? event.modelRole : undefined)),
    ).toContain('main');
  });

  it.each([false, true])(
    'child直接执行与follow-up都不请求规划器（显式来源=%s）',
    async (provided) => {
      const f = await fixture(
        [
          call('read_file', { path: 'README.md' }),
          textResponse('检查完成'),
          textResponse('补充完成'),
        ],
        {
          planning: [
            () => {
              throw new Error('child 不得调用 planner');
            },
          ],
          config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
        },
      );
      await writeFile(join(f.cwd, 'README.md'), '只核对一项已有观察');
      const address = f.agent.agents.spawn(
        { task: '核对README并返回结论', readOnly: true, allowedTools: ['read_file'] },
        provided
          ? {
              sessionId: f.agent.session.id,
              agentId: 'root',
              runId: 'parent',
              source: 'user',
              userRequest: '浏览一下当前项目，看看优化点',
            }
          : undefined,
      );
      expect((await f.agent.agents.wait(address.agentId)).run.status).toBe('completed');
      await f.agent.agents.whenSettled();
      const followup = f.agent.agents.send(address.agentId, '仅补充一项观察');
      expect(
        (await f.agent.agents.wait(address.agentId, { runId: followup.runId })).run.status,
      ).toBe('completed');
      await f.agent.agents.whenSettled();
      expect(f.planner.requests).toHaveLength(0);
      expect(f.fake.requests).toHaveLength(3);
      expect(f.agent.agents.plan(address.agentId).snapshot).toBeUndefined();
      for (const req of f.fake.requests)
        expect(req.tools.map((t) => t.name)).toEqual(['read_file']);
    },
  );
  it('恢复后child显式续跑仍无独立planner，强制标记不能重新启动规划器', async () => {
    const f = await fixture(
      [
        call('read_file', { path: 'README.md' }),
        textResponse('first'),
        call('read_file', { path: 'README.md' }),
        textResponse('followup'),
      ],
      {
        save: true,
        planning: [
          () => {
            throw new Error('不得请求child规划器');
          },
        ],
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
      },
    );
    await writeFile(join(f.cwd, 'README.md'), 'resume evidence');
    const child = f.agent.agents.spawn({ task: '读取一处', readOnly: true });
    f.agent.agents.plan(child.agentId).configure('auto');
    f.agent.agents.plan(child.agentId).force = true;
    await f.agent.agents.wait(child.agentId);
    await f.agent.agents.whenSettled();
    await f.agent.session.save();
    await f.agent.session.resume(f.agent.session.id);
    const next = f.agent.agents.send(child.agentId, '同范围再核对');
    expect((await f.agent.agents.wait(child.agentId, { runId: next.runId })).run.status).toBe(
      'completed',
    );
    await f.agent.agents.whenSettled();
    expect(f.planner.requests).toHaveLength(0);
    expect(f.fake.requests).toHaveLength(4);
    expect(f.agent.agents.plan(child.agentId).snapshot).toBeUndefined();
    expect(
      f.fake.requests.every((r) =>
        r.tools.every((t) => !t.name.startsWith('agent_') && !t.name.startsWith('plan_')),
      ),
    ).toBe(true);
  });
  it.each(['plan_update', 'plan_status', 'agent_spawn', 'agent_send'])(
    'child不能伪造调用父级控制工具 %s，即使白名单显式允许',
    async (name) => {
      const input =
        name === 'plan_update'
          ? { revision: 0, goal: '重复父任务', steps: [{ title: '重新规划' }] }
          : name === 'agent_spawn'
            ? { task: '孙任务' }
            : name === 'agent_send'
              ? { agentId: 'sibling', message: '转委派' }
              : {};
      const f = await fixture([call(name, input), textResponse('停止')], {
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
      });
      const errors: string[] = [];
      f.agent.events.on('subagent_event', (e) => {
        const d = e.detail as
          { type?: string; result?: { isError?: boolean; content: string } } | undefined;
        if (d?.type === 'tool_result' && d.result?.isError) errors.push(d.result.content);
      });
      const address = f.agent.agents.spawn({
        task: '只执行范围内工作',
        allowedTools: [name, 'read_file'],
      });
      await f.agent.agents.wait(address.agentId);
      await f.agent.agents.whenSettled();
      expect(errors.some((e) => e.includes('outside child allowedTools'))).toBe(true);
      expect(f.agent.agents.status()).toHaveLength(1);
      expect(f.agent.agents.plan(address.agentId).snapshot).toBeUndefined();
      expect(f.planner.requests).toHaveLength(0);
      expect(f.fake.requests.every((r) => r.tools.every((t) => t.name === 'read_file'))).toBe(true);
    },
  );
  it('child直接执行仍遵守显式deny，不能通过省略规划扩大授权', async () => {
    const f = await fixture([call('read_file', { path: 'README.md' }), textResponse('停止')], {
      config: {
        permissionMode: 'auto',
        capabilities: { reviewer: 'model' },
        permissions: { allow: [], ask: [], deny: ['read_file'] },
      },
    });
    await writeFile(join(f.cwd, 'README.md'), '不得读取');
    const address = f.agent.agents.spawn({ task: '读取', allowedTools: ['read_file'] });
    const result = await f.agent.agents.wait(address.agentId);
    await f.agent.agents.whenSettled();
    expect(result.run.reason).toBe('permission_denied');
    expect(result.run.status).toBe('failed');
    expect(f.planner.requests).toHaveLength(0);
  });
  it('child无本地计划，完成与下一步准确反映在父计划', async () => {
    const f = await fixture(
      [
        call('read_file', { path: 'README.md' }),
        textResponse('已核对README，建议补充生命周期观测'),
      ],
      { config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } } },
    );
    await writeFile(join(f.cwd, 'README.md'), '项目说明');
    const p = f.agent.loop.plan;
    p.create('核对并汇总', ['有限检查', '父任务汇总'], 'auto', true);
    const [work, summary] = p.snapshot!.steps;
    const address = f.agent.agents.spawn({
      task: '只读README',
      readOnly: true,
      allowedTools: ['read_file'],
      planStepId: work.id,
    });
    expect(p.snapshot!.steps[0].status).toBe('running');
    expect(p.snapshot!.steps[1].status).toBe('pending');
    expect((await f.agent.agents.wait(address.agentId)).run.status).toBe('completed');
    await f.agent.agents.whenSettled();
    expect(p.snapshot!.steps[0].children[0].status).toBe('completed');
    expect(p.snapshot!.steps[1].status).toBe('pending');
    p.update(p.snapshot!.revision, {
      stepId: work.id,
      status: 'completed',
      evidence: '已核对child实际读取结果',
    });
    p.update(p.snapshot!.revision, { stepId: summary.id, status: 'running' });
    expect(p.snapshot!.activeStepId).toBe(summary.id);
    p.update(p.snapshot!.revision, {
      stepId: summary.id,
      status: 'completed',
      evidence: '依据已读项目说明完成汇总',
      evidenceStepIds: [work.id],
    });
    expect(p.snapshot!.phase).toBe('completed');
    expect(f.agent.agents.plan(address.agentId).snapshot).toBeUndefined();
    expect(f.planner.requests).toHaveLength(0);
  });
  it('综合依据只接受当前只读计划中之前真正完成的步骤，不能绕过失败child', () => {
    const p = new PlanController(new EventBus());
    p.create('浏览', ['读取', '总结'], 'auto', true);
    const [read, summary] = p.snapshot!.steps;
    p.update(p.snapshot!.revision, { stepId: read.id, status: 'running' });
    p.toolStarted('read');
    p.toolFinished('read', false, '真实读取');
    p.update(p.snapshot!.revision, { stepId: read.id, status: 'completed', evidence: '已读' });
    p.update(p.snapshot!.revision, { stepId: summary.id, status: 'running' });
    for (const id of ['unknown', summary.id])
      expect(() =>
        p.update(p.snapshot!.revision, {
          stepId: summary.id,
          status: 'completed',
          evidence: '总结',
          evidenceStepIds: [id],
        }),
      ).toThrow('earlier completed');
    p.bindChild(summary.id, { agentId: 'child', runId: 'run', name: '检查' });
    expect(() =>
      p.update(p.snapshot!.revision, {
        stepId: summary.id,
        status: 'completed',
        evidence: '总结',
        evidenceStepIds: [read.id],
      }),
    ).toThrow('Child work has not completed');
  });
  it('写入计划不能借只读综合引用伪造执行证据', () => {
    const p = new PlanController(new EventBus());
    p.create('实施', ['读取', '修改'], 'auto');
    const [read, write] = p.snapshot!.steps;
    p.update(p.snapshot!.revision, { stepId: read.id, status: 'running' });
    p.toolStarted('read');
    p.toolFinished('read', false, '已读');
    p.update(p.snapshot!.revision, { stepId: read.id, status: 'completed', evidence: '已读' });
    p.update(p.snapshot!.revision, { stepId: write.id, status: 'running' });
    expect(() =>
      p.update(p.snapshot!.revision, {
        stepId: write.id,
        status: 'completed',
        evidence: '伪造修改完成',
        evidenceStepIds: [read.id],
      }),
    ).toThrow('read-only');
  });
});

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
    // Windows 的普通写入仍需精确授权；本用例只授权隔离项目中的合成文件。
    f.agent.permission.addSessionRule('allow', 'write_file(="result.txt")');
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
    expect(f.fake.requests[0].tools.some((tool) => tool.name === 'plan_update')).toBe(true);
  });
  it('简单问答不建计划，显式 only 入口总是规划且保存配置', async () => {
    const f = await fixture([textResponse('你好'), proposal, textResponse('计划供审阅')]);
    await f.agent.loop.run('你好');
    expect(f.fake.requests).toHaveLength(1);
    expect(f.planner.requests).toHaveLength(1);
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
    f.agent.loop.plan.force = true;
    expect((await f.agent.loop.run('实现并测试')).reason).toBe('error');
    expect(f.fake.requests).toHaveLength(2);
    expect(f.fake.requests.every((request) => request.tools.length === 0)).toBe(true);
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
    f.agent.permission.addSessionRule('allow', 'write_file(="executed.txt")');
    f.agent.events.on('permission_request', approvals);
    await f.agent.dispatchCommand('/plan execute');
    expect(await readFile(join(f.cwd, 'executed.txt'), 'utf8')).toBe('yes');
    expect(f.fake.requests[2].tools.some((t) => t.name === 'write_file')).toBe(true);
    expect(approvals).not.toHaveBeenCalled();
  });
});

describe('直接描述任务，自动规划并持续执行', () => {
  it('查看项目优化点：执行模型不创建计划，也会先发布计划和当前步骤再读取项目', async () => {
    const task = '帮我看下当前的项目，看看还有什么优化点';
    const f = await fixture(
      [
        call('read_file', { path: 'README.md' }),
        (req) => update(req, 0, 'completed', 'README 描述项目结构'),
        (req) => update(req, 1, 'running'),
        call('read_file', { path: 'service.ts' }),
        (req) => update(req, 1, 'completed', 'service.ts 存在重复遍历'),
        (req) => update(req, 2, 'running'),
        call('read_file', { path: 'service.ts' }),
        (req) => update(req, 2, 'completed', '已重新核对重复遍历位置与影响'),
        textResponse('建议合并重复遍历，未修改文件。'),
      ],
      {
        planning: [
          (req) => {
            expect(req.messages.at(-1)?.content).toBe(task);
            expect(req.system).toContain('优化点');
            expect(req.system).toContain('不安排修改、安装或部署');
            return textResponse(
              JSON.stringify({
                goal: '检查项目优化点',
                steps: ['了解项目结构', '分析代码问题', '核对优化建议'],
              }),
            );
          },
        ],
        before: async (req) => {
          const plan = from(req);
          if (f.fake.requests.length === 0) expect(plan.steps[0].status).toBe('running');
        },
      },
    );
    await writeFile(join(f.cwd, 'README.md'), '项目说明');
    await writeFile(join(f.cwd, 'service.ts'), 'items.map(f); items.map(g);');
    const sequence: string[] = [];
    f.agent.events.on('plan_changed', (event) => {
      if (event.plan?.steps[0].status === 'running') sequence.push('current');
    });
    f.agent.events.on('tool_call', (event) => sequence.push(event.toolUse.name));
    await f.agent.loop.run(task);
    expect(f.planner.requests).toHaveLength(1);
    expect(sequence.indexOf('current')).toBeLessThan(sequence.indexOf('read_file'));
    expect(sequence).not.toContain('write_file');
    expect(sequence).not.toContain('bash');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(await readFile(join(f.cwd, 'service.ts'), 'utf8')).toBe('items.map(f); items.map(g);');
    await expect(readFile(join(f.cwd, 'agent.config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('默认规划无效时明确报错，不能静默跳过计划开始实施', async () => {
    const f = await fixture([call('write_file', { path: 'no.txt', content: 'no' })], {
      planning: [textResponse('我准备先看代码')],
    });
    expect((await f.agent.loop.run('帮我看下当前的项目，看看还有什么优化点')).reason).toBe('error');
    expect(f.fake.requests).toHaveLength(0);
    await expect(readFile(join(f.cwd, 'no.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('普通任务保留对话上下文，自行建计划；两次中途汇报后继续至验证完成', async () => {
    const task = '就按刚才说的，把这件事做完';
    const f = await fixture(
      [
        textResponse('了解：result.txt 应包含 ok，并读回核对。'),
        (req) => {
          expect(req.messages.some((message) => message.content === 'result.txt 应包含 ok')).toBe(
            true,
          );
          expect(req.tools.some((tool) => tool.name === 'plan_update')).toBe(true);
          return proposal(req);
        },
        textResponse('计划已列好，接下来开始。'),
        (req) => {
          expect(
            [...req.messages].reverse().find((m) => m.role !== 'user' || m.source !== 'runtime'),
          ).toMatchObject({ role: 'user', source: 'tool' });
          return update(req, 0, 'running');
        },
        call('write_file', { path: 'result.txt', content: 'ok' }),
        (req) => update(req, 0, 'completed', '已写入 ok'),
        textResponse('文件已写入，接下来核对。'),
        (req) => update(req, 1, 'running'),
        call('read_file', { path: 'result.txt' }),
        (req) => update(req, 1, 'completed', '读回内容为 ok'),
        textResponse('已完成并验证'),
      ],
      { config: { permissionMode: 'ask' } },
    );
    const approvals: string[] = [];
    f.agent.events.on('permission_request', (event) => {
      approvals.push(event.request.runId!);
      event.resolve({ allow: true });
    });
    await f.agent.loop.run('result.txt 应包含 ok');
    const result = await f.agent.loop.run(task);
    expect(
      f.planner.requests
        .at(-1)
        ?.messages.some((message) => message.content === 'result.txt 应包含 ok'),
    ).toBe(true);
    expect(result.reason).toBe('completed');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(await readFile(join(f.cwd, 'result.txt'), 'utf8')).toBe('ok');
    expect(f.fake.requests).toHaveLength(11);
    expect(approvals.length).toBeGreaterThan(0);
    expect(new Set(approvals).size).toBe(1);
    expect(
      f.agent.loop
        .getMessages()
        .filter((message) => message.role === 'user' && message.source === 'tool'),
    ).toHaveLength(2);
    await expect(readFile(join(f.cwd, 'agent.config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('包含多个行动词的问答不会被关键词强制拆成执行计划', async () => {
    const f = await fixture([textResponse('实现是编写功能，测试是验证行为，部署是交付运行。')]);
    await f.agent.loop.run('实现、测试和部署各是什么意思？');
    expect(f.fake.requests).toHaveLength(1);
    expect(f.fake.requests[0].tools.length).toBeGreaterThan(0);
    expect(f.agent.loop.plan.snapshot).toBeUndefined();
  });

  it('连续空答只提醒一次，不耗尽预算或把未完成任务算作完成', async () => {
    const f = await fixture([proposal, textResponse('稍后执行'), textResponse('稍后执行')]);
    const result = await f.agent.loop.run('完成这个任务');
    expect(result.turns).toBe(3);
    expect(f.fake.requests).toHaveLength(3);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('blocked');
  });

  it('反复查询计划不是执行进度，不能重置空转保护', async () => {
    const f = await fixture([
      proposal,
      textResponse('接下来做'),
      call('plan_status', {}),
      textResponse('接下来做'),
    ]);
    await f.agent.loop.run('完成这个任务');
    expect(f.fake.requests).toHaveLength(4);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('blocked');
  });

  it('模型明确缺少用户信息时保留问题并停止，不自动催促实施', async () => {
    const f = await fixture([
      proposal,
      (req) => {
        const p = from(req);
        return call('plan_update', {
          revision: p.revision,
          stepId: p.steps[0].id,
          status: 'blocked',
          reason: '需要用户提供目标接口地址',
        });
      },
      textResponse('目标接口地址是什么？'),
    ]);
    await f.agent.loop.run('完成这个任务');
    expect(f.fake.requests).toHaveLength(3);
    expect(f.agent.loop.plan.snapshot!.steps[0].reason).toBe('需要用户提供目标接口地址');
  });

  it('用户拒绝工具后不因未完成计划重新请求执行', async () => {
    const f = await fixture(
      [
        proposal,
        (req) => update(req, 0, 'running'),
        call('write_file', { path: 'denied.txt', content: 'no' }),
        textResponse('写入被拒绝，任务未完成。'),
      ],
      { config: { permissionMode: 'ask' } },
    );
    const approvals = vi.fn((event: { resolve(value: { allow: boolean }): void }) =>
      event.resolve({ allow: false }),
    );
    f.agent.events.on('permission_request', approvals);
    await f.agent.loop.run('完成这个任务');
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(f.fake.requests).toHaveLength(4);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('blocked');
    await expect(readFile(join(f.cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('自动推进使用同一次运行的轮数预算', async () => {
    const f = await fixture([proposal, textResponse('接下来做')], { config: { maxTurns: 2 } });
    expect((await f.agent.loop.run('完成这个任务')).reason).toBe('max_turns');
    expect(f.fake.requests).toHaveLength(2);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('blocked');
  });

  it('输出截断不触发自动续跑', async () => {
    const truncated = textResponse('未完');
    const stop = truncated.find((event) => event.type === 'message_stop');
    if (stop?.type === 'message_stop') stop.stopReason = 'max_tokens';
    const f = await fixture([proposal, truncated]);
    expect((await f.agent.loop.run('完成这个任务')).reason).toBe('max_tokens');
    expect(f.fake.requests).toHaveLength(2);
  });

  it('含未执行工具调用的异常结束不把不完整历史带入续跑请求', async () => {
    const malformed = call('write_file', { path: 'unexpected.txt', content: 'no' });
    const stop = malformed.find((event) => event.type === 'message_stop');
    if (stop?.type === 'message_stop') stop.stopReason = 'end_turn';
    const f = await fixture([proposal, malformed]);
    await f.agent.loop.run('完成这个任务');
    expect(f.fake.requests).toHaveLength(2);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('blocked');
    await expect(readFile(join(f.cwd, 'unexpected.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('自动推进的内部消息不替换工具收到的原用户授权', async () => {
    const origins: unknown[] = [];
    const probe = definePlugin({
      manifest: { id: 'test.plan-origin', version: '1.0.0', apiVersion: 1 },
      setup(ctx) {
        ctx.provide.tool('origin_probe', {
          name: 'origin_probe',
          description: '记录隔离测试中的工具调用来源',
          risk: 'read',
          inputSchema: { type: 'object' },
          async execute(_input, context) {
            origins.push(context.invocation);
            return { content: '已核对' };
          },
        });
      },
    });
    const f = await fixture(
      [
        call('plan_update', { revision: 0, goal: '核对', steps: [{ title: '核对' }] }),
        textResponse('稍后核对'),
        (req) => update(req, 0, 'running'),
        call('origin_probe', {}),
        (req) => update(req, 0, 'completed', '核对成功'),
        textResponse('完成'),
      ],
      { plugins: [probe] },
    );
    f.agent.events.on('permission_request', (event) => event.resolve({ allow: true }));
    await f.agent.loop.run('核对当前结果');
    expect(origins).toEqual([
      expect.objectContaining({ source: 'user', userRequest: '核对当前结果' }),
    ]);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
  });

  it('续跑请求期间取消，迟到响应不能继续实施', async () => {
    const entered = gate();
    const f = await fixture(
      [proposal, textResponse('接下来做'), call('write_file', { path: 'late.txt', content: 'no' })],
      {
        before: async (req, signal) => {
          const last = [...req.messages]
            .reverse()
            .find((m) => m.role !== 'user' || m.source !== 'runtime');
          if (last?.role === 'user' && last.source === 'tool') {
            entered.resolve();
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          }
        },
      },
    );
    const running = f.agent.loop.run('完成这个任务');
    await entered.promise;
    await f.agent.dispatchCommand('/plan cancel');
    expect((await running).reason).toBe('aborted');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('cancelled');
    await expect(readFile(join(f.cwd, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
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

describe('PR #35/#36/#37 的 Windows 权限与规划续跑组合', () => {
  it('ask 模式的真实项目读取不打断自动续跑，保持原始用户来源并完成计划', async () => {
    const task = '读取 ordinary.txt 并核对检索结果';
    const f = await fixture(
      [
        call('plan_update', {
          revision: 0,
          goal: task,
          steps: [{ title: '读取文件' }, { title: '检索验证' }],
        }),
        textResponse('计划已经建立，接下来读取。'),
        (req) => {
          expect(
            [...req.messages].reverse().find((m) => m.role !== 'user' || m.source !== 'runtime'),
          ).toMatchObject({ role: 'user', source: 'tool' });
          return update(req, 0, 'running');
        },
        call('read_file', { path: 'ordinary.txt' }),
        (req) => update(req, 0, 'completed', 'read_file 返回 ordinary-sentinel'),
        textResponse('已读到内容，继续检索验证。'),
        (req) => update(req, 1, 'running'),
        call('grep', { pattern: 'ordinary-sentinel', path: '.', glob: 'ordinary.txt' }),
        (req) => update(req, 1, 'completed', 'grep 找到 ordinary.txt 中相同内容'),
        textResponse('读取和检索已核对完成'),
      ],
      { platform: 'win32', config: { permissionMode: 'ask' } },
    );
    await writeFile(join(f.cwd, 'ordinary.txt'), 'ordinary-sentinel');
    const approvals = vi.fn();
    f.agent.events.on('permission_request', approvals);
    expect((await f.agent.loop.run(task)).reason).toBe('completed');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(approvals).not.toHaveBeenCalled();
    expect(f.fake.requests).toHaveLength(10);
    expect(
      f.fake.requests.every((req) =>
        req.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === task &&
            (message.source ?? 'user') === 'user',
        ),
      ),
    ).toBe(true);
    expect(f.fake.requests.every((req) => req.tools.length > 0)).toBe(true);
    expect(await readFile(join(f.cwd, 'ordinary.txt'), 'utf8')).toBe('ordinary-sentinel');
  });
  it.each([
    ['sc .env replacement', 'sensitive_target'],
    ['sc ../outside.txt replacement', 'external_target'],
    ['git status', 'powershell_unknown'],
    ['rd -Recurse C:/', 'external_target'],
  ])('规划执行 %s 的精确 allow 不能越过约束；拒绝后不再自动重试', async (command, reasonCode) => {
    const f = await fixture(
      [
        proposal,
        (req) => update(req, 0, 'running'),
        call('bash', { command }),
        textResponse('操作被拒绝，计划保持阻塞'),
      ],
      { platform: 'win32', config: { permissionMode: 'auto' } },
    );
    await writeFile(join(f.cwd, '.env'), 'fixture-sentinel');
    f.agent.permission.addSessionRule('allow', `bash(=${JSON.stringify(command)})`);
    const approvals = vi.fn(
      (event: {
        request: { reasonCode?: string; summary: string };
        resolve(value: { allow: boolean }): void;
      }) => {
        event.resolve({ allow: false });
      },
    );
    f.agent.events.on('permission_request', approvals);
    await f.agent.loop.run('继续执行任务并完成验证');
    expect(approvals).toHaveBeenCalledTimes(1);
    expect(approvals.mock.calls[0]![0].request).toMatchObject({
      reasonCode,
      summary: `PowerShell: ${command}`,
    });
    if (command === 'rd -Recurse C:/')
      expect(approvals.mock.calls[0]![0].request).toMatchObject({
        analysisReasonCode: 'shell_dangerous',
      });
    expect(f.fake.requests).toHaveLength(4);
    expect(f.fake.requests.every((req) => req.tools.length > 0)).toBe(true);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('blocked');
    expect(await readFile(join(f.cwd, '.env'), 'utf8')).toBe('fixture-sentinel');
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
    expect(planLines(plan.snapshot, false, 3)).toHaveLength(1);
    expect(planLines(plan.snapshot, false, 3)[0]).toContain('进行中 · 步骤0');
    expect(planLines(plan.snapshot, true, 8).join('\n')).toContain('[待办] 步骤1');
    expect(planLines(plan.snapshot, true, 8)).toHaveLength(8);
    expect(planLines(plan.snapshot, true, 3)).toHaveLength(3);
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
  it('only禁止委派；明确execute后child直接实施，后续send仍无planner', async () => {
    const f = await fixture([
      call('write_file', { path: 'child-real.txt', content: 'child' }),
      textResponse('done'),
      textResponse('followup done'),
    ]);
    f.agent.permission.addSessionRule('allow', 'write_file(="child-real.txt")');
    await f.agent.dispatchCommand('/plan only');
    f.agent.loop.plan.create('目标', ['委派'], 'only');
    expect(() => f.agent.agents.spawn({ task: 'A' })).toThrow('plan_read_only');
    f.agent.loop.plan.execute();
    const id = f.agent.loop.plan.snapshot!.steps[0].id;
    const a = f.agent.agents.spawn({ task: 'A', planStepId: id });
    expect(f.agent.agents.plan(a.agentId).mode).toBe('off');
    expect((await f.agent.agents.wait(a.agentId)).run.status).toBe('completed');
    await f.agent.agents.whenSettled();
    expect(await readFile(join(f.cwd, 'child-real.txt'), 'utf8')).toBe('child');
    const follow = f.agent.agents.send(a.agentId, '补充说明');
    expect((await f.agent.agents.wait(a.agentId, { runId: follow.runId })).run.status).toBe(
      'completed',
    );
    expect(f.agent.agents.plan(a.agentId).snapshot).toBeUndefined();
    expect(f.planner.requests).toHaveLength(0);
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

it('暂停再取消的旧执行尚未结算时切 only，不覆盖取消终态且恢复保持取消', async () => {
  const entered = gate();
  const release = gate();
  const f = await fixture([textResponse('旧响应')], {
    save: true,
    config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
    before: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  f.agent.loop.plan.create('取消场景', ['等待旧响应', '验证'], 'auto');
  const active = f.agent.loop.run('检查任务');
  try {
    await entered.promise;
    await f.agent.dispatchCommand('/plan pause');
    await f.agent.dispatchCommand('/plan cancel');
    expect(f.agent.loop.hasPendingActivity).toBe(true);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('cancelled');
    await f.agent.dispatchCommand('/plan only');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('cancelled');
  } finally {
    release.resolve();
    await active;
  }
  await f.agent.session.save();
  await f.agent.session.resume(f.agent.session.id);
  expect(f.agent.loop.plan.snapshot?.phase).toBe('cancelled');
  expect(f.agent.loop.plan.mode).toBe('only');
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
    f.agent.permission.addSessionRule('allow', 'write_file(="result.txt")');
    plan.configure(mode);
    plan.create('创建文件', ['创建'], mode);
    if (mode === 'only') plan.execute();
    await f.agent.loop.run('执行当前计划');
    expect(plan.snapshot?.phase).toBe('completed');
    expect(plan.mode).toBe(mode);
    expect(plan.readOnly).toBe(mode === 'only');
    const state = [...f.fake.requests.at(-1)!.messages]
      .reverse()
      .find((message) => message.role === 'user' && message.source === 'runtime');
    expect(JSON.parse(state!.content as string)).toMatchObject({
      planningMode: 'auto',
      planningOnly: mode === 'only',
      plan: { phase: 'completed' },
    });
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

it('默认装配由父工具启动两个只读审查并重叠运行，先共享约定后委派再等待和核对', async () => {
  const task = '只读审查当前仓库的实现和测试，给出建议，不修改';
  const hold = gate();
  const entered = new Set<string>();
  const toolCalls: string[] = [];
  const origin = (req: ChatRequest) =>
    req.messages.find(
      (m): m is UserMessage =>
        m.role === 'user' && typeof m.content === 'string' && m.source !== 'subagent',
    );
  const calls = (req: ChatRequest, name: string) =>
    req.messages
      .flatMap((m) => (m.role === 'assistant' ? m.content : []))
      .filter((b) => b.type === 'tool_use' && b.name === name);
  const f = await fixture(
    [
      (req) => {
        const input = origin(req)!;
        if (input.source === 'delegation') {
          if (!calls(req, 'read_file').length)
            return call('read_file', {
              path: input.content === '审查实现' ? 'implementation.txt' : 'tests.txt',
            });
          return textResponse(`证据已核对：${input.content}`);
        }
        const p = from(req);
        if (!calls(req, 'read_file').length) return call('read_file', { path: 'AGENTS.md' });
        if (p.steps[0].status !== 'completed') return update(req, 0, 'completed', '已读取共享约定');
        if (!p.steps[1].children.length || !p.steps[2].children.length)
          return toolUseResponse(
            [1, 2]
              .filter((i) => !p.steps[i].children.length)
              .map((i) => ({
                id: `spawn-${i}-${++callId}`,
                name: 'agent_spawn',
                input: {
                  task: i === 1 ? '审查实现' : '审查测试',
                  planStepId: p.steps[i].id,
                  readOnly: true,
                },
              })),
          );
        if (!calls(req, 'agent_wait').length)
          return toolUseResponse(
            p.steps.slice(1, 3).map((s) => ({
              id: `wait-${s.id}-${++callId}`,
              name: 'agent_wait',
              input: { agentId: s.children[0].agentId, runId: s.children[0].runId },
            })),
          );
        for (const i of [1, 2])
          if (p.steps[i].status !== 'completed')
            return update(req, i, 'completed', `已读取并核对${p.steps[i].title}的完整结果`);
        if (p.steps[3].status === 'pending') return update(req, 3, 'running');
        if (calls(req, 'read_file').length === 1)
          return call('read_file', { path: 'implementation.txt' });
        if (p.steps[3].status !== 'completed')
          return update(req, 3, 'completed', '两份审查和原文件证据一致');
        return textResponse('已完成只读审查，建议减少重复遍历。');
      },
    ],
    {
      save: true,
      config: { maxTurns: 32 },
      planning: [
        (req) =>
          textResponse(
            origin(req)?.source === 'delegation'
              ? 'null'
              : JSON.stringify({
                  goal: '只读仓库审查',
                  readOnly: true,
                  steps: ['共享约定', '实现审查', '测试审查', '汇总核对'],
                }),
          ),
      ],
      before: async (req, signal) => {
        if (origin(req)?.source !== 'delegation') return;
        entered.add(String(origin(req)!.content));
        await Promise.race([
          hold.promise,
          new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          ),
        ]);
      },
    },
  );
  await Promise.all(
    ['AGENTS.md', 'implementation.txt', 'tests.txt'].map((path) =>
      writeFile(join(f.cwd, path), `${path}: shared evidence`),
    ),
  );
  f.agent.loop.setModel('selected-review-model');
  f.agent.events.on('tool_call', (event) => toolCalls.push(event.toolUse.name));
  const running = f.agent.loop.run(task);
  try {
    await vi.waitFor(() => expect(entered.size).toBe(2));
    await vi.waitFor(() =>
      expect(toolCalls.filter((name) => name === 'agent_wait')).toHaveLength(2),
    );
    const children = f.agent.agents.status();
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.readOnly && c.runs[0].status === 'running')).toBe(true);
    expect(() => f.agent.agents.spawn({ task: '第三份审查' })).toThrow('Running agent limit');
    expect(toolCalls.filter((name) => name === 'agent_spawn')).toHaveLength(2);
    expect(toolCalls.indexOf('read_file')).toBeLessThan(toolCalls.indexOf('agent_spawn'));
    expect(toolCalls.lastIndexOf('agent_spawn')).toBeLessThan(toolCalls.indexOf('agent_wait'));
    expect(f.agent.loop.plan.snapshot!.steps[3].status).toBe('pending');
  } finally {
    hold.resolve();
  }
  expect((await running).reason).toBe('completed');
  expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
  expect(f.agent.agents.status().every((c) => c.runs[0].status === 'completed')).toBe(true);
  expect(f.fake.requests.every((req) => req.model === 'selected-review-model')).toBe(true);
  expect(f.fake.requests.filter((req) => origin(req)?.source === 'delegation')).toHaveLength(4);
  expect(f.agent.loop.plan.snapshot?.readOnly).toBe(true);
});

it('任务只读范围自动继承，模型不能用显式false或已有宽权限child绕过', async () => {
  const hold = gate();
  const f = await fixture([textResponse('child')], { before: async () => hold.promise });
  const wide = f.agent.agents.spawn({ task: '旧实施任务' });
  f.agent.loop.plan.create('只研究', ['研究'], 'auto', true);
  const id = f.agent.loop.plan.snapshot!.steps[0].id;
  const child = f.agent.agents.spawn({ task: '不能写', readOnly: false, planStepId: id });
  expect(f.agent.agents.status(child.agentId)[0].readOnly).toBe(true);
  expect(() => f.agent.agents.send(wide.agentId, '帮我写')).toThrow('broader child permissions');
  expect(
    (await f.agent.invokeTool('write_file', { path: 'escape.txt', content: 'no' })).content,
  ).toContain('task_read_only');
  hold.resolve();
  await f.agent.agents.whenSettled();
});

it('兄弟的活动与运行事件不覆盖失败，也不令父在途响应失效', () => {
  const plan = new PlanController(new EventBus());
  plan.create('目标', ['两个审查'], 'auto');
  const id = plan.snapshot!.steps[0].id;
  for (const agentId of ['a', 'b']) plan.bindChild(id, { agentId, runId: agentId, name: agentId });
  const run = (runId: string, status: 'failed' | 'running', activity: string) => ({
    runId,
    task: '',
    status,
    activity,
    output: '',
    turns: 0,
    truncated: false,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    error: status === 'failed' ? '具体失败证据' : undefined,
  });
  const generation = plan.generation;
  plan.childChanged('a', 'a', run('a', 'failed', 'failed'));
  plan.childChanged('b', 'b', run('b', 'running', '等待模型'));
  const revision = plan.snapshot!.revision;
  plan.childChanged('b', 'b', run('b', 'running', '正在思考'));
  expect(plan.snapshot!.steps[0]).toMatchObject({ status: 'blocked', reason: '具体失败证据' });
  expect(plan.generation).toBe(generation);
  expect(plan.snapshot!.revision).toBe(revision);
});

it('child拒绝在根计划持久化，模型改running或换child均不能重试，显式继续才解锁', async () => {
  const f = await fixture(
    [call('write_file', { path: 'denied-child.txt', content: 'no' }), textResponse('被拒绝')],
    { save: true, config: { permissionMode: 'ask' } },
  );
  f.agent.loop.plan.create('实施', ['指定审查步骤'], 'auto');
  const stepId = f.agent.loop.plan.snapshot!.steps[0].id;
  const approvals = vi.fn((event: { resolve(value: { allow: boolean }): void }) =>
    event.resolve({ allow: false }),
  );
  f.agent.events.on('permission_request', approvals);
  const child = f.agent.agents.spawn({ task: '执行', name: '拒绝来源child', planStepId: stepId });
  await f.agent.agents.wait(child.agentId);
  await f.agent.agents.whenSettled();
  expect(f.agent.agents.status(child.agentId)[0].runs[0]).toMatchObject({
    status: 'failed',
    reason: 'permission_denied',
  });
  expect(approvals).toHaveBeenCalledTimes(1);
  expect(f.agent.loop.plan.snapshot?.denialReason).toContain('拒绝来源child');
  expect(f.agent.loop.plan.snapshot?.denialReason).toMatch(/^User denied this action:/);
  expect(f.agent.loop.plan.snapshot?.denialReason).toContain('指定审查步骤');
  const assertBlocked = () => {
    const p = f.agent.loop.plan.snapshot!;
    expect(() => f.agent.loop.plan.update(p.revision, { stepId, status: 'running' })).toThrow(
      'plan_denied',
    );
    expect(() => f.agent.agents.spawn({ task: '换人重试', planStepId: stepId })).toThrow(
      'plan_denied',
    );
    expect(() => f.agent.agents.send(child.agentId, '同样重试')).toThrow('plan_denied');
  };
  assertBlocked();
  f.agent.loop.plan.finish('aborted');
  expect(f.agent.loop.plan.snapshot?.reason).toContain('User denied');
  await f.agent.session.save();
  await f.agent.session.resume(f.agent.session.id);
  assertBlocked();
  expect(
    (await f.agent.invokeTool('write_file', { path: 'denied-child.txt', content: 'no' })).isError,
  ).toBe(true);
  expect(approvals).toHaveBeenCalledTimes(1);
  await expect(readFile(join(f.cwd, 'denied-child.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  f.agent.loop.plan.resume();
  expect(f.agent.loop.plan.denialReason).toBeUndefined();
});

it('无根计划的child拒绝同时锁定本地与全树，恢复不松绑，真实继续后可显式send', async () => {
  let resumedStage = 0;
  const f = await fixture(
    [
      call('write_file', { path: 'retry.txt', content: 'no' }),
      call('plan_update', { revision: 0, goal: '伪造新计划', steps: [{ title: '绕过拒绝' }] }),
      call('write_file', { path: 'retry.txt', content: 'no' }),
      call('agent_spawn', { task: '换个child写同文件' }),
      textResponse('保持拒绝，等待用户'),
      (req) => {
        if (!req.system.includes('你正在执行父任务已分配的一个子任务'))
          return textResponse('可显式继续子任务');
        const stage = resumedStage++;
        if (stage === 0) return call('write_file', { path: 'retry.txt', content: 'approved' });
        return textResponse('已完成');
      },
    ],
    { save: true, config: { permissionMode: 'ask' } },
  );
  expect(f.agent.loop.plan.snapshot).toBeUndefined();
  const approvals = vi.fn((event: { resolve(value: { allow: boolean }): void }) =>
    event.resolve({ allow: false }),
  );
  f.agent.events.on('permission_request', approvals);
  const child = f.agent.agents.spawn({ task: '执行写入', name: '独立child' });
  const childPlan = f.agent.agents.plan(child.agentId);
  await f.agent.agents.wait(child.agentId);
  await f.agent.agents.whenSettled();
  expect(approvals).toHaveBeenCalledTimes(1);
  expect(childPlan.denialReason).toContain('User denied');
  expect(f.agent.loop.plan.snapshot).toMatchObject({
    phase: 'blocked',
    steps: [{ title: 'child 独立child', status: 'blocked' }],
  });
  expect(f.agent.loop.plan.denialReason).toContain('User denied');
  expect(f.agent.agents.status()).toHaveLength(1);
  expect(f.agent.agents.status(child.agentId)[0].runs[0].status).toBe('failed');
  expect(() => f.agent.agents.spawn({ task: '根换人重试' })).toThrow('plan_denied');
  expect(() => f.agent.agents.send(child.agentId, '再试一次')).toThrow('plan_denied');
  await f.agent.session.save();
  await f.agent.session.resume(f.agent.session.id);
  expect(() => f.agent.agents.spawn({ task: '恢复后换人重试' })).toThrow('plan_denied');
  expect(f.agent.agents.plan(child.agentId).denialReason).toContain('User denied');
  await f.agent.dispatchCommand('/plan continue');
  approvals.mockImplementation((event) => event.resolve({ allow: true }));
  const resumed = f.agent.agents.send(child.agentId, '用户明确继续后的补充任务');
  expect((await f.agent.agents.wait(resumed.agentId, { runId: resumed.runId })).run.status).toBe(
    'completed',
  );
  expect(f.agent.agents.plan(child.agentId).denialReason).toBeUndefined();
  expect(approvals).toHaveBeenCalledTimes(2);
  expect(await readFile(join(f.cwd, 'retry.txt'), 'utf8')).toBe('approved');
});

it('旧根计划完成后后台child迟到拒绝建立新阻塞，下一轮不清掉拒绝', async () => {
  const hold = gate();
  const f = await fixture(
    [call('write_file', { path: 'late-denied.txt', content: 'no' }), textResponse('拒绝后结束')],
    {
      config: { permissionMode: 'ask' },
      before: async (req) => {
        if (!req.tools.some((tool) => tool.name === 'plan_update')) await hold.promise;
      },
    },
  );
  const child = f.agent.agents.spawn({ task: '后台工作', name: '迟到child' });
  const plan = f.agent.loop.plan;
  plan.create('旧根工作', ['旧步骤'], 'auto', true);
  const id = plan.snapshot!.steps[0].id;
  plan.update(plan.snapshot!.revision, { stepId: id, status: 'running' });
  plan.toolStarted('old');
  plan.toolFinished('old', false, '既有结果');
  plan.update(plan.snapshot!.revision, {
    stepId: id,
    status: 'completed',
    evidence: '旧工作已完成',
  });
  const completedId = plan.snapshot!.id;
  f.agent.events.on('permission_request', (e) => e.resolve({ allow: false }));
  hold.resolve();
  await f.agent.agents.wait(child.agentId);
  await f.agent.agents.whenSettled();
  expect(plan.snapshot).toMatchObject({
    phase: 'blocked',
    steps: [{ status: 'blocked', title: 'child 迟到child' }],
  });
  expect(plan.snapshot!.id).not.toBe(completedId);
  expect(plan.researchOnly).toBe(true);
  await f.agent.loop.run('说明当前阻塞');
  expect(plan.denialReason).toContain('User denied');
  expect(() => f.agent.agents.spawn({ task: '绕过旧完成状态' })).toThrow('plan_denied');
  plan.resume();
  expect(
    (await f.agent.invokeTool('write_file', { path: 'root-scope.txt', content: 'no' })).content,
  ).toContain('task_read_only');
});

it('一个child拒绝使兄弟已弹出审批绑定失效，迟到允许不能执行', async () => {
  const f = await fixture(
    [
      (req) => {
        const task = req.messages.find(
          (m) => m.role === 'user' && typeof m.content === 'string',
        )?.content;
        if (req.messages.length === 1)
          return call('write_file', { path: `${task}.txt`, content: 'no' });
        return textResponse('结束');
      },
    ],
    { config: { permissionMode: 'ask' } },
  );
  const requests: Array<{ resolve(value: { allow: boolean }): void }> = [];
  f.agent.events.on('permission_request', (e) => {
    requests.push(e);
  });
  const a = f.agent.agents.spawn({ task: 'first' });
  const b = f.agent.agents.spawn({ task: 'second' });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  requests[0].resolve({ allow: false });
  await vi.waitFor(() => expect(f.agent.loop.plan.denialReason).toContain('User denied'));
  requests[1].resolve({ allow: true });
  await Promise.all([f.agent.agents.wait(a.agentId), f.agent.agents.wait(b.agentId)]);
  await f.agent.agents.whenSettled();
  expect(requests).toHaveLength(2);
  await expect(readFile(join(f.cwd, 'first.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(f.cwd, 'second.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('根拒绝后明确继续仍改变审批版本，兄弟旧允许不能跨ABA边界复用', async () => {
  const f = await fixture(
    [
      (req) => {
        const task = req.messages.find(
          (m) => m.role === 'user' && typeof m.content === 'string',
        )?.content;
        if (req.messages.length === 1)
          return call('write_file', { path: `${task}.txt`, content: 'approved' });
        return textResponse('结束');
      },
    ],
    { config: { permissionMode: 'ask' } },
  );
  const requests: Array<{
    request: { input: unknown };
    resolve(value: { allow: boolean }): void;
  }> = [];
  f.agent.events.on('permission_request', (e) => {
    requests.push(e);
  });
  const a = f.agent.agents.spawn({ task: 'aba-first' });
  const b = f.agent.agents.spawn({ task: 'aba-second' });
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  const initial = f.agent.loop.plan.denialGeneration;
  requests[0].resolve({ allow: false });
  await vi.waitFor(() => expect(f.agent.loop.plan.denialReason).toContain('User denied'));
  // 直接调用受信任的用户恢复入口，保留兄弟旧审批以精确覆盖版本ABA。
  f.agent.loop.plan.resume();
  expect(f.agent.loop.plan.denialReason).toBeUndefined();
  expect(f.agent.loop.plan.denialGeneration).toBeGreaterThan(initial);
  requests[1].resolve({ allow: true });
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  const latePath = String((requests[1].request.input as { path: string }).path);
  await expect(readFile(join(f.cwd, latePath))).rejects.toMatchObject({ code: 'ENOENT' });
  requests[2].resolve({ allow: true });
  await Promise.all([f.agent.agents.wait(a.agentId), f.agent.agents.wait(b.agentId)]);
  await f.agent.agents.whenSettled();
  expect(await readFile(join(f.cwd, latePath), 'utf8')).toBe('approved');
});

describe('只读任务中未执行命令的安全替代', () => {
  const readonlyPlan = () =>
    textResponse(JSON.stringify({ goal: '读取并核对', steps: ['完成读取'], readOnly: true }));
  it('未知 Bash 一次失败后同批/后续专用读取直接完成，无需重启步骤', async () => {
    const f = await fixture(
      [
        toolUseResponse([
          { id: 'unsupported', name: 'bash', input: { command: 'ls -RL .' } },
          { id: 'safe-read', name: 'read_file', input: { path: 'README.md' } },
        ]),
        call('read_file', { path: 'README.md' }),
        (req) => update(req, 0, 'completed', '两次专用读取确认内容'),
        textResponse('已读到 replacement evidence'),
      ],
      {
        planning: [readonlyPlan],
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
      },
    );
    await writeFile(join(f.cwd, 'README.md'), 'replacement evidence');
    const tools: string[] = [],
      errors: string[] = [];
    let human = 0;
    f.agent.events.on('permission_request', (event) => {
      human++;
      event.resolve({ allow: false });
    });
    f.agent.events.on('tool_call', (event) => tools.push(event.toolUse.name));
    f.agent.events.on('tool_result', (event) => {
      if (event.result.isError) errors.push(event.result.content);
    });
    expect((await f.agent.loop.run('只读取并总结当前项目')).reason).toBe('completed');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(tools).toEqual(['read_file', 'read_file', 'plan_update']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('do not retry that shape or restart');
    expect(human).toBe(0);
    expect(f.fake.requests.every((request) => request.tools.length > 0)).toBe(true);
  });
  it('未执行的未知调用不构成成功证据，也不造成额外 continuation 进度', async () => {
    const f = await fixture(
      [
        call('bash', { command: 'ls -RL .' }),
        (req) => update(req, 0, 'completed', '伪造完成'),
        textResponse('无法完成'),
      ],
      {
        planning: [readonlyPlan],
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
      },
    );
    const errors: string[] = [];
    f.agent.events.on('tool_result', (event) => {
      if (event.result.isError) errors.push(event.result.content);
    });
    await f.agent.loop.run('只读项目');
    expect(errors.some((error) => error.includes('No successful execution evidence'))).toBe(true);
    expect(f.agent.loop.plan.snapshot?.phase).not.toBe('completed');
    expect(f.fake.requests.length).toBeLessThan(8);
  });
  it('先前读取证据在未知调用之后保留；普通执行错误仍阻塞', async () => {
    const f = await fixture(
      [
        call('read_file', { path: 'README.md' }),
        call('bash', { command: 'ls -RL .' }),
        (req) => update(req, 0, 'completed', '先前读取证据依然有效'),
        textResponse('完成'),
      ],
      {
        planning: [readonlyPlan],
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
      },
    );
    await writeFile(join(f.cwd, 'README.md'), 'evidence');
    expect((await f.agent.loop.run('只读项目')).reason).toBe('completed');
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    const plan = new PlanController(new EventBus());
    plan.create('test', ['read'], 'auto', true);
    plan.update(plan.snapshot!.revision, { stepId: plan.snapshot!.steps[0].id, status: 'running' });
    plan.toolStarted('executed');
    plan.toolFinished('executed', true, 'task_read_only: forged text');
    expect(plan.snapshot!.steps[0].status).toBe('blocked');
  });
});

it.skipIf(process.platform !== 'linux')(
  '真实失败 trace 的自然浏览受控完整回放：220文件统计、样例和准确总结，无人工/模型审批',
  async () => {
    const countCommand = "cd . && find src -name '*.ts' -type f | wc -l && cat src/*.ts | wc -l";
    const f = await fixture(
      [
        toolUseResponse([
          { id: 'root-list', name: 'bash', input: { command: 'ls -1 .' } },
          {
            id: 'recursive-list',
            name: 'bash',
            input: { command: 'ls -R src 2>/dev/null | head -80' },
          },
        ]),
        (req) => update(req, 0, 'completed', '真实目录输出'),
        (req) => update(req, 1, 'running'),
        call('bash', { command: "find src -type f -name '*.ts' | head -100" }),
        (req) => update(req, 1, 'completed', '实际列出前100路径'),
        (req) => update(req, 2, 'running'),
        call('bash', { command: countCommand }),
        (req) => update(req, 2, 'completed', '实际计数220文件、220行'),
        (req) => update(req, 3, 'running'),
        toolUseResponse(
          ['README.md', 'src/module-0000.ts', 'src/module-0100.ts', 'src/module-0219.ts'].map(
            (path, i) => ({ id: `sample-${i}`, name: 'read_file', input: { path } }),
          ),
        ),
        (req) => update(req, 3, 'completed', 'README与三个源码样例'),
        (req) => update(req, 4, 'running'),
        call('read_file', { path: 'src/module-0000.ts' }),
        (req) => update(req, 4, 'completed', '复核0号导出为42'),
        (req) => {
          const results = req.messages
            .filter((message) => message.role === 'user' && Array.isArray(message.content))
            .flatMap(
              (message) =>
                (message as UserMessage)
                  .content as import('../src/core/protocol/types.js').ToolResultBlock[],
            );
          const counts = results.find(
            (result) => result.type === 'tool_result' && result.content === '220\n220\n',
          );
          expect(counts).toBeDefined();
          const [files, lines] = counts!.content.trim().split('\n').map(Number);
          const samples = [0, 100, 219].map((n) => {
            const result = results.find(
              (result) =>
                result.type === 'tool_result' &&
                result.content.includes(`export const value${n} =`),
            );
            return Number(result!.content.match(new RegExp(`value${n} = (\\d+)`))![1]);
          });
          return textResponse(
            `源码有${files}个TypeScript文件，共${lines}行。前三个抽样导出值为${samples.join('、')}；文件用于合成常量样例。路径仅展示前100项，统计涵盖全部文件。`,
          );
        },
      ],
      {
        planning: [
          textResponse(
            JSON.stringify({
              goal: '只读源码浏览',
              steps: ['目录结构', '前100路径', '完整统计', '阅读样例', '核对总结'],
              readOnly: true,
            }),
          ),
        ],
        config: { permissionMode: 'auto', capabilities: { reviewer: 'model' } },
      },
    );
    await import('node:fs/promises').then(async ({ mkdir }) => mkdir(join(f.cwd, 'src')));
    for (let i = 0; i < 220; i++)
      await writeFile(
        join(f.cwd, 'src', `module-${String(i).padStart(4, '0')}.ts`),
        `export const value${i} = ${i === 0 ? 42 : i};\n`,
      );
    await writeFile(join(f.cwd, 'README.md'), '合成TypeScript常量样例项目。');
    let human = 0,
      text = '';
    const errors: string[] = [];
    f.agent.events.on('permission_request', (event) => {
      human++;
      event.resolve({ allow: false });
    });
    f.agent.events.on('tool_result', (event) => {
      if (event.result.isError) errors.push(event.result.content);
    });
    f.agent.events.on('text_delta', (event) => {
      text += event.text;
    });
    expect(
      (
        await f.agent.loop.run(
          '请只浏览项目的 src 业务源码和 README.md：列出目录和前100个TypeScript文件路径，统计src下全部TypeScript文件数量和总行数，读取几个源码示例说明用途，最后用中文给出完整准确总结。根目录可查看名称，但不要读取任何运行时或权限配置内容。不修改、不联网、不委派。请实际完成。',
        )
      ).reason,
    ).toBe('completed');
    expect(errors).toEqual([]);
    expect(human).toBe(0);
    expect(f.fake.requests.every((request) => request.tools.length > 0)).toBe(true);
    expect(f.agent.loop.plan.snapshot?.phase).toBe('completed');
    expect(text).toContain('220个TypeScript文件，共220行');
    expect(text).toContain('42、100、219');
    expect(await readFile(join(f.cwd, 'src/module-0000.ts'), 'utf8')).toBe(
      'export const value0 = 42;\n',
    );
  },
);
