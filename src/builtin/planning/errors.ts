/** 仅包含固定文案的规划错误；前端和脱敏日志不转发模型正文或 SDK 异常。 */
const messages = {
  planning_invalid_response:
    '规划结构连续两次无效，未开始执行；会话记录已保留，请重新提交任务。查看会话 token 与缓存统计可直接输入 /stats。',
  planning_incomplete_response: '规划未完整返回，未开始执行；请重新提交任务。',
  planning_output_truncated: '规划未完整返回：达到输出上限，未开始执行；请缩小任务范围后重新提交。',
} as const;

export type PlanningErrorCode = keyof typeof messages;

export class PlanningError extends Error {
  constructor(readonly code: PlanningErrorCode) {
    super(messages[code]);
    this.name = 'PlanningError';
  }
}

export function planningErrorCode(error: unknown): PlanningErrorCode | undefined {
  if (!error || typeof error !== 'object' || !('name' in error) || error.name !== 'PlanningError')
    return;
  if (!('code' in error) || typeof error.code !== 'string' || !Object.hasOwn(messages, error.code))
    return;
  return error.code as PlanningErrorCode;
}

export function planningErrorMessage(error: unknown): string | undefined {
  // 使用固定映射，不能信任可被插件或 SDK 修改的 error.message。
  const code = planningErrorCode(error);
  return code ? messages[code] : undefined;
}
