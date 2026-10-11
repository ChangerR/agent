import type { ApprovalTool } from '../../sdk/index.js';
export const SUBAGENT_TOOLS = [
  'agent_spawn',
  'agent_send',
  'agent_wait',
  'agent_status',
  'agent_cancel',
] as const;
export const SUBAGENT_PLUGIN = 'agentlab.subagents';
export function isSubagentControl(tool: ApprovalTool): boolean {
  return (
    tool.ownerPlugin === SUBAGENT_PLUGIN &&
    tool.version === '1.0.0' &&
    (SUBAGENT_TOOLS as readonly string[]).includes(tool.name)
  );
}
