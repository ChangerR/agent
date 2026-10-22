import { definePlugin } from '../../sdk/index.js';
import { SummaryCompactor } from './implementation.js';
import { SummaryConfigSchema } from './config.js';
import type { PresetContext } from '../../runtime/preset.js';
export { SummaryCompactor } from './implementation.js';
export function createCompactionSummaryPlugin(routes?: Pick<PresetContext, 'provider'>) {
  return definePlugin({
    manifest: { id: 'agentlab.compaction-summary', version: '1.0.0', apiVersion: 1 },
    config: {
      schema: SummaryConfigSchema,
      ownedFields: [
        'provider',
        'model',
        'thinking',
        'strategy',
        'maxOutputTokens',
        'maxRequestBytes',
      ],
      defaults: {},
      applyMode: 'newSession',
    },
    setup(ctx) {
      const value = ctx.config.value as {
        provider?: string;
        model?: string;
        thinking?: 'off' | 'low' | 'medium' | 'high';
        strategy: 'isolated' | 'prefix';
        maxOutputTokens: number;
        maxRequestBytes?: number;
      };
      if (value.provider && !routes) throw new Error('compaction_provider_unavailable');
      ctx.provide.compactor(
        'summary',
        new SummaryCompactor({
          ...value,
          maxTokens: value.maxOutputTokens,
          provider: value.provider ? () => routes!.provider(value.provider) : undefined,
        }),
      );
    },
  });
}
