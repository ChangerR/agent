/**
 * 类型化事件总线。
 *
 * AgentLoop 不碰 UI，所有对外沟通都通过事件；TUI / 测试 / 日志都只是订阅者。
 * 这是 core 与 cli 解耦的关键机制。
 */
import { EventEmitter } from 'node:events';
import type { AssistantMessage, Message, TokenUsage, ToolResult, ToolUseBlock } from './protocol/types.js';
import type { ChatRequest, ThinkingLevel } from './provider.js';
import type { Decision } from './permission/engine.js';

/** 权限询问的请求与回传 */
export interface PermissionRequest {
  toolName: string;
  /** 请求对应的模型工具调用及实际触发审批的决策来源。 */
  toolUseId?: string;
  decisionSource?: Decision['source'];
  matchedRule?: string;
  cwd?: string;
  input: unknown;
  /** 展示给用户的一句话摘要，如 `bash: npm test` */
  summary: string;
  reason: string;
}

export type UserDecision =
  | { allow: true; remember?: 'session' | 'project' }
  | { allow: false; feedback?: string };

export type LoopEndReason = 'completed' | 'max_turns' | 'max_tokens' | 'aborted' | 'error';

export type AgentEvent =
  | { type: 'model_request'; requestId: string; purpose: 'agent' | 'compact' | 'judge'; provider: string; request: ChatRequest }
  | { type: 'model_usage'; requestId: string; purpose: 'agent' | 'compact' | 'judge'; usage: TokenUsage }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_call'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; toolUseId: string; name: string; result: ToolResult }
  | {
      /** 审核可观测性独立于 UI 提示；静默放行仍保留每阶段的判定。 */
      type: 'permission_decision';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      phase: 'pipeline' | 'judge' | 'user';
      decision: Decision;
    }
  | {
      type: 'permission_request';
      request: PermissionRequest;
      /** 请求所属轮次的取消信号，订阅者可用它释放审批界面。 */
      signal: AbortSignal;
      resolve: (decision: UserDecision) => void;
    }
  | { type: 'turn_end'; stopReason: string; usage: TokenUsage }
  | { type: 'notice'; text: string }
  | { type: 'loop_end'; reason: LoopEndReason; turns?: number; usage?: TokenUsage; error?: string }
  | { type: 'compacted'; beforeMessages: number; afterMessages: number }
  | { type: 'error'; error: Error }
  | { type: 'session_saved'; id: string; path: string; trimmed: number }
  | { type: 'session_restored'; id: string; title: string; model: string; thinking: ThinkingLevel; usage: TokenUsage; messages: readonly Message[] };

type Handler<E> = (event: E) => void;

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<T extends AgentEvent['type']>(type: T, handler: Handler<Extract<AgentEvent, { type: T }>>): () => void {
    this.emitter.on(type, handler as Handler<AgentEvent>);
    return () => this.emitter.off(type, handler as Handler<AgentEvent>);
  }

  emit(event: AgentEvent): void {
    // Node 的 error 事件在没有订阅者时会抛异常；headless 使用不应依赖 UI 兜底。
    if (event.type === 'error' && this.emitter.listenerCount('error') === 0) return;
    this.emitter.emit(event.type, event);
  }
}
