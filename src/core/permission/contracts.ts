/** 审批协议：只包含结构化数据与接口，不依赖默认策略或模型实现。 */
import type { Message, ToolResult } from '../protocol/types.js';
import type { Tool } from '../registry.js';

export type DecisionKind = 'allow' | 'ask' | 'deny';
export type JudgeReasonCode = 'model_allow' | 'model_ask' | 'model_deny' | 'invalid_response' | 'incomplete_response' | 'provider_error' | 'cancelled' | 'timeout' | 'input_budget' | 'user_request_budget' | 'request_budget';
export interface JudgeMetadata { model: string; source: 'current' | 'explicit'; reasonCode: JudgeReasonCode }
export interface JudgeStatus { provider?: string; providerSource?: 'current' | 'explicit'; loaded: boolean; model?: string; source?: 'current' | 'explicit' }
export interface Decision {
  kind: DecisionKind;
  reason: string;
  reasonCode?: string;
  matchedRule?: string;
  judge?: JudgeMetadata;
  source: 'session' | 'config' | 'builtin' | 'mode' | 'danger' | 'judge' | 'user';
}
export interface ParsedRule { raw: string; tool: string; pattern?: string; exact?: string }
export interface SessionRules { allow: string[]; ask: string[]; deny: string[] }
export interface AuditEntry { toolName: string; summary: string; decision: Decision; at: number }
export interface ReviewRecord {
  toolName: string;
  input?: Record<string, unknown>;
  inputOmitted: boolean;
  cwd: string;
  userRequest: string;
  decision: Decision;
  outcome: 'pending' | 'success' | 'error' | 'not_executed' | 'cancelled';
  result?: string;
  at: number;
}
export interface ReviewContext {
  cwd: string;
  userRequest: string;
  conversation: Array<{ source: 'user' | 'assistant' | 'tool' | 'summary'; text: string }>;
  previousReviews: Array<ReviewRecord & { sameOperation: boolean }>;
  omittedConversation: boolean;
  omittedReviews: number;
}
export interface ReviewHistoryStore {
  clear(): void;
  build(tool: Omit<Tool, 'execute'>, input: Record<string, unknown>, cwd: string, userRequest: string, messages: readonly Message[]): ReviewContext;
  record(tool: Omit<Tool, 'execute'>, input: Record<string, unknown>, cwd: string, userRequest: string, decision: Decision): ReviewRecord;
  finish(record: ReviewRecord, result: ToolResult, cancelled: boolean): void;
}
