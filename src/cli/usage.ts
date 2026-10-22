/** 只汇总厂商已报告的缓存分桶；恢复前或缺失的统计不猜测为零。 */
import type { AgentEvent } from '../core/events.js';
import type { TokenUsage } from '../core/protocol/types.js';

export function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

type Request = Extract<AgentEvent, { type: 'model_request' }>;
type Usage = Extract<AgentEvent, { type: 'model_usage' }>;
interface CacheTotals {
  hitTokens: number;
  missTokens: number;
  unknownRequests: number;
}

export function formatCacheHitRate(totals: CacheTotals): string {
  const denominator = totals.hitTokens + totals.missTokens;
  if (denominator === 0) return totals.unknownRequests ? '?' : '-';
  const percent = (100 * totals.hitTokens) / denominator;
  // 部分命中不因整数四舍五入被显示成全命中。
  const value =
    percent < 100 && percent >= 99.5
      ? Math.min(99.99, Math.floor(percent * 100) / 100).toFixed(2)
      : String(Math.round(percent));
  return `${value}%${totals.unknownRequests ? '（部分）' : ''}`;
}

export class ModelUsageSummary {
  private requests = new Map<string, string>();
  private seen = new Set<string>();
  private groups = new Map<string, CacheTotals>();
  readonly totals: CacheTotals = { hitTokens: 0, missTokens: 0, unknownRequests: 0 };

  request(
    event: Pick<Request, 'requestId' | 'provider' | 'modelRole' | 'purpose'> & {
      request: { model: string };
    },
  ): void {
    this.requests.set(
      event.requestId,
      `${event.provider} / ${event.request.model} / ${event.modelRole ?? event.purpose}`,
    );
  }

  usage(event: Pick<Usage, 'requestId' | 'cache' | 'usageReported'>): void {
    if (this.seen.has(event.requestId)) return;
    this.seen.add(event.requestId);
    const key = this.requests.get(event.requestId) ?? '未知模型 / 未知角色';
    this.requests.delete(event.requestId);
    const group = this.groups.get(key) ?? { hitTokens: 0, missTokens: 0, unknownRequests: 0 };
    this.groups.set(key, group);
    for (const target of [this.totals, group]) {
      if (event.cache && event.usageReported !== false) {
        target.hitTokens += event.cache.hitTokens;
        target.missTokens += event.cache.missTokens;
      } else target.unknownRequests++;
    }
  }

  reset(restored = false): void {
    this.requests.clear();
    this.seen.clear();
    this.groups.clear();
    Object.assign(this.totals, { hitTokens: 0, missTokens: 0, unknownRequests: restored ? 1 : 0 });
  }

  describe(): string {
    return [
      '当前视图收到的模型用量；按已报告的 hit / (hit + miss) 汇总，不代表费用节省。',
      '缺失字段或恢复前未保留的分桶为未知；“部分”表示仅统计已知请求。',
      ...[...this.groups].map(
        ([key, value]) =>
          `${key}: ${formatCacheHitRate(value)} · hit ${value.hitTokens} · miss ${value.missTokens} · 未知 ${value.unknownRequests}`,
      ),
    ].join('\n');
  }
}
