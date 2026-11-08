/** reviewer 协议专项：显式测试策略委托未知操作，执行体必须是无副作用替身。
 * 默认策略的未知操作人工边界由 permission-redesign / deterministic-policy 独立验收。
 */
import {
  createDeterministicPolicy,
  type DeterministicPolicyOptions,
} from '../../src/builtin/policy/index.js';
export function createReviewTestPolicy(options: DeterministicPolicyOptions) {
  const policy = createDeterministicPolicy(options);
  const decide = policy.decide.bind(policy);
  policy.decide = async (input, signal) => {
    const result = await decide(input, signal);
    if (policy.controller?.mode === 'auto' && result.reasonCode === 'unknown_operation')
      return {
        ...result,
        kind: 'review',
        reasonCode: 'review_uncertain',
        reason: '测试策略委托当前无副作用替身调用',
      };
    return result;
  };
  return policy;
}
