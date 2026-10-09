/** 只观察已发生的模型请求；review eligible 绝不冒充一次模型调用。 */
import type { ObservedEvent } from '../../sdk/index.js';
import type { TokenUsage } from '../../core/protocol/types.js';
export type ModelPurpose = 'agent' | 'compact' | 'judge';
interface RequestSample { purpose: ModelPurpose; startedAt?: number; endedAt?: number; usage?: TokenUsage }
export interface PurposeMetrics {
  modelCalls: number;
  completedRequests: number;
  usageKnownRequests: number;
  usageUnknownRequests: number;
  usageStatus: 'complete' | 'partial' | 'unknown';
  observedTokens: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
  latency: { samples: number; totalMs: number | null; meanMs: number | null; maxMs: number | null };
}
export interface ObservedModelMetrics { purposes: Record<ModelPurpose, PurposeMetrics>; humanRequests: number; source: 'observed-runtime-events'; modelCallsInitiatedByShadow: 0 }
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
function validUsage(usage: TokenUsage): boolean { return fields.every(field => Number.isSafeInteger(usage[field]) && usage[field] >= 0); }
export class ShadowModelMetrics {
  private readonly samples = new Map<string, RequestSample>();
  private humanRequests = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  observe(event: ObservedEvent): void {
    if (event.type === 'permission_request') { this.humanRequests++; return; }
    if (event.type === 'model_request') {
      if (!this.samples.has(event.requestId)) this.samples.set(event.requestId, { purpose: event.purpose, startedAt: this.now() });
      return;
    }
    if (event.type !== 'model_usage') return;
    // 无对应 request 的观察不能制造模型调用数或请求耗时。
    const sample = this.samples.get(event.requestId);
    if (!sample || sample.purpose !== event.purpose || sample.endedAt !== undefined) return;
    sample.endedAt = this.now();
    // 旧 observedStream 对缺失 usage 也发全零；没有明确 reported 标记时全零按未知。
    const reported = (event as unknown as { usageReported?: boolean }).usageReported;
    if (reported !== false && validUsage(event.usage) && (reported === true || fields.some(field => event.usage[field] > 0))) sample.usage = { ...event.usage };
  }
  snapshot(): ObservedModelMetrics {
    const purpose = (kind: ModelPurpose): PurposeMetrics => {
      const values = [...this.samples.values()].filter(sample => sample.purpose === kind);
      const usages = values.flatMap(sample => sample.usage ? [sample.usage] : []);
      const latencies = values.flatMap(sample => sample.startedAt !== undefined && sample.endedAt !== undefined ? [Math.max(0, sample.endedAt - sample.startedAt)] : []);
      const tokens = Object.fromEntries(fields.map(field => [field, usages.length ? usages.reduce((sum, usage) => sum + usage[field], 0) : null])) as PurposeMetrics['observedTokens'];
      return {
        modelCalls: values.length,
        completedRequests: values.filter(sample => sample.endedAt !== undefined).length,
        usageKnownRequests: usages.length,
        usageUnknownRequests: values.length - usages.length,
        usageStatus: !usages.length ? 'unknown' : usages.length === values.length ? 'complete' : 'partial',
        observedTokens: tokens,
        latency: { samples: latencies.length, totalMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) : null, meanMs: latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null, maxMs: latencies.length ? Math.max(...latencies) : null },
      };
    };
    return { purposes: { agent: purpose('agent'), compact: purpose('compact'), judge: purpose('judge') }, humanRequests: this.humanRequests, source: 'observed-runtime-events', modelCallsInitiatedByShadow: 0 };
  }
}
