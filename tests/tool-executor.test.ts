import { mkdir, mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutor, type ToolExecutorOptions } from '../src/core/tool-executor.js';
import {
  EventBus,
  type AgentEvent,
  type PermissionRequest,
  type UserDecision,
} from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { PermissionController, createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/index.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { bashTool } from '../src/tools/bash.js';
import { editFileTool } from '../src/tools/edit.js';
import { writeFileTool } from '../src/tools/write.js';
import type { Policy, Reviewer, ToolAnalyzer } from '../src/sdk/capabilities.js';
import { emptyUsage } from '../src/core/protocol/types.js';
import { ToolScheduler } from '../src/core/tool-scheduler.js';
import { RequestPermissionGuard } from '../src/core/permission/request-scope.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
const allow: Policy = {
  id: 'allow-test',
  version: '1',
  decide: () => ({ kind: 'allow', source: 'config', reason: 'test allow' }),
};
const ask: Policy = {
  id: 'ask-test',
  version: '1',
  decide: () => ({ kind: 'ask', source: 'config', reason: 'test ask' }),
};
const review: Policy = {
  id: 'review-test',
  version: '1',
  decide: () => ({ kind: 'review', source: 'mode', reason: 'test review' }),
};
function fixture(options: Partial<ToolExecutorOptions> = {}) {
  const events = new EventBus();
  const tools = new ToolRegistry();
  const execute = vi.fn<Tool['execute']>(async () => ({ content: 'executed' }));
  const tool: Tool = {
    name: 'write',
    version: '1',
    description: 'test write',
    risk: 'write',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute,
  };
  tools.register(tool);
  const hooks = new HookRunner();
  const audits: Extract<AgentEvent, { type: 'tool_execution' }>[] = [];
  events.on('tool_execution', (event) => audits.push(event));
  const executor = new ToolExecutor({
    tools,
    events,
    hooks,
    cwd: process.cwd(),
    policy: allow,
    ...options,
  });
  const controller = new AbortController();
  const context = {
    signal: controller.signal,
    runId: 'run-test',
    userRequest: 'write requested file',
    messages: [],
  };
  const run = (input: unknown = { path: 'x' }, id = 'call-test') =>
    executor.execute({ type: 'tool_use', id, name: 'write', input }, context);
  return { tools, events, hooks, execute, tool, executor, controller, context, audits, run };
}

describe('ToolExecutor 唯一授权门', () => {
  it('无分隔符的自定义限制不冒充内核类别', async () => {
    const f = fixture({ restrict: () => 'plan_deniedX' });
    expect((await f.run()).isError).toBe(true);
    expect(f.audits).toContainEqual(
      expect.objectContaining({ phase: 'policy', reasonCode: 'execution_restriction' }),
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['plan_step_required', 'task_read_only', 'plan_denied'])(
    '限制 %s 保留脱敏类别，不再误记为 child 权限',
    async (code) => {
      const f = fixture({ restrict: () => `${code}: private task detail` });
      expect((await f.run()).isError).toBe(true);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.audits).toContainEqual(
        expect.objectContaining({ phase: 'policy', decision: 'deny', reasonCode: code }),
      );
      expect(JSON.stringify(f.audits)).not.toContain('private task detail');
    },
  );

  it('policy 等待期间新增限制仍在 judge 前拒绝，并留下脱敏审计', async () => {
    let restricted = false;
    const reviewer = { review: vi.fn() };
    const f = fixture({
      reviewer,
      policy: {
        ...review,
        decide: (input, signal) => {
          restricted = true;
          return review.decide(input, signal);
        },
      },
      restrict: () => (restricted ? 'private custom restriction' : undefined),
    });
    expect((await f.run()).isError).toBe(true);
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits).toContainEqual(
      expect.objectContaining({
        phase: 'policy',
        decision: 'deny',
        reasonCode: 'execution_restriction',
      }),
    );
    expect(JSON.stringify(f.audits)).not.toContain('private custom restriction');
  });

  it.each(['allow', 'ask', 'review'] as const)(
    '%s 不能借 invocation 范围绕过最终拒绝',
    async (kind) => {
      const approval = vi.fn(async () => ({ allow: false }));
      const f = fixture({
        policy: {
          ...allow,
          decide: () => ({
            kind,
            denialScope: 'invocation',
            source: 'config',
            reason: 'invalid scope',
          }),
        },
        approvalResponder: approval,
      });
      expect((await f.run()).isError).toBe(true);
      expect(approval).toHaveBeenCalledTimes(1);
      expect(f.audits.some((audit) => audit.reasonCode === 'policy_error')).toBe(true);
      expect((await f.run({ path: 'retry' }, 'retry')).content).toContain(
        'request_permission_denied',
      );
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it('最终 policy deny 终止当前请求，finishRun/换工具不能清除，新请求重新走策略', async () => {
    const policy: Policy = {
      ...allow,
      decide: (input) =>
        input.input.path === 'deny'
          ? { kind: 'deny', source: 'config', reason: 'explicit deny' }
          : allow.decide(input, new AbortController().signal),
    };
    const f = fixture({ policy });
    expect((await f.run({ path: 'deny' })).isError).toBe(true);
    f.executor.finishRun(f.context.runId);
    expect((await f.run({ path: 'other' }, 'other')).content).toContain(
      'request_permission_denied',
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      (
        await f.executor.invokeTool(
          'write',
          { path: 'other' },
          { ...f.context, runId: 'new-user-request' },
        )
      ).isError,
    ).toBeFalsy();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('普通工具错误不锁住请求，允许修复后重试', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({ content: 'ENOENT', isError: true });
    expect((await f.run()).isError).toBe(true);
    expect((await f.run({ path: 'correct' }, 'retry')).isError).toBeFalsy();
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('并发拒绝使迟到 allow+remember 失效，新请求成功也不复活旧批准', async () => {
    const rules = createDeterministicPolicy({
      cwd: process.cwd(),
      mode: 'ask',
      rules: { allow: [], ask: [], deny: [] },
    });
    const remember = vi.spyOn(rules.controller!, 'addSessionRule');
    const pending: ((decision: UserDecision) => void)[] = [];
    const f = fixture({
      policy: { ...ask, controller: rules.controller },
      approvalResponder: (request) =>
        (request.input as { path: string }).path === 'fresh'
          ? { allow: true }
          : new Promise<UserDecision>((resolve) => pending.push(resolve)),
    });
    const first = f.run({ path: 'deny' }, 'deny');
    const late = f.run({ path: 'late' }, 'late');
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]({ allow: false });
    expect((await first).isError).toBe(true);
    expect(
      (
        await f.executor.invokeTool(
          'write',
          { path: 'fresh' },
          { ...f.context, runId: 'fresh-user-direction' },
        )
      ).isError,
    ).toBeFalsy();
    pending[1]({ allow: true, remember: 'project' });
    expect((await late).content).toContain('request_permission_denied');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(['allow', 'deny'] as const)(
    '旧 reviewer 的迟到 %s 不执行，也不影响新用户请求',
    async (answer) => {
      let resolve!: (value: Awaited<ReturnType<Reviewer['review']>>) => void;
      const reviewer: Reviewer = {
        review: vi.fn<Reviewer['review']>(async (input) =>
          input.input.path === 'late'
            ? new Promise<Awaited<ReturnType<Reviewer['review']>>>((done) => {
                resolve = done;
              })
            : { decision: 'allow', reason: 'new authorized request', reasonCode: 'test' },
        ),
      };
      const f = fixture({
        reviewer,
        policy: {
          ...review,
          decide: (input) =>
            input.input.path === 'deny'
              ? { kind: 'deny', source: 'config', reason: 'explicit deny' }
              : { kind: 'review', source: 'mode', reason: 'review' },
        },
      });
      const late = f.run({ path: 'late' }, 'late');
      await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
      expect((await f.run({ path: 'deny' }, 'deny')).isError).toBe(true);
      resolve({ decision: answer, reason: 'late', reasonCode: 'test' });
      expect((await late).content).toContain('request_permission_denied');
      expect(
        (
          await f.executor.invokeTool(
            'write',
            { path: 'fresh' },
            { ...f.context, runId: 'fresh-user-direction' },
          )
        ).isError,
      ).toBeFalsy();
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('调度等待后的重验仍检查请求拒绝，不执行已排队调用', async () => {
    const requestPermission = new RequestPermissionGuard();
    const scheduler = new ToolScheduler();
    const held = await scheduler.acquire('write', new AbortController().signal);
    const f = fixture({ requestPermission, scheduler });
    const queued = f.run();
    await vi.waitFor(() => expect(f.audits.some((audit) => audit.phase === 'policy')).toBe(true));
    requestPermission.deny(`${f.audits[0].sessionId}:${f.context.runId}`);
    held.release();
    expect((await queued).content).toContain('request_permission_denied');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('tool_call 同步观察者触发拒绝后仍不得执行', async () => {
    const requestPermission = new RequestPermissionGuard();
    const f = fixture({ requestPermission });
    f.events.on('tool_call', () =>
      requestPermission.deny(`${f.audits[0].sessionId}:${f.context.runId}`),
    );
    expect((await f.run()).content).toContain('request_permission_denied');
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(['analyzer', 'policy', 'pre', 'revalidate', 'post'] as const)(
    '取消 %s 仅结束等待，实际能力和重验锁保留到原始 Promise 结算',
    async (phase) => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let start!: () => void;
      const entered = new Promise<void>((resolve) => {
        start = resolve;
      });
      const pause = async () => {
        start();
        await pending;
      };
      const scheduler = new ToolScheduler();
      const analysis = {
        analyzerId: 'test',
        analyzerVersion: '1',
        completeness: 'complete' as const,
        effects: [{ kind: 'write' as const, target: 'x' }],
      };
      const f = fixture({
        scheduler,
        analyzer: {
          async analyze() {
            if (phase === 'analyzer') await pause();
            return analysis;
          },
          async revalidate() {
            if (phase === 'revalidate') await pause();
            return true;
          },
        },
        policy: {
          async decide() {
            if (phase === 'policy') await pause();
            return { kind: 'allow', source: 'config', reason: 'test' };
          },
        },
      });
      if (phase === 'pre')
        f.hooks.register('PreToolUse', async () => {
          await pause();
          return {};
        });
      if (phase === 'post') f.hooks.register('PostToolUse', pause);
      const run = f.run();
      await entered;
      f.controller.abort();
      await run;
      expect(f.executor.hasPendingActivity).toBe(true);
      let lockEntered = false;
      const later = scheduler.acquire('write', new AbortController().signal).then((lease) => {
        lockEntered = true;
        lease.release();
      });
      await Promise.resolve();
      expect(lockEntered).toBe(!['revalidate', 'post'].includes(phase));
      finish();
      await f.executor.whenSettled();
      await later;
      expect(f.executor.hasPendingActivity).toBe(false);
      expect(f.execute).toHaveBeenCalledTimes(phase === 'post' ? 1 : 0);
    },
  );
  it('参数先校验，改写后重新校验；无效输入不进入审批或执行', async () => {
    const decide = vi.fn(allow.decide);
    const f = fixture({ policy: { ...allow, decide } });
    f.hooks.register('PreToolUse', () => ({ input: { path: 12 } }));
    expect((await f.run()).isError).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.at(-1)?.reasonCode).toBe('invalid_input_or_handler');
  });

  it('否定或分支 schema 的未知约束不能被忽略', async () => {
    const f = fixture();
    f.tool.inputSchema = { not: { unknownAssertion: true } };
    expect((await f.run()).content).toContain('Unsupported JSON Schema');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('null 工具参数不得隐式改成空对象', async () => {
    const f = fixture();
    f.tool.inputSchema = {};
    expect((await f.run(null)).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('冻结改写后的参数，reviewer 无 execute 句柄，工具执行的内容与批准一致', async () => {
    const seen: unknown[] = [];
    const reviewer: Reviewer = {
      async review(operation) {
        expect(Object.isFrozen(operation.input)).toBe(true);
        expect('execute' in operation.tool).toBe(false);
        seen.push(operation.input);
        return { decision: 'allow', reason: 'ok', reasonCode: 'model_allow' };
      },
    };
    const f = fixture({ policy: review, reviewer });
    const rewritten = { path: 'approved' };
    f.hooks.register('PreToolUse', () => ({ input: rewritten }));
    expect((await f.run()).isError).toBeUndefined();
    rewritten.path = 'after';
    expect(seen[0]).toEqual({ path: 'approved' });
    expect(f.execute.mock.calls[0][0]).toEqual({ path: 'approved' });
    expect(f.audits.find((e) => e.phase === 'execution')).toMatchObject({
      runId: 'run-test',
      toolCallId: 'call-test',
      reasonCode: 'tool_success',
      policyId: 'review-test',
    });
    expect(new Set(f.audits.map((e) => e.requestId)).size).toBe(1);
  });

  it.each(['ask', 'deny'] as const)('明确 %s 不调用 reviewer', async (kind) => {
    const reviewer: Reviewer = {
      review: vi.fn<Reviewer['review']>(async () => ({
        decision: 'allow',
        reason: 'override',
        reasonCode: 'bad',
      })),
    };
    const f = fixture({
      policy: { decide: () => ({ kind, source: 'config', reason: 'explicit' }) },
      reviewer,
    });
    expect((await f.run()).isError).toBe(true);
    expect(reviewer.review).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('无 responder 的 ask 立即终止；通用观测订阅不算 responder', async () => {
    const f = fixture({ policy: ask });
    f.events.onAll(() => {});
    expect((await f.run()).content).toContain('approval_required');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('子工具和 runtime.invokeTool 同样受到 deny 限制', async () => {
    const f = fixture({
      policy: {
        decide: ({ tool }) => ({
          kind: tool.name === 'write' ? 'deny' : 'allow',
          source: 'config',
          reason: 'rule',
        }),
      },
    });
    f.tools.register({
      ...f.tool,
      name: 'outer',
      inputSchema: {},
      execute: async (_input, context) => context.invokeTool!('write', { path: 'nested' }),
    });
    expect((await f.executor.invokeTool('outer', {}, f.context)).content).toContain(
      'Permission denied',
    );
    expect((await f.executor.invokeTool('write', { path: 'direct' }, f.context)).content).toContain(
      'request_permission_denied',
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.filter((e) => e.phase === 'policy')).toHaveLength(2);
    expect(f.audits.filter((e) => e.reasonCode === 'request_permission_denied')).toHaveLength(1);
  });

  it.each(['unknown', 'invalid', 'error', 'timeout'] as const)(
    '%s reviewer 不能放行且每次绑定至多请求一次',
    async (mode) => {
      const reviewer: Reviewer = {
        review: vi.fn<Reviewer['review']>(async () => {
          if (mode === 'error') throw new Error('secret provider error');
          if (mode === 'timeout') return new Promise(() => {});
          return { decision: mode, reason: 'uncertain', reasonCode: 'uncertain' } as never;
        }),
      };
      const f = fixture({ policy: review, reviewer, reviewTimeoutMs: 5 });
      const result = await f.run();
      expect(result.content).toContain('approval_required');
      expect(f.execute).not.toHaveBeenCalled();
      expect(reviewer.review).toHaveBeenCalledTimes(1);
    },
  );

  it('reviewer deny 是最终拒绝，不弹人工确认', async () => {
    const f = fixture({
      policy: review,
      reviewer: {
        review: async () => ({
          decision: 'deny',
          reason: 'out of scope',
          reasonCode: 'model_deny',
        }),
      },
    });
    const prompt = vi.fn();
    f.events.on('permission_request', prompt);
    expect((await f.run()).content).toContain('Permission denied');
    expect(prompt).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('审计控制器改写收到的 decision 副本不能把 reviewer deny 变为 allow', async () => {
    const controller = new PermissionController({
      mode: 'auto',
      rules: { allow: [], ask: [], deny: [] },
    });
    controller.recordDecision = (_tool, _input, decision) => {
      decision.kind = 'allow';
    };
    const f = fixture({
      policy: { ...review, controller },
      reviewer: {
        review: async () => ({
          decision: 'deny',
          reason: 'out of scope',
          reasonCode: 'model_deny',
        }),
      },
    });
    expect((await f.run()).content).toContain('Permission denied');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('reviewer 返回值先快照，getter 不能在验证后变为 allow', async () => {
    let reads = 0;
    const f = fixture({
      policy: review,
      reviewer: {
        review: async () => ({
          get decision() {
            return ++reads === 1 ? 'unknown' : 'allow';
          },
          reason: 'untrusted output',
          reasonCode: 'unknown',
        }),
      },
    });
    expect((await f.run()).content).toContain('approval_required');
    expect(reads).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('reviewer 只取得隔离的模型事件出口，不能订阅父审批 resolver', async () => {
    const intercepted = vi.fn();
    const usage = vi.fn();
    const f = fixture({
      policy: review,
      reviewer: {
        review: async ({ events }) => {
          events!.on('permission_request', intercepted);
          events!.emit({
            type: 'model_usage',
            requestId: 'model-request',
            purpose: 'agent',
            usage: emptyUsage(),
          });
          return { decision: 'unknown', reason: 'ask user', reasonCode: 'unknown' };
        },
      },
    });
    f.events.on('model_usage', usage);
    expect((await f.run()).content).toContain('approval_required');
    expect(intercepted).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'judge',
        requestId: 'model-request',
        runId: 'run-test',
        toolCallId: 'call-test',
        toolRequestId: f.audits[0].requestId,
      }),
    );
  });

  it('人工响应在 resolve 后被改写不改变已结算的拒绝', async () => {
    const f = fixture({ policy: ask });
    f.events.on('permission_request', ({ resolve }) => {
      const response: { allow: boolean } = { allow: false };
      resolve(response as UserDecision);
      response.allow = true;
    });
    expect((await f.run()).content).toContain('User denied');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('策略和分析异常保守询问，不读取错误中的 allow', async () => {
    const f = fixture({
      policy: {
        decide: () => {
          throw new Error('allow');
        },
      },
    });
    expect((await f.run()).content).toContain('approval_required');
    const analyzer: ToolAnalyzer = {
      analyze: () => {
        throw new Error('allow');
      },
    };
    const g = fixture({ analyzer });
    expect((await g.run()).content).toContain('approval_required');
    expect(f.execute).not.toHaveBeenCalled();
    expect(g.execute).not.toHaveBeenCalled();
  });

  it('策略返回可转换成 allow 的对象仍是非法结果', async () => {
    class ImplicitAllow {
      toString() {
        return 'allow';
      }
    }
    const f = fixture({
      policy: {
        decide: () =>
          ({ kind: new ImplicitAllow(), source: 'config', reason: 'bad type' }) as never,
      },
    });
    expect((await f.run()).content).toContain('approval_required');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['false', {}, undefined])('环境重验的非布尔返回 %j 不能被当作有效批准', async (value) => {
    const analyzer: ToolAnalyzer = {
      analyze: () => ({
        analyzerId: 'test',
        analyzerVersion: '1',
        completeness: 'complete',
        effects: [],
      }),
      revalidate: () => value as never,
    };
    const f = fixture({ analyzer });
    expect((await f.run()).content).toContain('approval_stale');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('取消后迟到批准无效，resolve 只能结算一次', async () => {
    const f = fixture({ policy: ask });
    let resolve!: (value: UserDecision) => void;
    f.events.on('permission_request', (event) => {
      resolve = event.resolve;
      f.controller.abort();
    });
    expect((await f.run()).content).toBe('Tool cancelled');
    resolve({ allow: true, remember: 'session' });
    resolve({ allow: true });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('配置 revision 变更使旧人工批准失效并重新询问', async () => {
    let revision = 1;
    const prompts: PermissionRequest[] = [];
    const responder = vi.fn(async (request: PermissionRequest) => {
      prompts.push(request);
      if (revision === 1) {
        revision = 2;
        return { allow: true } as const;
      }
      return { allow: false } as const;
    });
    const f = fixture({
      policy: ask,
      configRevision: () => revision,
      approvalResponder: responder,
    });
    expect((await f.run()).content).toContain('User denied');
    expect(responder).toHaveBeenCalledTimes(2);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.some((e) => e.reasonCode === 'approval_stale')).toBe(true);
    expect(new Set(prompts.map((prompt) => prompt.requestId)).size).toBe(2);
    expect(new Set(prompts.map((prompt) => prompt.toolRequestId)).size).toBe(1);
  });

  it('工具版本和实际执行函数变更使批准失效', async () => {
    const f = fixture({ policy: ask });
    const replacement = vi.fn(async () => ({ content: 'replaced' }));
    let requests = 0;
    f.events.on('permission_request', (event) => {
      requests++;
      if (requests === 1) {
        f.tool.version = '2';
        f.tool.execute = replacement;
        event.resolve({ allow: true });
      } else event.resolve({ allow: false });
    });
    await f.run();
    expect(requests).toBe(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('session 身份变化后旧批准失效，不把旧调用转移到新会话', async () => {
    let session = 'session-a';
    let requests = 0;
    const f = fixture({
      policy: ask,
      sessionId: () => session,
      approvalResponder: () => {
        if (++requests === 1) {
          session = 'session-b';
          return { allow: true };
        }
        return { allow: false };
      },
    });
    expect((await f.run()).content).toContain('approval_stale');
    expect(requests).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('结束的 run 与改变的宿主 capability 版本均不能消费旧批准', async () => {
    let active = true;
    const f = fixture({
      policy: ask,
      runActive: () => active,
      approvalResponder: () => {
        active = false;
        return { allow: true };
      },
    });
    expect((await f.run()).content).toContain('approval_stale');
    expect(f.execute).not.toHaveBeenCalled();
    let version = '1';
    let prompts = 0;
    const g = fixture({
      policy: ask,
      toolIdentity: () => ({ ownerPlugin: 'test-tools', capabilityId: 'write', version }),
      approvalResponder: () => {
        if (++prompts === 1) {
          version = '2';
          return { allow: true };
        }
        return { allow: false };
      },
    });
    await g.run();
    expect(prompts).toBe(2);
    expect(g.execute).not.toHaveBeenCalled();
    expect(g.audits.find((event) => event.phase === 'policy')).toMatchObject({
      toolOwner: 'test-tools',
      capabilityId: 'write',
      toolVersion: '1',
    });
  });

  it('policy 版本或 handler 替换不能使用旧批准', async () => {
    const policy = { ...ask };
    let prompts = 0;
    const f = fixture({
      policy,
      approvalResponder: () => {
        if (++prompts === 1) {
          policy.version = '2';
          policy.decide = () => ({ kind: 'deny', source: 'config', reason: 'new policy' });
          return { allow: true };
        }
        return { allow: true };
      },
    });
    expect((await f.run()).content).toContain('Permission denied');
    expect(prompts).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('tool_call 观测阶段的取消仍阻止实际执行', async () => {
    const f = fixture();
    f.events.on('tool_call', () => f.controller.abort());
    expect((await f.run()).content).toBe('Tool cancelled');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('renderer/telemetry 异常不能伪装工具结果或阻断其余订阅者', async () => {
    const f = fixture();
    const received = vi.fn();
    f.events.onAll(() => {
      throw new Error('observer failed');
    });
    f.events.on('tool_result', () => {
      throw new Error('renderer failed');
    });
    f.events.on('tool_result', received);
    expect((await f.run()).content).toBe('executed');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledTimes(1);
  });

  it('PostToolUse 永不完成也受超时边界约束，成功副作用不会被报告成失败', async () => {
    const f = fixture({ capabilityTimeoutMs: 5 });
    f.hooks.register('PostToolUse', () => new Promise(() => {}));
    const results = vi.fn();
    f.events.on('tool_result', results);
    expect((await f.run()).content).toBe('executed');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveBeenCalledTimes(1);
  });

  it('PostToolUse 等待期间取消，保留执行成功结果并立即释放等待', async () => {
    const f = fixture();
    f.hooks.register('PostToolUse', () => {
      f.controller.abort();
      return new Promise(() => {});
    });
    expect((await f.run()).content).toBe('executed');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('读取 revision 失败时仍生成唯一错误结果，不能执行', async () => {
    const f = fixture({
      configRevision: () => {
        throw new Error('configuration unavailable');
      },
    });
    const results = vi.fn();
    f.events.on('tool_result', results);
    expect((await f.run()).isError).toBe(true);
    expect(results).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('同 run 的 toolCallId 不会二次执行，一次调用只形成一个结果', async () => {
    const f = fixture();
    const results = vi.fn();
    f.events.on('tool_result', results);
    await f.run();
    expect((await f.run()).content).toContain('Duplicate');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveBeenCalledTimes(2);
  });

  it('项目脚本在等待期间变化后必须重新询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-script-'));
    folders.push(cwd);
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'node test.js' } }),
    );
    await writeFile(join(cwd, 'test.js'), 'safe');
    let requests = 0;
    const f = fixture({
      cwd,
      policy: createDeterministicPolicy({
        cwd,
        mode: 'ask',
        rules: { allow: [], ask: [], deny: [] },
      }),
      approvalResponder: async () => {
        if (++requests === 1) {
          await writeFile(join(cwd, 'test.js'), 'changed script');
          return { allow: true };
        }
        return { allow: false };
      },
    });
    f.tool.inputSchema = { type: 'object' };
    expect((await f.run({ command: 'npm test' })).content).toContain('User denied');
    expect(requests).toBe(2);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.some((e) => e.reasonCode === 'environment_changed')).toBe(true);
  });

  it('符号链接目标在审批期间切换后必须重新询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-link-'));
    folders.push(cwd);
    await writeFile(join(cwd, 'a'), 'a');
    await writeFile(join(cwd, 'b'), 'b');
    await symlink('a', join(cwd, 'link'));
    let requests = 0;
    const f = fixture({
      cwd,
      policy: createDeterministicPolicy({
        cwd,
        mode: 'ask',
        rules: { allow: [], ask: [], deny: [] },
      }),
      approvalResponder: async () => {
        if (++requests === 1) {
          await unlink(join(cwd, 'link'));
          await symlink('b', join(cwd, 'link'));
          return { allow: true };
        }
        return { allow: false };
      },
    });
    expect((await f.run({ path: 'link' })).content).toContain('User denied');
    expect(requests).toBe(2);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('并发审批里记住一条不会让已允许一次的另一次调用再次询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-concurrent-'));
    folders.push(cwd);
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src/a.ts'), 'before');
    const policy = createDeterministicPolicy({
      cwd,
      mode: 'ask',
      rules: { allow: [], ask: [], deny: [] },
    });
    const events = new EventBus();
    const tools = new ToolRegistry();
    const writeExecute = vi.fn(writeFileTool.execute.bind(writeFileTool));
    const editExecute = vi.fn(editFileTool.execute.bind(editFileTool));
    tools.register({
      ...writeFileTool,
      ownerPlugin: 'agentlab.local-tools',
      version: '1.0.0',
      execute: writeExecute,
    });
    tools.register({
      ...editFileTool,
      ownerPlugin: 'agentlab.local-tools',
      version: '1.0.0',
      execute: editExecute,
    });
    const requests: Array<{
      request: PermissionRequest;
      resolve: (decision: UserDecision) => void;
    }> = [];
    events.on('permission_request', (event) => {
      requests.push({ request: event.request, resolve: event.resolve });
    });
    const executor = new ToolExecutor({ tools, policy, events, hooks: new HookRunner(), cwd });
    const context = {
      signal: new AbortController().signal,
      runId: 'concurrent-remember',
      userRequest: 'update sources',
      messages: [],
    };
    const writing = executor.invokeTool(
      'write_file',
      { path: 'src/new.ts', content: 'x' },
      context,
    );
    const editing = executor.invokeTool(
      'edit_file',
      { path: 'src/a.ts', old_string: 'before', new_string: 'after' },
      context,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests
      .find((item) => item.request.toolName === 'write_file')!
      .resolve({
        allow: true,
        remember: 'session',
      });
    expect((await writing).isError).toBeFalsy();
    requests.find((item) => item.request.toolName === 'edit_file')!.resolve({ allow: true });
    expect((await editing).isError).toBeFalsy();
    expect(requests).toHaveLength(2);
    expect(writeExecute).toHaveBeenCalledTimes(1);
    expect(editExecute).toHaveBeenCalledTimes(1);
  });

  it('审批期间新增 deny 规则时，另一个已等待的调用被拒绝', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-deny-'));
    folders.push(cwd);
    await mkdir(join(cwd, 'src'), { recursive: true });
    const policy = createDeterministicPolicy({
      cwd,
      mode: 'ask',
      rules: { allow: [], ask: [], deny: [] },
    });
    const events = new EventBus();
    const tools = new ToolRegistry();
    const execute = vi.fn(writeFileTool.execute.bind(writeFileTool));
    tools.register({
      ...writeFileTool,
      ownerPlugin: 'agentlab.local-tools',
      version: '1.0.0',
      execute,
    });
    const requests: Array<{
      request: PermissionRequest;
      resolve: (decision: UserDecision) => void;
    }> = [];
    events.on('permission_request', (event) => {
      requests.push({ request: event.request, resolve: event.resolve });
    });
    const executor = new ToolExecutor({ tools, policy, events, hooks: new HookRunner(), cwd });
    const context = {
      signal: new AbortController().signal,
      runId: 'concurrent-deny',
      userRequest: 'update sources',
      messages: [],
    };
    const first = executor.invokeTool('write_file', { path: 'src/a.ts', content: 'a' }, context);
    const second = executor.invokeTool('write_file', { path: 'src/b.ts', content: 'b' }, context);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const pathOf = (request: PermissionRequest) =>
      request.input && typeof request.input === 'object' && 'path' in request.input
        ? request.input.path
        : undefined;
    const allowed = requests.find((item) => pathOf(item.request) === 'src/a.ts')!;
    const denied = requests.find((item) => pathOf(item.request) === 'src/b.ts')!;
    allowed.resolve({ allow: true, remember: 'session' });
    expect((await first).isError).toBeFalsy();
    policy.controller!.addSessionRule('deny', 'write_file(="src/b.ts")');
    denied.resolve({ allow: true });
    expect((await second).content).toContain('Permission denied');
    expect(requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('审批期间 configRevision 变化仍重新询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-config-'));
    folders.push(cwd);
    await mkdir(join(cwd, 'src'), { recursive: true });
    let revision = 1;
    const prompts: PermissionRequest[] = [];
    const responder = vi.fn(async (request: PermissionRequest) => {
      prompts.push(request);
      if (revision === 1) {
        revision = 2;
        return { allow: true } as const;
      }
      return { allow: false } as const;
    });
    const execute = vi.fn(async () => ({ content: 'wrote' }));
    const tools = new ToolRegistry();
    tools.register({
      ...writeFileTool,
      ownerPlugin: 'agentlab.local-tools',
      version: '1.0.0',
      execute,
    });
    const events = new EventBus();
    const audits: Extract<AgentEvent, { type: 'tool_execution' }>[] = [];
    events.on('tool_execution', (event) => audits.push(event));
    const executor = new ToolExecutor({
      tools,
      events,
      hooks: new HookRunner(),
      cwd,
      policy: createDeterministicPolicy({
        cwd,
        mode: 'ask',
        rules: { allow: [], ask: [], deny: [] },
      }),
      configRevision: () => revision,
      approvalResponder: responder,
    });
    const result = await executor.invokeTool(
      'write_file',
      { path: 'src/a.ts', content: 'a' },
      {
        signal: new AbortController().signal,
        runId: 'config-revision',
        userRequest: 'write',
        messages: [],
      },
    );
    expect(result.content).toContain('User denied');
    expect(responder).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(audits.some((event) => event.reasonCode === 'approval_stale')).toBe(true);
    expect(audits.some((event) => event.reasonCode === 'user_allow_reused')).toBe(false);
    expect(new Set(prompts.map((prompt) => prompt.requestId)).size).toBe(2);
    expect(new Set(prompts.map((prompt) => prompt.toolRequestId)).size).toBe(1);
  });

  it('auto 模式记住的命令规则不调用审批员', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-judge-'));
    folders.push(cwd);
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const events = new EventBus();
    const judges: string[] = [];
    events.on('model_request', (event) => {
      if (event.purpose === 'judge') judges.push(event.requestId);
    });
    const asks: string[] = [];
    events.on('permission_request', (event) => {
      asks.push(event.request.toolName);
      event.resolve({ allow: false });
    });
    const tools = new ToolRegistry();
    tools.register({ ...bashTool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
    const provider = new FakeProvider([
      textResponse(
        JSON.stringify({ decision: 'allow', reasonCode: 'model_allow', reason: '不应被调用' }),
      ),
    ]);
    const executor = new ToolExecutor({
      tools,
      events,
      hooks: new HookRunner(),
      cwd,
      policy: createDeterministicPolicy({
        cwd,
        mode: 'auto',
        rules: { allow: ['bash(="npm test")'], ask: [], deny: [] },
      }),
      reviewer: createModelReviewer({
        provider,
        model: 'offline-reviewer',
        modelInfo: () => ({ contextWindow: 128_000, maxOutputTokens: 8192 }),
      }),
    });
    const result = await executor.invokeTool(
      'bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        runId: 'remembered-command',
        userRequest: 'run tests',
        messages: [],
      },
    );
    expect(result.content).not.toContain('approval_required');
    expect(result.content).not.toContain('Permission denied');
    expect(judges).toEqual([]);
    expect(asks).toEqual([]);
    expect(provider.requests).toHaveLength(0);
  });
});
