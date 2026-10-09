/**
 * 类型化事件总线。
 *
 * AgentLoop 不碰 UI，所有对外沟通都通过事件；TUI / 测试 / 日志都只是订阅者。
 * 这是 core 与 cli 解耦的关键机制。
 */
import { EventEmitter } from 'node:events';
import type { AssistantMessage, Message, TokenUsage, ToolResult, ToolUseBlock } from './protocol/types.js';
import type { ChatRequest, ThinkingLevel } from './provider.js';
import type { Decision } from './permission/contracts.js';

/** 权限询问的请求与回传 */
export interface PermissionRequest {
  /** 一次工具调用审计 ID；requestId 单独标识每次人工询问。 */
  toolRequestId?: string;
  runId?: string;
  requestId?: string;
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
  | { type: 'model_request'; requestId: string; purpose: 'agent' | 'compact' | 'judge'; provider: string; request: ChatRequest; runId?: string; toolCallId?: string; toolRequestId?: string }
  | { type: 'model_usage'; requestId: string; purpose: 'agent' | 'compact' | 'judge'; usage: TokenUsage; runId?: string; toolCallId?: string; toolRequestId?: string }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'assistant_message'; message: AssistantMessage }
  | { type: 'tool_call'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; toolUseId: string; name: string; result: ToolResult }
  | {
      /** 不含参数正文的结构化执行审计，适用于模型、命令和子工具。 */
      type: 'tool_execution';
      runId: string;
      toolCallId: string;
      requestId: string;
      sessionId: string;
      toolName: string;
      toolVersion: string;
      toolOwner?: string;
      capabilityId?: string;
      policyId: string;
      policyVersion: string;
      configRevision: string | number;
      policyRevision: string | number;
      inputHash?: string;
      phase: 'validation' | 'analysis' | 'policy' | 'reviewer' | 'human' | 'execution';
      reasonCode: string;
      decision?: 'allow' | 'ask' | 'deny' | 'review';
      durationMs?: number;
    }
  | {
      /** 审核可观测性独立于 UI 提示；静默放行仍保留每阶段的判定。 */
      type: 'permission_decision';
      runId?: string;
      requestId?: string;
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
  private observers = new Set<(event: AgentEvent) => void>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<T extends AgentEvent['type']>(type: T, handler: Handler<Extract<AgentEvent, { type: T }>>): () => void {
    this.emitter.on(type, handler as Handler<AgentEvent>);
    return () => this.emitter.off(type, handler as Handler<AgentEvent>);
  }

  hasListeners(type: AgentEvent['type']): boolean {
    return this.emitter.listenerCount(type) > 0;
  }

  /** 通用观测不算人工审批 responder；异常不能触发已执行工具重试。 */
  onAll(handler: (event: AgentEvent) => void): () => void {
    this.observers.add(handler);
    return () => { this.observers.delete(handler); };
  }

  emit(event: AgentEvent): void {
    for (const observer of this.observers) this.deliver(observer, event, false);
    // 单个 renderer/观测者失败不能把成功的工具伪装成失败或阻断其他订阅者。
    for (const handler of this.emitter.listeners(event.type)) this.deliver(handler as Handler<AgentEvent>, event, true);
  }

  private deliver(handler: Handler<AgentEvent>, event: AgentEvent, responder: boolean): void {
    const failed = () => {
      if (responder && event.type === 'permission_request') event.resolve({ allow: false, feedback: 'Approval responder failed' });
      if (event.type !== 'notice') this.emit({ type: 'notice', text: `事件订阅者失败（${event.type}）；原始执行结果已保留` });
    };
    try {
      const value: unknown = handler(event);
      if (value && typeof value === 'object' && 'then' in value) Promise.resolve(value).catch(failed);
    } catch { failed(); }
  }
}
