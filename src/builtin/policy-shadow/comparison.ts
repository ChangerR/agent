/** 本地策略对照，不持有 Provider、Reviewer 或执行入口。 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { bounded, CapabilityTimeout } from '../../core/permission/async.js';
import type { Policy, PolicyDecision, PolicyInput, ToolAnalysis } from '../../sdk/index.js';
import type { CuratedAnnotation, OutcomeCounts, ShadowOutcome, ShadowRecord, ShadowSummary } from './types.js';
const DecisionSchema = z.object({ kind: z.enum(['allow', 'ask', 'deny', 'review']), reason: z.string(), source: z.enum(['session', 'config', 'builtin', 'mode', 'danger', 'judge', 'user']), reasonCode: z.string().optional(), matchedRule: z.string().optional() });
const AnalysisSchema = z.object({ analyzerId: z.string(), analyzerVersion: z.string(), completeness: z.enum(['complete', 'partial', 'unknown']), effects: z.array(z.object({ kind: z.enum(['read', 'write', 'execute', 'network', 'unknown']), target: z.string().optional(), scope: z.enum(['project', 'external', 'sensitive', 'unknown']).optional() })), reasonCode: z.string().optional(), environment: z.record(z.string()).optional(), evidence: z.array(z.object({ source: z.string(), detail: z.string() })).optional(), targets: z.array(z.string()).optional(), summary: z.string().optional() });
function dataOnly(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(dataOnly));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function').map(([key, item]) => [key, dataOnly(item)])));
  return value;
}
/** 同一完整参数/上下文的深只读快照，不包含 execute 或 analyzeInput 等工具函数。 */
export function shadowInput(input: PolicyInput): PolicyInput { return dataOnly(input) as PolicyInput; }
function outcome(decision: PolicyDecision): ShadowOutcome {
  const parsed = DecisionSchema.safeParse(decision);
  if (!parsed.success) return { status: 'error', reasonCode: 'invalid_decision', error: 'Policy returned an invalid decision' };
  return { status: 'decision', decision: parsed.data.kind, reasonCode: parsed.data.reasonCode ?? `${parsed.data.source}_${parsed.data.kind}`, reason: parsed.data.reason, ...(parsed.data.matchedRule ? { matchedRule: parsed.data.matchedRule } : {}) };
}
function failed(error: unknown, signal: AbortSignal): ShadowOutcome { return { status: 'error', reasonCode: signal.aborted ? 'cancelled' : error instanceof CapabilityTimeout ? 'timeout' : 'evaluation_error', error: error instanceof Error ? error.name : 'UnknownError' }; }
export interface CompareOptions {
  id?: string;
  input: PolicyInput;
  legacy: Policy;
  candidate: Policy;
  /** live wrapper 已取得的真实 v1 结果，不能再调一次真实策略。 */
  legacyDecision?: PolicyDecision;
  signal?: AbortSignal;
  timeoutMs?: number;
  annotation?: CuratedAnnotation;
  now?: () => number;
}
export async function comparePolicies(options: CompareOptions): Promise<ShadowRecord> {
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? (() => performance.now()); const started = now();
  const input = shadowInput(options.input); let analysis: ToolAnalysis | undefined;
  let legacy: ShadowOutcome;
  if (options.legacyDecision) legacy = outcome(options.legacyDecision);
  else {
    try {
      const legacyInput = Object.freeze({ ...input, tool: Object.freeze({ ...input.tool, ...(options.input.tool.analyzeInput ? { analyzeInput: options.input.tool.analyzeInput } : {}) }) });
      legacy = outcome(await bounded(child => options.legacy.decide(legacyInput, child), signal, options.timeoutMs ?? 1000));
    }
    catch (error) { legacy = failed(error, signal); }
  }
  let candidate: ShadowOutcome;
  try {
    candidate = await bounded(async child => {
      if (options.candidate.analyzer) {
        try { analysis = AnalysisSchema.parse(await options.candidate.analyzer.analyze(input, child)); }
        catch { child.throwIfAborted(); /* 让候选 policy 自己决定其分析失败的保守分支。 */ }
      }
      child.throwIfAborted();
      return outcome(await options.candidate.decide(shadowInput({ ...input, ...(analysis ? { analysis } : {}) }), child));
    }, signal, options.timeoutMs ?? 1000);
  } catch (error) { candidate = failed(error, signal); }
  const expansion = candidate.status === 'decision' && candidate.decision === 'allow' && !(legacy.status === 'decision' && legacy.decision === 'allow');
  return {
    id: options.id ?? input.toolCallId ?? createHash('sha256').update(`${input.tool.name}:${JSON.stringify(input.input)}`).digest('hex').slice(0, 16),
    toolName: input.tool.name,
    inputHash: createHash('sha256').update(JSON.stringify({ cwd: input.cwd, input: input.input })).digest('hex'),
    runId: input.runId, toolCallId: input.toolCallId, configRevision: input.configRevision, policyRevision: input.policyRevision,
    legacyPolicy: { id: options.legacy.id ?? 'legacy', version: options.legacy.version ?? 'unknown' },
    candidatePolicy: { id: options.candidate.id ?? 'candidate', version: options.candidate.version ?? 'unknown' },
    legacy, candidate,
    ...(analysis ? { analysis: { analyzerId: analysis.analyzerId, analyzerVersion: analysis.analyzerVersion, completeness: analysis.completeness, reasonCode: analysis.reasonCode, effects: analysis.effects.map(effect => ({ kind: effect.kind, scope: effect.scope })) } } : {}),
    comparisonMs: Math.max(0, now() - started),
    ...(expansion ? { allowExpansion: { baseline: legacy.status === 'decision' ? legacy.decision : legacy.status, candidateReasonCode: candidate.reasonCode, explanation: `v2 因 ${candidate.reasonCode} 放行，v1 ${legacy.status === 'decision' ? `返回 ${legacy.decision} (${legacy.reasonCode})` : `未能给出有效判断 (${legacy.reasonCode})`}。候选理由：${candidate.status === 'decision' ? candidate.reason : candidate.error}。此差异必须人工审核，不能用作执行授权。`, review: 'requires-human-review' as const, annotation: options.annotation } } : {}),
    annotation: options.annotation,
    executionAuthorized: false, modelCallsInitiatedByShadow: 0,
  };
}
export function summarizeShadow(records: readonly ShadowRecord[]): ShadowSummary {
  const counts = (side: 'legacy' | 'candidate'): OutcomeCounts => {
    const result: OutcomeCounts = { deterministicAllow: 0, modelEligible: 0, humanAsk: 0, deny: 0, unknown: 0, error: 0 };
    for (const record of records) {
      const value = record[side];
      if (value.status === 'error') { result.error++; result.unknown++; continue; }
      if (value.decision === 'allow') result.deterministicAllow++;
      if (value.decision === 'review') result.modelEligible++;
      if (value.decision === 'ask') result.humanAsk++;
      if (value.decision === 'deny') result.deny++;
      if (value.reasonCode.includes('error')) result.error++;
      if (value.reasonCode.includes('error') || value.reasonCode.includes('unknown') || value.reasonCode.includes('uncertain') || (side === 'candidate' && record.analysis?.completeness !== undefined && record.analysis.completeness !== 'complete')) result.unknown++;
    }
    return result;
  };
  return { comparisons: records.length, legacy: counts('legacy'), candidate: counts('candidate'), allowExpansions: records.filter(record => record.allowExpansion).length, errors: records.filter(record => record.legacy.status === 'error' || record.candidate.status === 'error' || record.legacy.reasonCode.includes('error') || record.candidate.reasonCode.includes('error')).length, modelCallsInitiatedByShadow: 0 };
}
