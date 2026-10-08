/** 有类型的变换阶段与通知阶段；通知返回值不能变成权限批准。 */
import type { AssistantMessage, StopReason, TokenUsage, ToolResult } from '../core/protocol/types.js';
import type { MaybePromise, ReadonlyDeep } from './capabilities.js';

export interface HookPayloadMap {
  PreToolUse: { readonly toolName: string; readonly input: Readonly<Record<string, unknown>>; readonly signal?: AbortSignal };
  PostToolUse: { readonly toolName: string; readonly input: Readonly<Record<string, unknown>>; readonly result: ReadonlyDeep<ToolResult>; readonly signal?: AbortSignal };
  UserPromptSubmit: { readonly input: string; readonly signal?: AbortSignal };
  TurnEnd: { readonly turn: number; readonly message: ReadonlyDeep<AssistantMessage>; readonly stopReason: StopReason; readonly usage: ReadonlyDeep<TokenUsage>; readonly signal?: AbortSignal };
}
export interface HookResultMap {
  PreToolUse: { input?: Record<string, unknown>; veto?: string } | void;
  PostToolUse: void;
  UserPromptSubmit: void;
  TurnEnd: void;
}
export type TypedHookPoint = keyof HookPayloadMap;
export type TypedHookHandler<K extends TypedHookPoint> = (payload: HookPayloadMap[K]) => MaybePromise<HookResultMap[K]>;
export interface TypedHookRegistrar {
  register<K extends TypedHookPoint>(point: K, handler: TypedHookHandler<K>): void;
}
