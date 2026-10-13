/** 模型只接收判定所需证据；执行身份、版本与取消绑定仍由 ToolExecutor 持有。 */
import type { ReviewInput } from '../../sdk/capabilities.js';
import { shellReviewEvidence } from './shell-evidence.js';

export function reviewEvidence(input: ReviewInput, userRequest: string) {
  // 引用只替换逐字相同的值，原来源、顺序和省略标记都保留。引用不是新授权。
  const conversation = input.context?.conversation.map(({ source, text }) =>
    text === userRequest ? { source, textRef: 'currentUserRequest.text' } : { source, text },
  );
  const previousReviews = input.context?.previousReviews.map((record) => {
    const { userRequest: previousRequest, cwd, ...rest } = record;
    return {
      ...rest,
      ...(previousRequest === userRequest
        ? { userRequestRef: 'currentUserRequest.text' }
        : { userRequest: previousRequest }),
      ...(cwd === input.cwd ? { cwdRef: 'operation.cwd' } : { cwd }),
    };
  });
  // 完整授权与固定工具信息在前。会滑动的历史窗口放在动作之后，不冒充稳定历史。
  return {
    currentUserRequest: { source: 'runtime_user_request', text: userRequest },
    operation: {
      toolName: input.tool.name,
      toolVersion: input.tool.version ?? 'unversioned',
      ownerPlugin: input.tool.ownerPlugin ?? null,
      description: input.tool.description,
      risk: input.tool.risk,
      cwd: input.cwd,
      input: input.input,
    },
    analysis: shellReviewEvidence(input.analysis, input.cwd),
    policy: { decision: input.decision },
    context: input.context
      ? {
          userRequestRef: 'currentUserRequest.text',
          ...(input.context.cwd === input.cwd
            ? { cwdRef: 'operation.cwd' }
            : { cwd: input.context.cwd }),
          conversation,
          omittedConversation: input.context.omittedConversation,
        }
      : null,
    previousReviews: previousReviews ?? [],
    omittedReviews: input.context?.omittedReviews ?? 0,
  };
}
