import { describe, expect, it } from 'vitest';
import { ModelUsageSummary, formatCacheHitRate, totalInputTokens } from '../src/cli/usage.js';
import { cacheUsage } from '../src/core/protocol/types.js';

describe('缓存统计展示', () => {
  it('Anthropic 三个输入桶参与分母，按 token 加权并保留模型角色', () => {
    const summary = new ModelUsageSummary();
    summary.request({
      requestId: 'a',
      provider: 'anthropic',
      request: { model: 'claude' },
      purpose: 'agent',
      modelRole: 'main',
    });
    const a = {
      requestId: 'a',
      usageReported: true,
      cache: cacheUsage({ inputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 120 }),
    };
    summary.usage(a);
    summary.usage(a);
    expect(formatCacheHitRate(summary.totals)).toBe('87%');
    expect(
      totalInputTokens({
        inputTokens: 10,
        cacheReadTokens: 900,
        cacheWriteTokens: 120,
        outputTokens: 1,
      }),
    ).toBe(1030);
    summary.request({
      requestId: 'b',
      provider: 'openai',
      request: { model: 'deepseek-flash' },
      purpose: 'judge',
      modelRole: 'judge',
    });
    summary.usage({ requestId: 'b', cache: { hitTokens: 100, missTokens: 100 } });
    expect(formatCacheHitRate(summary.totals)).toBe('81%');
    expect(summary.describe()).toContain('anthropic / claude / main: 87%');
    expect(summary.describe()).toContain('openai / deepseek-flash / judge: 50%');
  });

  it('未知输入不会作为零命中混进分母，恢复不伪造历史完整性', () => {
    const summary = new ModelUsageSummary();
    expect(formatCacheHitRate(summary.totals)).toBe('-');
    summary.usage({ requestId: 'missing', usageReported: false });
    expect(formatCacheHitRate(summary.totals)).toBe('?');
    summary.usage({
      requestId: 'known',
      cache: { hitTokens: 50, missTokens: 50 },
      usageReported: true,
    });
    expect(formatCacheHitRate(summary.totals)).toBe('50%（部分）');
    summary.reset(true);
    expect(formatCacheHitRate(summary.totals)).toBe('?');
    summary.reset();
    expect(formatCacheHitRate(summary.totals)).toBe('-');
  });

  it('少量未命中不显示为 100%', () => {
    expect(formatCacheHitRate({ hitTokens: 999999, missTokens: 1, unknownRequests: 0 })).toBe(
      '99.99%',
    );
    expect(formatCacheHitRate({ hitTokens: 10, missTokens: 0, unknownRequests: 0 })).toBe('100%');
  });
});
