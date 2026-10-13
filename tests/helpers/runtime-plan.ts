import type { ChatRequest } from '../../src/core/provider.js';
import type { Plan } from '../../src/core/plan.js';

/** 测试 provider 读取最新运行时状态，不再从 system 中解析计划。 */
export function requestPlan(request: ChatRequest): Plan {
  const state = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user' && message.source === 'runtime');
  if (!state || typeof state.content !== 'string') throw new Error('Missing runtime plan');
  const plan = JSON.parse(state.content).plan as Plan | null;
  if (!plan) throw new Error('Missing current plan');
  return plan;
}
