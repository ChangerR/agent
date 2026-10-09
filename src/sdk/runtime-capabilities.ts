/** 可替换的上下文、持久化和观测能力；输入快照由内核创建。 */
import type { ModelInfo } from '../core/config.js';
import type { ObservedEvent } from './capabilities.js';
import type { EventBus } from '../core/events.js';
import type { CachePolicy, CacheTtl, Provider } from '../core/provider.js';
import type { Message } from '../core/protocol/types.js';
import type { Tool } from '../core/registry.js';
import type { SessionFile, SessionListing } from '../core/session/types.js';

export interface ContextSegment {
  id: string;
  source: string;
  stability: 'stable' | 'session' | 'turn';
  text: string;
}
export type ContextToolSummary = Pick<Tool, 'name' | 'description' | 'risk' | 'inputSchema'>;
export interface ContextInput {
  readonly cwd: string;
  readonly tools: readonly ContextToolSummary[];
  readonly skills: readonly { name: string; description: string }[];
}
export interface ContextSource {
  getContext(input: ContextInput, signal: AbortSignal): readonly ContextSegment[] | Promise<readonly ContextSegment[]>;
}
export interface Compactor {
  /** 只提交候选消息。内核负责不可变快照、取消检查和工具交换完整性校验。 */
  compact(messages: readonly Message[], provider: Provider | null, signal: AbortSignal, model?: string, events?: EventBus): Promise<readonly Message[]>;
}
export interface ContextCoordinator {
  readonly threshold: number;
  setThreshold(threshold: number): void;
  shouldCompact(messages: readonly Message[]): boolean;
  compact(messages: Message[], provider: Provider | null, signal: AbortSignal, model?: string, events?: EventBus): Promise<Message[]>;
}
export interface CacheStrategyInput {
  readonly messageCount: number;
  readonly previousMessageCount: number;
  readonly lastToolBatchMs: number;
  readonly hasSystem: boolean;
  readonly hasTools: boolean;
  readonly settings: Readonly<{ enabled: boolean; ttl: CacheTtl; escalateAfterMs?: number }>;
}
export interface CacheStrategy { build(input: CacheStrategyInput): CachePolicy | undefined }
export interface ModelCatalog {
  get(model: string): ModelInfo | undefined;
  list(): Readonly<Record<string, ModelInfo>>;
}
export interface SaveSessionOptions {
  recreate?: boolean;
  recreateRevision?: number;
}
export interface SessionStore {
  path(cwd: string, id: string): string;
  load(cwd: string, id: string, signal?: AbortSignal): Promise<SessionFile>;
  save(file: SessionFile, options?: SaveSessionOptions, signal?: AbortSignal): Promise<{ path: string; revision: number }>;
  list(cwd: string, signal?: AbortSignal): Promise<SessionListing>;
  delete(cwd: string, id: string, signal?: AbortSignal): Promise<{ deleted: boolean; revision: number }>;
  latest(cwd: string, signal?: AbortSignal): Promise<string | undefined>;
}
/** 不传可调用的审批 resolver，事件只用于观测。 */
export type TelemetryEvent = ObservedEvent;
export interface Telemetry {
  onEvent(event: Readonly<TelemetryEvent>): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
