/** 子任务的纯数据契约；不依赖具体 supervisor 或界面。 */
import type { TokenUsage } from './protocol/types.js';

export type InputSource = 'user' | 'delegation' | 'subagent' | 'tool';
export interface InvocationOrigin {
  readonly sessionId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly source: InputSource;
  /** 只由真实用户入口绑定；委派文本与工具结果不得填入这个字段。 */
  readonly userRequest: string;
  /** 宿主为真实用户方向创建的执行范围；委派必须继承，不能由模型重置。 */
  readonly permissionScope?: string;
}
export type SubagentStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'limited';
export interface SubagentRun {
  runId: string;
  task: string;
  status: SubagentStatus;
  activity: string;
  output: string;
  truncated: boolean;
  usage: TokenUsage;
  turns: number;
  error?: string;
  reason?: string;
}
export interface SubagentRecord {
  agentId: string;
  sessionId: string;
  rootSessionId: string;
  parentAgentId: string;
  name: string;
  depth: number;
  context: 'fresh' | 'snapshot';
  readOnly: boolean;
  allowedTools?: string[];
  runs: SubagentRun[];
}
export interface AgentSessionState {
  owner?: { rootSessionId: string; parentAgentId: string; agentId: string };
  children?: SubagentRecord[];
  agent?: SubagentRecord;
}
export interface SubagentProgress {
  type: 'subagent_event';
  agentId: string;
  runId: string;
  seq: number;
  name: string;
  kind: 'status' | 'text' | 'usage' | 'complete';
  status: SubagentStatus;
  activity: string;
  text?: string;
  requestId?: string;
  purpose?: 'agent' | 'compact' | 'judge';
  usage?: TokenUsage;
  /** child 的独立事件快照；不会作为父 loop 的 text/tool/session 事件重放。 */
  detail?: Record<string, unknown>;
}
