/**
 * 类型化事件总线。
 *
 * AgentLoop 不碰 UI，所有对外沟通都通过事件；TUI / 测试 / 日志都只是订阅者。
 * 这是 core 与 cli 解耦的关键机制。
 */
import { EventEmitter } from 'node:events';
import type { AssistantMessage, TokenUsage, ToolResult, ToolUseBlock } from './protocol/types.js';

/** 权限询问的请求与回传 */
export interface PermissionRequest {
  toolName: string;
  input: unknown;
  /** 展示给用户的一句话摘要，如 `bash: npm test` */
  summary: string;
  reason: string;
}

export type UserDecision =
  | { allow: true; remember?: 'session' | 'project' }
  | { allow: false; feedback?: string };

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_call'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; toolUseId: string; name: string; result: ToolResult }
  | {
      type: 'permission_request';
      request: PermissionRequest;
      resolve: (decision: UserDecision) => void;
    }
  | { type: 'turn_end'; stopReason: string; usage: TokenUsage }
  | { type: 'notice'; text: string }
  | { type: 'loop_end'; reason: 'completed' | 'max_turns' | 'aborted' }
  | { type: 'compacted'; beforeMessages: number; afterMessages: number }
  | { type: 'error'; error: Error };

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
    this.emitter.emit(event.type, event);
  }
}
