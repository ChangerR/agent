/** 离线样例/录制结果对照；这里没有模型客户端或工具执行入口。 */
import type { Policy } from '../../sdk/index.js';
import { comparePolicies, summarizeShadow } from './comparison.js';
import type { ShadowFixture, ShadowRecord } from './types.js';
export interface OfflineShadowOptions {
  fixtures: readonly ShadowFixture[];
  createLegacy(fixture: ShadowFixture): Policy;
  createCandidate(fixture: ShadowFixture): Policy;
  mode?: 'deterministic-only' | 'recorded-reviewer-fixtures';
  signal?: AbortSignal;
  timeoutMs?: number;
}
export async function runOfflineShadow(options: OfflineShadowOptions) {
  const records: ShadowRecord[] = [];
  const signal = options.signal ?? new AbortController().signal;
  for (const fixture of options.fixtures) {
    signal.throwIfAborted();
    const record = await comparePolicies({ id: fixture.id, input: fixture.input, legacy: options.createLegacy(fixture), candidate: options.createCandidate(fixture), annotation: fixture.annotation, signal, timeoutMs: options.timeoutMs });
    if (options.mode === 'recorded-reviewer-fixtures' && fixture.recordedReviewer) record.recordedReviewer = structuredClone(fixture.recordedReviewer);
    records.push(record);
  }
  return { mode: options.mode ?? 'deterministic-only', fixtureCount: records.length, summary: summarizeShadow(records), records, recordedReviewerResultsAreSimulation: options.mode === 'recorded-reviewer-fixtures', modelCallsInitiatedByShadow: 0 as const, toolsExecuted: 0 as const, executionAuthorized: false as const };
}
