import { mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutor, type ToolExecutorOptions } from '../src/core/tool-executor.js';
import { EventBus, type AgentEvent, type PermissionRequest, type UserDecision } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { PermissionEngine, createLegacyPolicy } from '../src/builtin/policy-legacy/index.js';
import type { Policy, Reviewer, ToolAnalyzer } from '../src/sdk/capabilities.js';
import { emptyUsage } from '../src/core/protocol/types.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
const allow: Policy = { id: 'allow-test', version: '1', decide: () => ({ kind: 'allow', source: 'config', reason: 'test allow' }) };
const ask: Policy = { id: 'ask-test', version: '1', decide: () => ({ kind: 'ask', source: 'config', reason: 'test ask' }) };
const review: Policy = { id: 'review-test', version: '1', decide: () => ({ kind: 'review', source: 'mode', reason: 'test review' }) };
function fixture(options: Partial<ToolExecutorOptions> = {}) {
  const events = new EventBus();
  const tools = new ToolRegistry();
  const execute = vi.fn<Tool['execute']>(async () => ({ content: 'executed' }));
  const tool: Tool = { name: 'write', version: '1', description: 'test write', risk: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, execute };
  tools.register(tool);
  const hooks = new HookRunner();
  const audits: Extract<AgentEvent, { type: 'tool_execution' }>[] = [];
  events.on('tool_execution', (event) => audits.push(event));
  const executor = new ToolExecutor({ tools, events, hooks, cwd: process.cwd(), policy: allow, ...options });
  const controller = new AbortController();
  const context = { signal: controller.signal, runId: 'run-test', userRequest: 'write requested file', messages: [] };
  const run = (input: unknown = { path: 'x' }, id = 'call-test') => executor.execute({ type: 'tool_use', id, name: 'write', input }, context);
  return { tools, events, hooks, execute, tool, executor, controller, context, audits, run };
}

describe('ToolExecutor 唯一授权门', () => {
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
    const f = fixture(); f.tool.inputSchema = { not: { unknownAssertion: true } };
    expect((await f.run()).content).toContain('Unsupported JSON Schema');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('null 工具参数不得隐式改成空对象', async () => {
    const f = fixture(); f.tool.inputSchema = {};
    expect((await f.run(null)).isError).toBe(true); expect(f.execute).not.toHaveBeenCalled();
  });

  it('冻结改写后的参数，reviewer 无 execute 句柄，工具执行的内容与批准一致', async () => {
    const seen: unknown[] = [];
    const reviewer: Reviewer = { async review(operation) {
      expect(Object.isFrozen(operation.input)).toBe(true);
      expect('execute' in operation.tool).toBe(false);
      seen.push(operation.input);
      return { decision: 'allow', reason: 'ok', reasonCode: 'model_allow' };
    } };
    const f = fixture({ policy: review, reviewer });
    const rewritten = { path: 'approved' };
    f.hooks.register('PreToolUse', () => ({ input: rewritten }));
    expect((await f.run()).isError).toBeUndefined();
    rewritten.path = 'after';
    expect(seen[0]).toEqual({ path: 'approved' });
    expect(f.execute.mock.calls[0][0]).toEqual({ path: 'approved' });
    expect(f.audits.find((e) => e.phase === 'execution')).toMatchObject({ runId: 'run-test', toolCallId: 'call-test', reasonCode: 'tool_success', policyId: 'review-test' });
    expect(new Set(f.audits.map((e) => e.requestId)).size).toBe(1);
  });

  it.each(['ask', 'deny'] as const)('明确 %s 不调用 reviewer', async (kind) => {
    const reviewer: Reviewer = { review: vi.fn<Reviewer['review']>(async () => ({ decision: 'allow', reason: 'override', reasonCode: 'bad' })) };
    const f = fixture({ policy: { decide: () => ({ kind, source: 'config', reason: 'explicit' }) }, reviewer });
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
    const f = fixture({ policy: { decide: ({ tool }) => ({ kind: tool.name === 'write' ? 'deny' : 'allow', source: 'config', reason: 'rule' }) } });
    f.tools.register({ ...f.tool, name: 'outer', inputSchema: {}, execute: async (_input, context) => context.invokeTool!('write', { path: 'nested' }) });
    expect((await f.executor.invokeTool('outer', {}, f.context)).content).toContain('Permission denied');
    expect((await f.executor.invokeTool('write', { path: 'direct' }, f.context)).content).toContain('Permission denied');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.filter((e) => e.phase === 'policy')).toHaveLength(3);
  });

  it.each(['unknown', 'invalid', 'error', 'timeout'] as const)('%s reviewer 不能放行且每次绑定至多请求一次', async (mode) => {
    const reviewer: Reviewer = { review: vi.fn<Reviewer['review']>(async () => {
      if (mode === 'error') throw new Error('secret provider error');
      if (mode === 'timeout') return new Promise(() => {});
      return { decision: mode, reason: 'uncertain', reasonCode: 'uncertain' } as never;
    }) };
    const f = fixture({ policy: review, reviewer, reviewTimeoutMs: 5 });
    const result = await f.run();
    expect(result.content).toContain('approval_required');
    expect(f.execute).not.toHaveBeenCalled();
    expect(reviewer.review).toHaveBeenCalledTimes(1);
  });

  it('reviewer deny 是最终拒绝，不弹人工确认', async () => {
    const f = fixture({ policy: review, reviewer: { review: async () => ({ decision: 'deny', reason: 'out of scope', reasonCode: 'model_deny' }) } });
    const prompt = vi.fn(); f.events.on('permission_request', prompt);
    expect((await f.run()).content).toContain('Permission denied');
    expect(prompt).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it('审计控制器改写收到的 decision 副本不能把 reviewer deny 变为 allow', async () => {
    const controller = new PermissionEngine({ mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
    controller.recordDecision = (_tool, _input, decision) => { decision.kind = 'allow'; };
    const f = fixture({ policy: { ...review, controller }, reviewer: { review: async () => ({ decision: 'deny', reason: 'out of scope', reasonCode: 'model_deny' }) } });
    expect((await f.run()).content).toContain('Permission denied'); expect(f.execute).not.toHaveBeenCalled();
  });

  it('reviewer 返回值先快照，getter 不能在验证后变为 allow', async () => {
    let reads = 0;
    const f = fixture({ policy: review, reviewer: { review: async () => ({ get decision() { return ++reads === 1 ? 'unknown' : 'allow'; }, reason: 'untrusted output', reasonCode: 'unknown' }) } });
    expect((await f.run()).content).toContain('approval_required'); expect(reads).toBe(1); expect(f.execute).not.toHaveBeenCalled();
  });

  it('reviewer 只取得隔离的模型事件出口，不能订阅父审批 resolver', async () => {
    const intercepted = vi.fn(); const usage = vi.fn();
    const f = fixture({ policy: review, reviewer: { review: async ({ events }) => {
      events!.on('permission_request', intercepted);
      events!.emit({ type: 'model_usage', requestId: 'model-request', purpose: 'agent', usage: emptyUsage() });
      return { decision: 'unknown', reason: 'ask user', reasonCode: 'unknown' };
    } } });
    f.events.on('model_usage', usage);
    expect((await f.run()).content).toContain('approval_required'); expect(intercepted).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'judge', requestId: 'model-request', runId: 'run-test', toolCallId: 'call-test', toolRequestId: f.audits[0].requestId }));
  });

  it('人工响应在 resolve 后被改写不改变已结算的拒绝', async () => {
    const f = fixture({ policy: ask });
    f.events.on('permission_request', ({ resolve }) => {
      const response: { allow: boolean } = { allow: false }; resolve(response as UserDecision); response.allow = true;
    });
    expect((await f.run()).content).toContain('User denied'); expect(f.execute).not.toHaveBeenCalled();
  });

  it('策略和分析异常保守询问，不读取错误中的 allow', async () => {
    const f = fixture({ policy: { decide: () => { throw new Error('allow'); } } });
    expect((await f.run()).content).toContain('approval_required');
    const analyzer: ToolAnalyzer = { analyze: () => { throw new Error('allow'); } };
    const g = fixture({ analyzer });
    expect((await g.run()).content).toContain('approval_required');
    expect(f.execute).not.toHaveBeenCalled(); expect(g.execute).not.toHaveBeenCalled();
  });

  it('策略返回可转换成 allow 的对象仍是非法结果', async () => {
    class ImplicitAllow { toString() { return 'allow'; } }
    const f = fixture({ policy: { decide: () => ({ kind: new ImplicitAllow(), source: 'config', reason: 'bad type' }) as never } });
    expect((await f.run()).content).toContain('approval_required'); expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['false', {}, undefined])('环境重验的非布尔返回 %j 不能被当作有效批准', async (value) => {
    const analyzer: ToolAnalyzer = { analyze: () => ({ analyzerId: 'test', analyzerVersion: '1', completeness: 'complete', effects: [] }),
      revalidate: () => value as never };
    const f = fixture({ analyzer });
    expect((await f.run()).content).toContain('approval_stale'); expect(f.execute).not.toHaveBeenCalled();
  });

  it('取消后迟到批准无效，resolve 只能结算一次', async () => {
    const f = fixture({ policy: ask });
    let resolve!: (value: UserDecision) => void;
    f.events.on('permission_request', (event) => { resolve = event.resolve; f.controller.abort(); });
    expect((await f.run()).content).toBe('Tool cancelled');
    resolve({ allow: true, remember: 'session' }); resolve({ allow: true });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('配置 revision 变更使旧人工批准失效并重新询问', async () => {
    let revision = 1;
    const prompts: PermissionRequest[] = [];
    const responder = vi.fn(async (request: PermissionRequest) => { prompts.push(request); if (revision === 1) { revision = 2; return { allow: true } as const; } return { allow: false } as const; });
    const f = fixture({ policy: ask, configRevision: () => revision, approvalResponder: responder });
    expect((await f.run()).content).toContain('User denied');
    expect(responder).toHaveBeenCalledTimes(2); expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.some((e) => e.reasonCode === 'approval_stale')).toBe(true);
    expect(new Set(prompts.map(prompt => prompt.requestId)).size).toBe(2);
    expect(new Set(prompts.map(prompt => prompt.toolRequestId)).size).toBe(1);
  });

  it('工具版本和实际执行函数变更使批准失效', async () => {
    const f = fixture({ policy: ask });
    const replacement = vi.fn(async () => ({ content: 'replaced' }));
    let requests = 0;
    f.events.on('permission_request', (event) => {
      requests++;
      if (requests === 1) { f.tool.version = '2'; f.tool.execute = replacement; event.resolve({ allow: true }); }
      else event.resolve({ allow: false });
    });
    await f.run();
    expect(requests).toBe(2); expect(replacement).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it('session 身份变化后旧批准失效，不把旧调用转移到新会话', async () => {
    let session = 'session-a'; let requests = 0;
    const f = fixture({ policy: ask, sessionId: () => session, approvalResponder: () => {
      if (++requests === 1) { session = 'session-b'; return { allow: true }; }
      return { allow: false };
    } });
    expect((await f.run()).content).toContain('approval_stale');
    expect(requests).toBe(1); expect(f.execute).not.toHaveBeenCalled();
  });

  it('结束的 run 与改变的宿主 capability 版本均不能消费旧批准', async () => {
    let active = true;
    const f = fixture({ policy: ask, runActive: () => active, approvalResponder: () => { active = false; return { allow: true }; } });
    expect((await f.run()).content).toContain('approval_stale'); expect(f.execute).not.toHaveBeenCalled();
    let version = '1'; let prompts = 0;
    const g = fixture({ policy: ask, toolIdentity: () => ({ ownerPlugin: 'test-tools', capabilityId: 'write', version }),
      approvalResponder: () => { if (++prompts === 1) { version = '2'; return { allow: true }; } return { allow: false }; } });
    await g.run(); expect(prompts).toBe(2); expect(g.execute).not.toHaveBeenCalled();
    expect(g.audits.find((event) => event.phase === 'policy')).toMatchObject({ toolOwner: 'test-tools', capabilityId: 'write', toolVersion: '1' });
  });

  it('policy 版本或 handler 替换不能使用旧批准', async () => {
    const policy = { ...ask }; let prompts = 0;
    const f = fixture({ policy, approvalResponder: () => {
      if (++prompts === 1) { policy.version = '2'; policy.decide = () => ({ kind: 'deny', source: 'config', reason: 'new policy' }); return { allow: true }; }
      return { allow: true };
    } });
    expect((await f.run()).content).toContain('Permission denied'); expect(prompts).toBe(1); expect(f.execute).not.toHaveBeenCalled();
  });

  it('tool_call 观测阶段的取消仍阻止实际执行', async () => {
    const f = fixture(); f.events.on('tool_call', () => f.controller.abort());
    expect((await f.run()).content).toBe('Tool cancelled'); expect(f.execute).not.toHaveBeenCalled();
  });

  it('renderer/telemetry 异常不能伪装工具结果或阻断其余订阅者', async () => {
    const f = fixture(); const received = vi.fn();
    f.events.onAll(() => { throw new Error('observer failed'); });
    f.events.on('tool_result', () => { throw new Error('renderer failed'); });
    f.events.on('tool_result', received);
    expect((await f.run()).content).toBe('executed'); expect(f.execute).toHaveBeenCalledTimes(1); expect(received).toHaveBeenCalledTimes(1);
  });

  it('PostToolUse 永不完成也受超时边界约束，成功副作用不会被报告成失败', async () => {
    const f = fixture({ capabilityTimeoutMs: 5 });
    f.hooks.register('PostToolUse', () => new Promise(() => {}));
    const results = vi.fn(); f.events.on('tool_result', results);
    expect((await f.run()).content).toBe('executed'); expect(f.execute).toHaveBeenCalledTimes(1); expect(results).toHaveBeenCalledTimes(1);
  });

  it('PostToolUse 等待期间取消，保留执行成功结果并立即释放等待', async () => {
    const f = fixture();
    f.hooks.register('PostToolUse', () => { f.controller.abort(); return new Promise(() => {}); });
    expect((await f.run()).content).toBe('executed'); expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('读取 revision 失败时仍生成唯一错误结果，不能执行', async () => {
    const f = fixture({ configRevision: () => { throw new Error('configuration unavailable'); } });
    const results = vi.fn(); f.events.on('tool_result', results);
    expect((await f.run()).isError).toBe(true); expect(results).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });

  it('同 run 的 toolCallId 不会二次执行，一次调用只形成一个结果', async () => {
    const f = fixture(); const results = vi.fn(); f.events.on('tool_result', results);
    await f.run(); expect((await f.run()).content).toContain('Duplicate');
    expect(f.execute).toHaveBeenCalledTimes(1); expect(results).toHaveBeenCalledTimes(2);
  });

  it('项目脚本在等待期间变化后必须重新询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-script-')); folders.push(cwd);
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    await writeFile(join(cwd, 'test.js'), 'safe');
    const permission = new PermissionEngine({ mode: 'ask', rules: { allow: [], ask: [], deny: [] } });
    let requests = 0;
    const f = fixture({ cwd, policy: createLegacyPolicy(permission), approvalResponder: async () => {
      if (++requests === 1) { await writeFile(join(cwd, 'test.js'), 'changed script'); return { allow: true }; }
      return { allow: false };
    } });
    f.tool.inputSchema = { type: 'object' };
    expect((await f.run({ command: 'npm test' })).content).toContain('User denied');
    expect(requests).toBe(2); expect(f.execute).not.toHaveBeenCalled();
    expect(f.audits.some((e) => e.reasonCode === 'environment_changed')).toBe(true);
  });

  it('符号链接目标在审批期间切换后必须重新询问', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'executor-link-')); folders.push(cwd);
    await writeFile(join(cwd, 'a'), 'a'); await writeFile(join(cwd, 'b'), 'b'); await symlink('a', join(cwd, 'link'));
    const permission = new PermissionEngine({ mode: 'ask', rules: { allow: [], ask: [], deny: [] } });
    let requests = 0;
    const f = fixture({ cwd, policy: createLegacyPolicy(permission), approvalResponder: async () => {
      if (++requests === 1) { await unlink(join(cwd, 'link')); await symlink('b', join(cwd, 'link')); return { allow: true }; }
      return { allow: false };
    } });
    expect((await f.run({ path: 'link' })).content).toContain('User denied');
    expect(requests).toBe(2); expect(f.execute).not.toHaveBeenCalled();
  });
});
