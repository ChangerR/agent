import { definePlugin } from '../../sdk/index.js';
import { defaultContextSource } from './implementation.js';
export { defaultContextSource, buildDefaultContext, buildSystemPrompt } from './implementation.js';
export function createContextDefaultPlugin() {
  return definePlugin({
    manifest: { id: 'agentlab.context-default', version: '1.0.0', apiVersion: 1 },
    setup(ctx) { ctx.provide.contextSource('default', defaultContextSource); },
  });
}
