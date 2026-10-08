/** 公共能力契约：只依赖协议和结构，不把具体实现或终端类型带进 SDK。 */
import type { AgentConfig, PermissionMode } from '../core/config.js';
import type { AgentEvent, EventBus } from '../core/events.js';
import type { Decision, AuditEntry, SessionRules, JudgeMetadata, ReviewContext, ReviewHistoryStore } from '../core/permission/contracts.js';
import type { Provider } from '../core/provider.js';
import type { Tool, ToolResult } from './protocol.js';
import type { ContextSource, Compactor, CacheStrategy, ModelCatalog, SessionStore, Telemetry } from './runtime-capabilities.js';

export type MaybePromise<T> = T | Promise<T>;
export type Disposer = () => MaybePromise<void>;
export type ReadonlyDeep<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly ReadonlyDeep<U>[] : T extends object ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> } : T;

export type ApprovalTool = Omit<Tool, 'execute'>;
export interface AnalysisInput { readonly tool: ApprovalTool; readonly input: Readonly<Record<string, unknown>>; readonly cwd: string }
export interface ToolAnalysis {
  analyzerId: string;
  analyzerVersion: string;
  completeness: 'complete' | 'partial' | 'unknown';
  effects: readonly { kind: 'read' | 'write' | 'execute' | 'network' | 'unknown'; target?: string; scope?: 'project' | 'external' | 'sensitive' | 'unknown' }[];
  targets?: readonly string[];
  evidence?: readonly { source: string; detail: string }[];
  environment?: Readonly<Record<string, string>>;
  summary?: string;
  reasonCode?: string;
}
export interface ToolAnalyzer {
  readonly id?: string;
  readonly version?: string;
  analyze(input: AnalysisInput, signal: AbortSignal): MaybePromise<ToolAnalysis>;
  revalidate?(analysis: ToolAnalysis, input: AnalysisInput, signal: AbortSignal): MaybePromise<boolean>;
}
export interface PolicyInput extends AnalysisInput {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly analysis?: ToolAnalysis;
  readonly context?: ReviewContext;
  readonly configRevision?: string | number;
  readonly policyRevision?: string | number;
}
export type PolicyDecision = Omit<Decision, 'kind'> & {
  kind: 'allow' | 'ask' | 'deny' | 'review';
  reasonCode?: string;
  reviewEligible?: boolean;
};
/** 仅供显式设置与会话恢复；reviewer 不接收此控制器。 */
export interface PermissionController {
  readonly mode: PermissionMode;
  readonly revision?: string | number;
  validateMode?(mode: PermissionMode): void;
  setMode(mode: PermissionMode): void;
  addSessionRule(kind: 'allow' | 'ask' | 'deny', rule: string): void;
  getSessionRules(): SessionRules;
  validateSessionRules?(rules: Partial<SessionRules>): void;
  validateMode?(mode: PermissionMode): void;
  setSessionRules(rules: Partial<SessionRules>): void;
  clearSessionRules(): void;
  getAuditLog(): readonly AuditEntry[];
  recordDecision(tool: ApprovalTool, input: Record<string, unknown>, decision: Decision): void;
}
export interface Policy {
  readonly id?: string;
  readonly version?: string;
  readonly revision?: string | number;
  readonly controller?: PermissionController;
  readonly analyzer?: ToolAnalyzer;
  decide(input: PolicyInput, signal: AbortSignal): MaybePromise<PolicyDecision>;
}
export type PermissionPolicy = Policy;
export interface ReviewInput extends PolicyInput {
  readonly decision: PolicyDecision;
  readonly events?: EventBus;
  readonly userRequest?: string;
  readonly messages?: readonly import('../core/protocol/types.js').Message[];
}
export interface ReviewResult {
  decision: 'allow' | 'ask' | 'deny' | 'unknown';
  reasonCode: string;
  reason: string;
  judge?: JudgeMetadata;
}
export interface ReviewerStatus { loaded: boolean; model?: string; source?: 'current' | 'explicit'; reason?: string }
export interface Reviewer {
  review(input: ReviewInput, signal: AbortSignal): Promise<ReviewResult>;
  getStatus?(): ReviewerStatus;
  createHistory?(): ReviewHistoryStore;
}

/** 观测没有 resolver 或活动 AbortSignal，不能偷偷充当审批通道。 */
type Observable<E> = E extends { type: 'permission_request' } ? Omit<E, 'resolve' | 'signal'> : E;
export type ObservedEvent = ReadonlyDeep<Observable<AgentEvent>>;
export interface ReadonlyEventSubscription {
  on<T extends AgentEvent['type']>(type: T, handler: (event: Extract<ObservedEvent, { type: T }>) => MaybePromise<void>): Disposer;
}
export interface SkillDescriptor { name: string; description: string; body: string; path: string }
export interface SkillSource { list(): SkillDescriptor[]; get(name: string): SkillDescriptor | undefined }
export interface InteractionRequest { type: 'interaction'; id: string; prompt: string; kind?: 'select' | 'input' | 'confirm' | 'details'; initialValue?: string; body?: string; requireSelection?: boolean; choices?: readonly { id: string; label: string; description?: string }[] }
export type CommandResult = { type: 'text'; text: string } | { type: 'data'; data: unknown; text?: string } | InteractionRequest | void;
export interface CommandInspection {
  commands: readonly { id: string; description: string }[];
  settings: readonly { id: string; ownerPlugin: string; title: string; description?: string; applyMode: SettingsSection['applyMode'] }[];
  plugins: readonly { id: string; version: string }[];
  tools: readonly { name: string; risk: string }[];
}
export interface CommandContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
  invokeTool(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  interact?(request: InteractionRequest): Promise<string | undefined>;
  inspect?(): CommandInspection;
}
export interface Command {
  description: string;
  aliases?: readonly string[];
  inputSchema?: Record<string, unknown>;
  requiredCapabilities?: readonly { kind: CapabilityKind; id: string }[];
  handler(input: Record<string, unknown>, context: CommandContext): MaybePromise<CommandResult>;
}
export interface SettingsSection {
  order?: number;
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  applyMode: 'immediate' | 'new-session' | 'restart' | 'nextRequest' | 'idleBoundary' | 'newSession';
  read?(signal: AbortSignal): MaybePromise<unknown>;
  draft?(value: unknown, signal: AbortSignal): MaybePromise<unknown>;
  commit?(draft: unknown, signal: AbortSignal): MaybePromise<void>;
}
/** 纯数据可选 TUI 描述；实现包由终端适配器选择加载，headless 不会 import。 */
export interface TuiDescriptor { entry: string; kind: 'tool-renderer' | 'status' | 'editor'; capabilityId?: string; title?: string }
export interface CapabilityMap {
  provider: Provider;
  tool: Tool;
  analyzer: ToolAnalyzer;
  policy: Policy;
  reviewer: Reviewer;
  contextSource: ContextSource;
  compactor: Compactor;
  cacheStrategy: CacheStrategy;
  modelCatalog: ModelCatalog;
  sessionStore: SessionStore;
  skillSource: SkillSource;
  command: Command;
  settings: SettingsSection;
  telemetry: Telemetry;
  tui: TuiDescriptor;
}
export type CapabilityKind = keyof CapabilityMap;
export const CAPABILITY_KINDS = ['provider', 'tool', 'analyzer', 'policy', 'reviewer', 'contextSource', 'compactor', 'cacheStrategy', 'modelCatalog', 'sessionStore', 'skillSource', 'command', 'settings', 'telemetry', 'tui'] as const satisfies readonly CapabilityKind[];
export type SingletonCapabilityKind = 'policy' | 'reviewer' | 'compactor' | 'cacheStrategy' | 'modelCatalog' | 'sessionStore';
export type CapabilitySelections = Partial<Record<SingletonCapabilityKind, string | false>>;
export interface CapabilityOptions { version?: string; aliases?: readonly string[]; source?: string }
export interface CapabilityRecord<K extends CapabilityKind = CapabilityKind> {
  readonly kind: K;
  readonly capabilityId: string;
  readonly ownerPlugin: string;
  readonly version: string;
  readonly source: string;
  readonly aliases: readonly string[];
  readonly implementation: CapabilityMap[K];
}
export type TypedCapabilityRegistrar = { [K in CapabilityKind]: (id: string, implementation: CapabilityMap[K], options?: CapabilityOptions) => void };
export interface PluginConfigSnapshot {
  readonly revision: string | number;
  readonly core: ReadonlyDeep<AgentConfig>;
  readonly value: Readonly<Record<string, unknown>>;
  readonly sources?: Readonly<Record<string, string>>;
}
