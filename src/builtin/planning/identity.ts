import type { ApprovalTool } from '../../sdk/index.js';
export const PLANNING_PLUGIN = 'agentlab.planning';
export const PLAN_TOOLS = ['plan_status', 'plan_update'] as const;
export function isPlanControl(tool: ApprovalTool): boolean {
  return (
    tool.ownerPlugin === PLANNING_PLUGIN &&
    tool.version === '1.0.0' &&
    (PLAN_TOOLS as readonly string[]).includes(tool.name)
  );
}
