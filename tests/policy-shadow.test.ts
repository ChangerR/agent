import { mkdtempProject } from './helpers/project.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/index.js';
import { AgentConfigSchema } from '../src/core/config.js';
import { EventBus } from '../src/core/events.js';
import { PermissionEngine, createLegacyPolicy } from '../src/builtin/policy-legacy/index.js';
import { createDeterministicPolicyPlugin } from '../src/builtin/policy-deterministic-v2/index.js';
import { createPolicyShadowPlugin, createShadowPolicy, comparePolicies, ShadowModelMetrics, summarizeShadow } from '../src/builtin/policy-shadow/index.js';
import { runOfflineShadow } from '../src/builtin/policy-shadow/offline.js';
import { runCuratedShadow } from '../src/builtin/policy-shadow/corpus.js';
import { PluginHost } from '../src/runtime/plugin-host.js';
import { CommandRegistry } from '../src/runtime/commands.js';
import { definePlugin, type Policy, type PolicyDecision, type PolicyInput } from '../src/sdk/index.js';
import type { ShadowFixture, ShadowRecord } from '../src/builtin/policy-shadow/types.js';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const rules = () => ({ allow: [] as string[], ask: [] as string[], deny: [] as string[] });
const input = (): PolicyInput => ({ cwd: '/project', tool: { name: 'sample', description: 'metadata', risk: 'write', inputSchema: { type: 'object' } }, input: { path: 'src/file.ts', content: 'private body' }, runId: 'run', toolCallId: 'tool', configRevision: 'c1', policyRevision: 'p1' });
const decision = (kind: PolicyDecision['kind']): PolicyDecision => ({ kind, source: 'mode', reason: `fixture ${kind}`, reasonCode: `fixture_${kind}` });
const policy = (kind: PolicyDecision['kind'], id = 'fixture'): Policy => ({ id, version: '1.0.0', decide: () => decision(kind) });
async function directory() { const cwd = await mkdtempProject(join(tmpdir(), 'policy-shadow-')); dirs.push(cwd); await fs.writeFile(join(cwd, 'package.json'), '{}'); await fs.mkdir(join(cwd, 'src')); return cwd; }
describe('只观察的策略 Shadow', () => {
  it('每个 v2 allow / v1 非 allow 都有解释和待人工审核标签，没有执行许可', async () => {
    const record = await comparePolicies({ id: 'expansion', input: input(), legacy: policy('review', 'legacy'), candidate: policy('allow', 'v2'), annotation: { source: 'curated-fixture', rationale: 'explicit scoped grant fixture' } });
    expect(record.allowExpansion).toMatchObject({ baseline: 'review', review: 'requires-human-review', candidateReasonCode: 'fixture_allow' });
    expect(record.allowExpansion?.explanation).toContain('人工审核');
    expect(record.executionAuthorized).toBe(false); expect(record.modelCallsInitiatedByShadow).toBe(0);
    expect(JSON.stringify(record)).not.toContain('private body');
    expect(summarizeShadow([record])).toMatchObject({ allowExpansions: 1, legacy: { modelEligible: 1 }, candidate: { deterministicAllow: 1 }, modelCallsInitiatedByShadow: 0 });
  });
  it('live wrapper 返回同一个真实 legacy 决定，保留身份/controller/analyzer，不执行工具', async () => {
    const actual = decision('ask'); const execute = vi.fn(); const decide = vi.fn(() => actual);
    const legacy = { ...policy('ask', 'legacy-v1'), decide };
    const records: ShadowRecord[] = [];
    const wrapper = createShadowPolicy({ legacy, createCandidate: () => ({ ...policy('allow'), decide(data) { expect('execute' in data.tool).toBe(false); expect('analyzeInput' in data.tool).toBe(false); expect(Object.isFrozen(data.input)).toBe(true); return decision('allow'); } }), onRecord: record => records.push(record) });
    const operation = input(); Object.assign(operation.tool, { execute, analyzeInput: vi.fn() });
    expect(await wrapper.decide(operation, new AbortController().signal)).toBe(actual);
    expect(wrapper.id).toBe(legacy.id); expect(wrapper.controller).toBe(legacy.controller); expect(wrapper.analyzer).toBe(legacy.analyzer);
    expect(decide).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(records).toHaveLength(1);
  });
  it('候选失败、超时和日志回调失败均不改变真实 v1 结果', async () => {
    const actual = decision('deny'); const records: ShadowRecord[] = [];
    const legacy = { ...policy('deny'), decide: () => actual };
    const wrapper = createShadowPolicy({ legacy, createCandidate: () => ({ decide: () => new Promise(() => {}) }), timeoutMs: 5, onRecord: record => records.push(record) });
    expect(await wrapper.decide(input(), new AbortController().signal)).toBe(actual);
    expect(records[0].candidate).toMatchObject({ status: 'error', reasonCode: 'timeout' });
    const brokenObserver = createShadowPolicy({ legacy, createCandidate: () => policy('allow'), onRecord() { throw new Error('sink failed'); }, onDiagnostic() { throw new Error('diagnostic failed'); } });
    expect(await brokenObserver.decide(input(), new AbortController().signal)).toBe(actual);
  });
  it('非法候选或修改冻结参数只成为 error，不污染真实参数', async () => {
    const operation = input();
    const record = await comparePolicies({ input: operation, legacy: policy('ask'), candidate: { decide(data) { (data.input as Record<string, unknown>).path = 'changed'; return decision('allow'); } } });
    expect(record.candidate.status).toBe('error'); expect(operation.input.path).toBe('src/file.ts');
    const invalid = await comparePolicies({ input: operation, legacy: policy('ask'), candidate: { decide: () => ({ kind: 'approve' }) as unknown as PolicyDecision } });
    expect(invalid.candidate).toMatchObject({ status: 'error', reasonCode: 'invalid_decision' });
  });
  it('录制 reviewer 结果仅在显式模式附带，默认不会重放为决策或请求模型', async () => {
    const fixture: ShadowFixture = { id: 'recorded', input: input(), mode: 'auto', rules: rules(), recordedReviewer: { candidate: { decision: 'allow', reasonCode: 'synthetic_fixture', inputTokens: 2 } } };
    const options = { fixtures: [fixture], createLegacy: () => policy('review'), createCandidate: () => policy('review') };
    const normal = await runOfflineShadow(options); expect(normal.records[0].recordedReviewer).toBeUndefined();
    const explicit = await runOfflineShadow({ ...options, mode: 'recorded-reviewer-fixtures' });
    expect(explicit.records[0].recordedReviewer?.candidate?.decision).toBe('allow');
    expect(explicit.records[0].candidate).toMatchObject({ decision: 'review' }); expect(explicit.modelCallsInitiatedByShadow).toBe(0); expect(explicit.toolsExecuted).toBe(0);
  });
  it('按实际 purpose 记录调用/token/耗时，缺失 usage 为未知，eligible 不冒充调用', () => {
    let now = 0; const metrics = new ShadowModelMetrics(() => now);
    const request = { model: 'fixture', system: '', messages: [], tools: [] };
    metrics.observe({ type: 'model_request', requestId: 'one', purpose: 'judge', provider: 'fake', request }); now = 20;
    metrics.observe({ type: 'model_usage', requestId: 'one', purpose: 'judge', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 } });
    metrics.observe({ type: 'model_request', requestId: 'two', purpose: 'judge', provider: 'fake', request }); now = 50;
    metrics.observe({ type: 'model_usage', requestId: 'two', purpose: 'judge', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    metrics.observe({ type: 'model_request', requestId: 'pending', purpose: 'compact', provider: 'fake', request });
    const result = metrics.snapshot();
    expect(result.purposes.judge).toMatchObject({ modelCalls: 2, completedRequests: 2, usageKnownRequests: 1, usageUnknownRequests: 1, usageStatus: 'partial', observedTokens: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 }, latency: { totalMs: 50, meanMs: 25 } });
    expect(result.purposes.compact.observedTokens.inputTokens).toBeNull(); expect(result.purposes.compact.latency.totalMs).toBeNull();
    expect(result.purposes.agent.modelCalls).toBe(0); expect(result.modelCallsInitiatedByShadow).toBe(0);
  });
  it.each(['另一轮复用同一个 toolUseId', '同一调用的旧批准失效后再次询问'])('%s：人工询问按实际事件计数，不按工具 ID 去重', () => {
    const metrics = new ShadowModelMetrics();
    const event = { type: 'permission_request' as const, request: { toolName: 'write_file', toolUseId: 'same-tool-id', input: {}, summary: 'write', reason: 'ask' } };
    metrics.observe(event); metrics.observe(event);
    expect(metrics.snapshot().humanRequests).toBe(2);
  });
  it('注册命令默认不启动对照，迁移预览读取实际 active controller 且不写配置', async () => {
    const cwd = await directory(); const config = AgentConfigSchema.parse({ provider: 'fake', permissionMode: 'auto' });
    const original = JSON.stringify(config); const events = new EventBus(); const candidateFactory = vi.fn();
    const controller = new PermissionEngine({ mode: 'auto', rules: rules() });
    const legacy = definePlugin({ manifest: { id: 'agentlab.policy-legacy', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.policy('legacy-v1', createLegacyPolicy(controller)); } });
    const shadow = createPolicyShadowPlugin({ cwd, config, createCandidate: candidateFactory, getActiveState: () => ({ policyId: 'deterministic-v2', mode: 'yolo', sessionRules: { allow: ['read_file'], ask: ['read_file'], deny: [] } }) });
    const host = new PluginHost({ config, events, selections: { policy: 'legacy-v1' } }); await host.load([legacy, createDeterministicPolicyPlugin({ cwd, config }), shadow]);
    try {
      const commands = new CommandRegistry(host.list('command')); const invoke = vi.fn();
      const context = { cwd, signal: new AbortController().signal, invokeTool: invoke };
      const status = await commands.dispatch('/policy-shadow', context); expect(status).toMatchObject({ type: 'data', data: { enabled: false, totalComparisons: 0 } });
      const preview = await commands.dispatch('/policy-migrate preview', context);
      expect(preview).toMatchObject({ type: 'data', data: { previewOnly: true, writesPerformed: 0, currentPolicy: 'deterministic-v2', effectiveMode: 'yolo', conflicts: [{ legacyWinner: 'allow', v2Winner: 'ask' }] } });
      expect(candidateFactory).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(JSON.stringify(config)).toBe(original); expect(controller.mode).toBe('auto');
    } finally { await host.dispose(); }
  });
  it('真实 runtime 中 shadow allow 不能越过 v1 reviewer 拒绝', async () => {
    const cwd = await directory(); let reviews = 0;
    const reviewer = definePlugin({ manifest: { id: 'test.shadow-reviewer', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.reviewer('shadow-deny', { async review() { reviews++; return { decision: 'deny', reasonCode: 'fixture_deny', reason: 'real v1 reviewer denied' }; } }); } });
    const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [reviewer], config: { provider: 'fake', permissionMode: 'auto', capabilities: { policy: 'legacy-shadow', reviewer: 'shadow-deny' }, pluginConfig: { 'agentlab.policy-deterministic-v2': { writeRoots: ['src'] } } } });
    try {
      const result = await agent.loop.invokeTool('write_file', { path: 'src/shadow-output.ts', content: 'must not be written' });
      expect(result.isError).toBe(true); expect(reviews).toBe(1);
      expect(await fs.stat(join(cwd, 'src', 'shadow-output.ts')).then(() => true, () => false)).toBe(false);
      const report = await agent.dispatchCommand('/policy-shadow expansions');
      expect(report).toMatchObject({ type: 'data', data: { executionAuthorized: false, totalExpansions: 1, records: [{ legacy: { decision: 'review' }, candidate: { decision: 'allow', reasonCode: 'v2_scoped_write' } }] } });
    } finally { await agent.dispose(); }
  });
  it('人工选取样例解释所有放行扩展，真实文件、工具和模型都不被执行', async () => {
    const cwd = await directory();
    const result = await runCuratedShadow(cwd);
    expect(result.summary.errors).toBe(0);
    const grant = result.records.find(record => record.id === 'explicit-src-write-grant')!;
    expect(grant.legacy).toMatchObject({ decision: 'review' }); expect(grant.candidate).toMatchObject({ decision: 'allow' });
    expect(grant.allowExpansion).toMatchObject({ review: 'requires-human-review', annotation: { source: 'curated-fixture' } });
    expect(result.records.filter(record => record.candidate.status === 'decision' && record.candidate.decision === 'allow' && !(record.legacy.status === 'decision' && record.legacy.decision === 'allow'))).toEqual(result.records.filter(record => record.allowExpansion));
    expect(await fs.stat(join(cwd, 'src', 'shadow-output.ts')).then(() => true, () => false)).toBe(false);
    expect(await fs.readFile(join(cwd, 'package.json'), 'utf8')).toBe('{}'); expect(result.toolsExecuted).toBe(0); expect(result.modelCallsInitiatedByShadow).toBe(0);
  });
});
