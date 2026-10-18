import type { Agent } from '../../src/runtime/agent.js';

/** 与用户操作无参数面板相同，通过交互回调选择，不保留旧命令参数路径。 */
export function selectPlan(
  agent: Pick<Agent, 'dispatchCommand'>,
  action: string,
  direction?: string,
) {
  return agent.dispatchCommand('/plan', {
    interact: async (request) => (request.kind === 'input' ? direction : action),
  });
}
