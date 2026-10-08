/** Shadow 记录从不包含 execution permit，也不能作为未来授权缓存。 */
import type { PolicyDecision, PolicyInput, ToolAnalysis } from '../../sdk/index.js';
import type { PermissionMode } from '../../core/config.js';
import type { SessionRules } from '../../core/permission/contracts.js';
export type ShadowSide = 'legacy' | 'candidate';
export interface ShadowDecision {
  status: 'decision';
  decision: PolicyDecision['kind'];
  reasonCode: string;
  reason: string;
  matchedRule?: string;
}
export interface ShadowError { status: 'error'; reasonCode: 'timeout' | 'cancelled' | 'invalid_decision' | 'evaluation_error'; error: string }
export type ShadowOutcome = ShadowDecision | ShadowError;
export interface CuratedAnnotation {
  expectedCandidate?: PolicyDecision['kind'];
  rationale: string;
  /** 样例标签是离线验收依据，不声称用户已审核真实运行操作。 */
  source: 'curated-fixture';
}
export interface RecordedReviewerOutcome {
  decision: 'allow' | 'ask' | 'deny' | 'unknown';
  reasonCode: string;
  /** 只是录制样例的附带信息；未填字段保持未知。 */
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}
export interface ShadowFixture {
  id: string;
  input: PolicyInput;
  mode: PermissionMode;
  rules: SessionRules;
  sessionRules?: SessionRules;
  writeRoots?: readonly string[];
  annotation?: CuratedAnnotation;
  recordedReviewer?: Partial<Record<ShadowSide, RecordedReviewerOutcome>>;
}
export interface AllowExpansion {
  baseline: ShadowOutcome['status'] | PolicyDecision['kind'];
  candidateReasonCode: string;
  explanation: string;
  review: 'requires-human-review';
  annotation?: CuratedAnnotation;
}
export interface ShadowRecord {
  id: string;
  toolName: string;
  inputHash: string;
  runId?: string;
  toolCallId?: string;
  configRevision?: string | number;
  policyRevision?: string | number;
  legacyPolicy: { id: string; version: string };
  candidatePolicy: { id: string; version: string };
  legacy: ShadowOutcome;
  candidate: ShadowOutcome;
  analysis?: Pick<ToolAnalysis, 'analyzerId' | 'analyzerVersion' | 'completeness' | 'reasonCode'> & { effects: Array<{ kind: string; scope?: string }> };
  comparisonMs: number;
  allowExpansion?: AllowExpansion;
  annotation?: CuratedAnnotation;
  recordedReviewer?: Partial<Record<ShadowSide, RecordedReviewerOutcome>>;
  /** 明确固定为 false，报告不能被误作执行授权。 */
  executionAuthorized: false;
  modelCallsInitiatedByShadow: 0;
}
export interface OutcomeCounts { deterministicAllow: number; modelEligible: number; humanAsk: number; deny: number; unknown: number; error: number }
export interface ShadowSummary {
  comparisons: number;
  legacy: OutcomeCounts;
  candidate: OutcomeCounts;
  allowExpansions: number;
  errors: number;
  modelCallsInitiatedByShadow: 0;
}
