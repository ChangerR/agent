/** preset 领域服务；runtime 只提供结构化接点，不依赖 builtin。 */
import type { ThinkingLevel } from '../core/provider.js';
import type { SessionManager } from '../core/session/coordinator.js';
import type { PermissionController } from '../sdk/index.js';
import type { AgentSupervisor, SubagentLimits } from './subagents.js';
export interface RuntimeServices {
  loop(): import('../core/loop.js').AgentLoop;
  plan(agentId?: string): import('../core/plan.js').PlanController;
  run(text: string): Promise<unknown>;
  stopPlan(kind: 'paused' | 'cancelled', reason: string): void;
  configurePlanning(
    strategy: import('../core/plan.js').PlanningStrategy,
    mode: import('../core/plan.js').PlanningMode,
  ): void;

  model(): string;
  setModel(value: string): void;
  thinking(): ThinkingLevel;
  setThinking(value: ThinkingLevel): void;
  models(): Array<{ name: string; info?: { contextWindow: number; maxOutputTokens: number } }>;
  permission(): PermissionController;
  session(): SessionManager;
  agents(): AgentSupervisor;
  configureAgents(limits: Partial<SubagentLimits>): void;
}
