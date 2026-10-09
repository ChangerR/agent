import { definePlugin } from '../../sdk/index.js';
import { SummaryCompactor } from './implementation.js';
export { SummaryCompactor } from './implementation.js';
export function createCompactionSummaryPlugin() {
  return definePlugin({
    manifest: { id: 'agentlab.compaction-summary', version: '1.0.0', apiVersion: 1 },
    setup(ctx) { ctx.provide.compactor('summary', new SummaryCompactor()); },
  });
}
