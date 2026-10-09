import type { TypedHookRegistrar } from './hooks.js';
import type { ApprovalTool, CapabilityKind, CapabilityMap, CapabilityRecord, Disposer, MaybePromise, PluginConfigSnapshot, ReadonlyEventSubscription, TypedCapabilityRegistrar } from './capabilities.js';

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: 1;
  requires?: Record<string, string>;
  optional?: Record<string, string>;
  configVersion?: number;
}
export interface PluginConfigDefinition {
  /** 接受 zod 等具备 parse 的 schema；解析结果仍须为普通对象。 */
  schema?: { parse(input: unknown): unknown };
  defaults?: Record<string, unknown>;
  scopes?: readonly ('global' | 'project' | 'session' | 'cli')[];
  sensitiveFields?: readonly string[];
  merge?: Readonly<Record<string, 'replace' | 'append'>>;
  applyMode?: 'new-session' | 'restart';
}
export type DependencyValue<K extends CapabilityKind> = K extends 'tool' ? ApprovalTool : CapabilityMap[K];
export type DependencyRecord<K extends CapabilityKind> = Omit<CapabilityRecord<K>, 'implementation'> & { readonly implementation: DependencyValue<K> };
export interface DependencyHandle {
  readonly manifest: Readonly<PluginManifest>;
  get<K extends CapabilityKind>(kind: K, id: string): DependencyValue<K>;
  list<K extends CapabilityKind>(kind: K): readonly DependencyRecord<K>[];
}
export interface DeclaredDependencies {
  get(pluginId: string): DependencyHandle;
  optional(pluginId: string): DependencyHandle | undefined;
}
export interface PluginSetupContext {
  readonly config: Readonly<PluginConfigSnapshot>;
  readonly provide: TypedCapabilityRegistrar;
  readonly dependencies: DeclaredDependencies;
  readonly events: ReadonlyEventSubscription;
  /** 兼容阶段的变换钩子；通知观测优先使用 events。 */
  readonly hooks: TypedHookRegistrar;
  onDispose(disposer: Disposer): void;
  onActivate(activate: (signal: AbortSignal) => MaybePromise<void>): void;
  /** 资源创建后先登记清理，再执行可能失败的初始化。 */
  withResource<T>(resource: T, dispose: (resource: T) => MaybePromise<void>, initialize?: (resource: T, signal: AbortSignal) => MaybePromise<void>): Promise<T>;
}
export interface Plugin {
  manifest: PluginManifest;
  config?: PluginConfigDefinition;
  setup(context: PluginSetupContext): MaybePromise<void>;
}
export function definePlugin<P extends Plugin>(plugin: P): P { return plugin; }
