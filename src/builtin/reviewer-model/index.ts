/** 旧 AutoJudge 包装成可替换 reviewer；不取得权限控制器或工具执行句柄。 */
import type { Reviewer } from '../../sdk/capabilities.js';
import { AutoJudge } from './judge.js';
export { AutoJudge, mergeJudgeDecision } from './judge.js';
export { ReviewHistory } from './review-context.js';

export function createModelReviewer(judge: AutoJudge): Reviewer {
  return {
    getStatus: () => judge.getStatus(),
    createHistory: () => judge.createHistory(),
    async review(input, signal) {
      const verdict = await judge.review(input.tool, input.input, signal, input.events, input.context);
      return { decision: verdict.verdict, reason: verdict.reason,
        reasonCode: verdict.judge?.reasonCode ?? `model_${verdict.verdict}`, judge: verdict.judge };
    },
  };
}
