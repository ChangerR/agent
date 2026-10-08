/** 默认策略保留 v1 的真实优先级；只有 auto 的模式兜底可以委托模型。 */
import type { Policy } from '../../sdk/capabilities.js';
import { PermissionEngine } from './engine.js';
export { PermissionEngine, parseRule, matchRule } from './engine.js';

export function createLegacyPolicy(controller: PermissionEngine): Policy {
  return {
    id: 'legacy-v1',
    version: '1.0.0',
    controller,
    analyzer: controller.createAnalyzer(),
    get revision() { return controller.revision; },
    decide({ tool, input }, signal) {
      signal.throwIfAborted();
      const decision = controller.check(tool, input);
      return decision.kind === 'ask' && decision.source === 'mode' && controller.mode === 'auto'
        ? { ...decision, kind: 'review', reasonCode: 'legacy_auto_review' }
        : { ...decision, reasonCode: `legacy_${decision.source}_${decision.kind}` };
    },
  };
}
