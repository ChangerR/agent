/** 默认未选中的 live shadow：真实决策仍完全来自 legacy，候选只做本地比较。 */
import { z } from 'zod';
import type { AgentConfig, PermissionMode } from '../../core/config.js';
import type { SessionRules } from '../../core/permission/contracts.js';
import { definePlugin, type Policy, type PolicyDecision, type PolicyInput } from '../../sdk/index.js';
import { createDeterministicPolicy, previewRuleConflicts } from '../policy-deterministic-v2/index.js';
import { comparePolicies, shadowInput, summarizeShadow } from './comparison.js';
import { ShadowModelMetrics } from './metrics.js';
import type { ShadowRecord } from './types.js';
export * from './types.js';
export { comparePolicies, shadowInput, summarizeShadow } from './comparison.js';
export { ShadowModelMetrics } from './metrics.js';

function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
export interface PolicyStateSnapshot {
  readonly cwd: string;
  readonly mode: PermissionMode;
  readonly configuredRules: SessionRules;
  readonly sessionRules: SessionRules;
  readonly pluginEntries: readonly string[];
  readonly writeRoots: readonly string[];
}
export interface LiveShadowOptions {
  legacy: Policy;
  createCandidate(input: PolicyInput): Policy;
  onRecord(record: ShadowRecord): void;
  onDiagnostic?(error: unknown): void;
  timeoutMs?: number;
}
/** 不暴露 candidate controller，不修改真实 mode、analyzer、规则或返回决定。 */
export function createShadowPolicy(options: LiveShadowOptions): Policy {
  const legacy = options.legacy;
  return {
    id: legacy.id, version: legacy.version, controller: legacy.controller, analyzer: legacy.analyzer,
    get revision() { return legacy.revision; },
    async decide(input, signal): Promise<PolicyDecision> {
      let candidate: Policy | undefined; let facts: PolicyInput | undefined; let initializationError: unknown;
      try { facts = shadowInput(input); candidate = options.createCandidate(input); } catch (error) { initializationError = error; }
      const decision = await legacy.decide(input, signal);
      signal.throwIfAborted();
      try {
        if (!candidate || !facts) throw initializationError ?? new Error('Shadow candidate unavailable');
        const record = await comparePolicies({ input: facts, legacy, candidate, legacyDecision: decision, signal, timeoutMs: options.timeoutMs });
        options.onRecord(record);
      } catch (error) { try { options.onDiagnostic?.(error); } catch { /* 观测故障不能改写真正策略结果。 */ } }
      signal.throwIfAborted();
      return decision;
    },
  };
}
export interface PolicyShadowPluginOptions {
  cwd: string;
  config: AgentConfig;
  /** 测试或分支实现可以提供独立工厂；不能返回活动策略的共享控制器。 */
  createCandidate?: (snapshot: PolicyStateSnapshot) => Policy;
  getActiveState?: () => { policyId: string; mode: PermissionMode; sessionRules: SessionRules };
}
export function createPolicyShadowPlugin(options: PolicyShadowPluginOptions) {
  return definePlugin({
    manifest: { id: 'agentlab.policy-shadow', version: '1.0.0', apiVersion: 1, configVersion: 1, requires: { 'agentlab.policy-legacy': '^1.0.0', 'agentlab.policy-deterministic-v2': '^2.0.0' } },
    config: { schema: z.object({ timeoutMs: z.number().int().min(1).max(10000).default(1000), maxRecords: z.number().int().min(1).max(10000).default(500) }), ownedFields: ['timeoutMs', 'maxRecords'], defaults: { timeoutMs: 1000, maxRecords: 500 }, applyMode: 'new-session' },
    setup(ctx) {
      const legacy = ctx.dependencies.get('agentlab.policy-legacy').get('policy', 'legacy-v1');
      const declaredCandidate = ctx.dependencies.get('agentlab.policy-deterministic-v2').get('policy', 'deterministic-v2');
      const records: ShadowRecord[] = []; const models = new ShadowModelMetrics(); const total = summarizeShadow([]); let totalComparisons = 0; let diagnosticErrors = 0;
      const pluginEntries = [...options.config.plugins, ...options.config.pluginEntries.filter(entry => typeof entry === 'string' || entry.enabled).map(entry => typeof entry === 'string' ? entry : entry.entry)];
      const state = (active = false): PolicyStateSnapshot => {
        const current = active ? options.getActiveState?.() : undefined;
        const roots = options.config.pluginConfig['agentlab.policy-deterministic-v2']?.writeRoots;
        return freeze({ cwd: options.cwd, mode: current?.mode ?? legacy.controller?.mode ?? options.config.permissionMode, configuredRules: structuredClone(options.config.permissions), sessionRules: structuredClone(current?.sessionRules ?? legacy.controller?.getSessionRules() ?? { allow: [], ask: [], deny: [] }), pluginEntries: Object.freeze([...pluginEntries]), writeRoots: Object.freeze(Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string') : []) });
      };
      const candidateFor = (): Policy => {
        const snapshot = state();
        const candidate = options.createCandidate?.(snapshot) ?? createDeterministicPolicy({ cwd: snapshot.cwd, mode: snapshot.mode, rules: snapshot.configuredRules, pluginEntries: snapshot.pluginEntries, writeRoots: snapshot.writeRoots });
        if (candidate === declaredCandidate || candidate.controller === legacy.controller || (candidate.controller && candidate.controller === declaredCandidate.controller)) throw new Error('Shadow candidate must have an independent controller');
        candidate.controller?.setSessionRules(snapshot.sessionRules);
        if (candidate.id !== declaredCandidate.id || candidate.version !== declaredCandidate.version) throw new Error('Shadow candidate version does not match the declared dependency');
        return candidate;
      };
      const snapshot = () => ({ enabled: ctx.config.core.capabilities.policy === 'legacy-shadow', mode: 'observe-only-v1-authoritative', totalComparisons, retainedRecords: records.length, droppedRecords: Math.max(0, totalComparisons - records.length), diagnosticErrors, summary: structuredClone(total), retainedSummary: summarizeShadow(records), modelMetrics: models.snapshot(), executionAuthorized: false });
      const wrapper = createShadowPolicy({ legacy, createCandidate: candidateFor, timeoutMs: ctx.config.value.timeoutMs as number,
        onRecord(record) {
          totalComparisons++; const one = summarizeShadow([record]); total.comparisons++; total.allowExpansions += one.allowExpansions; total.errors += one.errors;
          for (const side of ['legacy', 'candidate'] as const) for (const key of Object.keys(total[side]) as Array<keyof typeof total.legacy>) total[side][key] += one[side][key];
          records.push(structuredClone(record)); if (records.length > (ctx.config.value.maxRecords as number)) records.shift();
        },
        onDiagnostic() { diagnosticErrors++; },
      });
      ctx.provide.policy('legacy-shadow', wrapper);
      for (const type of ['model_request', 'model_usage', 'permission_request'] as const) ctx.events.on(type, event => models.observe(event));
      ctx.provide.command('policy-shadow', { description: '只读查看 shadow 对照、指标和待审核放行差异', handler(input) {
        const arg = typeof input.args === 'string' ? input.args.trim() : '';
        if (arg === 'records') return { type: 'data', data: { ...snapshot(), records: structuredClone(records) } };
        if (arg === 'expansions') return { type: 'data', data: { executionAuthorized: false, totalExpansions: total.allowExpansions, droppedExpansionRecords: total.allowExpansions - records.filter(record => record.allowExpansion).length, records: structuredClone(records.filter(record => record.allowExpansion)) } };
        if (arg && arg !== 'summary') throw new Error('用法: /policy-shadow [summary|records|expansions]；不会执行工具或调用模型');
        return { type: 'data', data: snapshot() };
      } });
      ctx.provide.command('policy-migrate', { description: '只读预览 v1→v2 规则优先级冲突，不写配置', handler(input) {
        const arg = typeof input.args === 'string' ? input.args.trim() : '';
        if (arg && arg !== 'preview') throw new Error('用法: /policy-migrate [preview]；自动迁移写入不受支持');
        const current = state(true);
        const combined = { allow: [...current.sessionRules.allow, ...current.configuredRules.allow], ask: [...current.sessionRules.ask, ...current.configuredRules.ask], deny: [...current.sessionRules.deny, ...current.configuredRules.deny] };
        return { type: 'data', data: { previewOnly: true, writesPerformed: 0, currentPolicy: options.getActiveState?.().policyId ?? legacy.id, candidatePolicy: declaredCandidate.id, effectiveMode: current.mode,
          configuredRules: current.configuredRules, sessionRules: current.sessionRules, writeRoots: current.writeRoots, conflicts: previewRuleConflicts(combined),
          changes: ['v2 明确 ask 优先于 allow；deny 仍优先。', '敏感路径、项目外目标和不完整副作用不能靠宽 allow 或 yolo 自动放行。', '旧会话策略身份不能隐式迁移；切换需新会话或另行显式迁移。'], executionAuthorized: false } };
      } });
      ctx.provide.settings('policy-shadow', { title: '策略 Shadow 对照', description: '默认关闭；显式选择 legacy-shadow 后才比较。真实执行保持 v1。', schema: { type: 'object', properties: { selectedCapability: { const: 'legacy-shadow' } } }, applyMode: 'new-session', read: snapshot });
    },
  });
}
