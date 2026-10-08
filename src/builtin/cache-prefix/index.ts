/** 保留既有 5m、上一轮末尾 + 本轮末尾和工具耗时升级语义。 */
import { definePlugin } from '../../sdk/index.js';
import type { CacheStrategy } from '../../sdk/runtime-capabilities.js';

export const prefixCacheStrategy: CacheStrategy = {
  build(input) {
    if (!input.settings.enabled) return undefined;
    const last = input.messageCount - 1;
    const previous = input.previousMessageCount - 1;
    return {
      system: input.hasSystem,
      tools: input.hasTools,
      messageBreakpoints: [...new Set([previous, last])].filter((n) => n >= 0 && n <= last).sort((a, b) => a - b),
      ttl: (input.settings.escalateAfterMs ?? 0) > 0 && input.lastToolBatchMs > input.settings.escalateAfterMs! ? '1h' : input.settings.ttl,
    };
  },
};
export function createCachePrefixPlugin() {
  return definePlugin({
    manifest: { id: 'agentlab.cache-prefix', version: '1.0.0', apiVersion: 1 },
    setup(ctx) { ctx.provide.cacheStrategy('prefix', prefixCacheStrategy); },
  });
}
