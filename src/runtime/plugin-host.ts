/** 可信本地插件宿主：事务注册、稳定依赖顺序、失败回滚与逆序资源释放。 */
import { AgentConfigSchema, type AgentConfig } from '../core/config.js';
import { EventBus, type AgentEvent } from '../core/events.js';
import type { HookHandler, HookPoint, HookRunner } from '../core/hooks.js';
import { CAPABILITY_KINDS, type CapabilityKind, type CapabilityMap, type CapabilityOptions, type CapabilityRecord, type CapabilitySelections, type Disposer, type ObservedEvent, type ReadonlyEventSubscription, type SingletonCapabilityKind, type TypedCapabilityRegistrar } from '../sdk/capabilities.js';
import type { DependencyHandle, DependencyValue, Plugin, PluginManifest, PluginSetupContext } from '../sdk/plugin.js';
import { CapabilityRegistry } from './capability-registry.js';

export interface PluginDiagnostic { pluginId?: string; code: string; message: string }
export interface PluginHostOptions {
  config?: AgentConfig;
  pluginConfig?: Record<string, Record<string, unknown>>;
  pluginConfigLayers?: Partial<Record<'global' | 'project' | 'session' | 'cli', Record<string, Record<string, unknown>>>>;
  selections?: CapabilitySelections;
  configRevision?: string | number;
  events?: EventBus;
  source?: string;
  /** 清理超时只报告失败，不宣称资源已经释放。 */
  cleanupTimeoutMs?: number;
}
interface HookRegistration { point: HookPoint; handler: HookHandler }
interface Transaction {
  plugin: Plugin;
  records: CapabilityRecord[];
  hooks: HookRegistration[];
  subscriptions: Array<() => Disposer>;
  dispose: Disposer[];
  activate: Array<(signal: AbortSignal) => void | Promise<void>>;
  open: boolean;
}

/** 数据快照不共享引用；函数（尤其审批 resolver）绝不会暴露给观察者。 */
export function observationSnapshot<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const clone = (item: unknown): unknown => {
    if (typeof item === 'function') return undefined;
    if (item === null || typeof item !== 'object') return item;
    if (item instanceof AbortSignal) return undefined;
    if (seen.has(item)) return seen.get(item);
    if (item instanceof Error) return Object.freeze({ name: item.name, message: item.message });
    const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : {};
    seen.set(item, result);
    for (const [key, entry] of Object.entries(item)) {
      if (typeof entry === 'function' || entry instanceof AbortSignal) continue;
      Object.defineProperty(result, key, { value: clone(entry), enumerable: true, configurable: false, writable: false });
    }
    return Object.freeze(result);
  };
  return clone(value) as T;
}

export class PluginHost {
  private graph = new CapabilityRegistry();
  private transactions: Transaction[] = [];
  private manifestList: readonly Readonly<PluginManifest>[] = [];
  private readonly controller = new AbortController();
  private loading?: Promise<void>;
  private disposal?: Promise<void>;
  private state: 'new' | 'loading' | 'ready' | 'failed' | 'disposing' | 'disposed' = 'new';
  private readonly configSourceMap = new Map<string, Readonly<Record<string, string>>>();
  private readonly diagnosticList: PluginDiagnostic[] = [];
  private readonly options: PluginHostOptions;
  private readonly events: EventBus;

  constructor(options: PluginHostOptions = {}) {
    this.options = { ...options, config: observationSnapshot(options.config ?? AgentConfigSchema.parse({})), pluginConfig: observationSnapshot(options.pluginConfig ?? {}), pluginConfigLayers: options.pluginConfigLayers ? observationSnapshot(options.pluginConfigLayers) : undefined, selections: Object.freeze({ ...options.selections }) };
    this.events = options.events ?? new EventBus();
  }
  get diagnostics(): readonly PluginDiagnostic[] { return Object.freeze(this.diagnosticList.map((entry) => Object.freeze({ ...entry }))); }
  get manifests(): readonly Readonly<PluginManifest>[] { return this.manifestList; }
  get capabilities(): readonly CapabilityRecord[] { return this.graph.all(); }
  get frozen(): boolean { return this.graph.frozen; }
  get status(): string { return this.state; }
  configSources(pluginId: string): Readonly<Record<string, string>> { return this.configSourceMap.get(pluginId) ?? Object.freeze({}); }
  get<K extends CapabilityKind>(kind: K, id: string): CapabilityMap[K] | undefined { return this.graph.get(kind, id); }
  getRecord<K extends CapabilityKind>(kind: K, id: string): CapabilityRecord<K> | undefined { return this.graph.getRecord(kind, id); }
  list<K extends CapabilityKind>(kind: K): readonly CapabilityRecord<K>[] { return this.graph.list(kind); }
  selected<K extends SingletonCapabilityKind>(kind: K): CapabilityMap[K] | undefined { return this.graph.selected(kind, this.options.selections ?? {}); }

  /** 兼容 HookRunner 只在宿主成功后装配；失败插件没有外部写入。 */
  installHooks(runner: Pick<HookRunner, 'register'>): void {
    if (this.state !== 'ready') throw new Error('Plugins must be loaded before installing hooks');
    for (const transaction of this.transactions) for (const hook of transaction.hooks) runner.register(hook.point, hook.handler);
  }

  load(plugins: readonly Plugin[]): Promise<void> {
    if (this.state !== 'new') return Promise.reject(new Error(`PluginHost cannot load in state ${this.state}`));
    this.state = 'loading';
    this.loading = this.initialize(plugins);
    return this.loading;
  }

  private async initialize(plugins: readonly Plugin[]): Promise<void> {
    const candidate = new CapabilityRegistry();
    try {
      const snapshots = plugins.map((plugin) => ({ ...plugin, manifest: observationSnapshot(plugin.manifest), config: plugin.config ? { ...observationSnapshot(plugin.config), schema: plugin.config.schema ? { parse: plugin.config.schema.parse.bind(plugin.config.schema) } : undefined } : undefined, setup: plugin.setup?.bind(plugin) }));
      const ordered = orderPlugins(snapshots, (diagnostic) => this.diagnosticList.push(diagnostic));
      const loaded = new Map<string, Transaction>();
      for (const plugin of ordered) {
        this.controller.signal.throwIfAborted();
        const transaction: Transaction = { plugin, records: [], hooks: [], subscriptions: [], dispose: [], activate: [], open: true };
        this.transactions.push(transaction);
        const context = this.context(transaction, candidate, loaded);
        try { await plugin.setup(context); } finally { transaction.open = false; }
        candidate.commit(transaction.records);
        loaded.set(plugin.manifest.id, transaction);
      }
      candidate.validateSelections(this.options.selections ?? {});
      for (const command of candidate.list('command')) {
        for (const required of command.implementation.requiredCapabilities ?? []) {
          if (!candidate.get(required.kind, required.id)) throw new Error(`Command ${command.capabilityId} requires missing capability ${required.kind}:${required.id}`);
        }
      }
      for (const transaction of this.transactions) {
        this.controller.signal.throwIfAborted();
        for (const subscribe of transaction.subscriptions) transaction.dispose.push(subscribe());
        for (const activate of transaction.activate) {
          this.controller.signal.throwIfAborted();
          await activate(this.controller.signal);
        }
      }
      this.controller.signal.throwIfAborted();
      candidate.freeze();
      this.graph = candidate;
      this.manifestList = Object.freeze(ordered.map((plugin) => observationSnapshot(plugin.manifest)));
      this.state = 'ready';
    } catch (error) {
      this.state = 'failed';
      this.controller.abort(error);
      const errors = await this.release();
      this.diagnosticList.push({ code: 'initialization_failed', message: error instanceof Error ? error.message : String(error) });
      if (errors.length) throw new AggregateError([error, ...errors], 'Plugin initialization and cleanup failed');
      throw error;
    }
  }

  private context(transaction: Transaction, candidate: CapabilityRegistry, loaded: ReadonlyMap<string, Transaction>): PluginSetupContext {
    const { plugin } = transaction;
    const assertOpen = () => { if (!transaction.open) throw new Error(`Plugin ${plugin.manifest.id} registration is closed`); };
    const provide = Object.fromEntries(CAPABILITY_KINDS.map((kind) => [kind, (id: string, implementation: CapabilityMap[CapabilityKind], options: CapabilityOptions = {}) => {
      assertOpen();
      validateImplementation(kind, id, implementation);
      versionTuple(options.version ?? plugin.manifest.version);
      const aliases = [...(options.aliases ?? (kind === 'command' ? (implementation as CapabilityMap['command']).aliases : undefined) ?? [])];
      transaction.records.push({ kind, capabilityId: id, ownerPlugin: plugin.manifest.id, version: options.version ?? plugin.manifest.version, source: options.source ?? this.options.source ?? 'local', aliases, implementation });
    }])) as TypedCapabilityRegistrar;
    const declared = (id: string, optional: boolean): DependencyHandle | undefined => {
      const required = Object.hasOwn(plugin.manifest.requires ?? {}, id);
      const optionalDeclared = Object.hasOwn(plugin.manifest.optional ?? {}, id);
      if (!required && !optionalDeclared) throw new Error(`Plugin ${plugin.manifest.id} did not declare dependency ${id}`);
      const dependency = loaded.get(id);
      if (!dependency) { if (optional && optionalDeclared) return undefined; throw new Error(`Dependency ${id} is unavailable to ${plugin.manifest.id}`); }
      return Object.freeze({
        manifest: observationSnapshot(dependency.plugin.manifest),
        get: <K extends CapabilityKind>(kind: K, capabilityId: string): DependencyValue<K> => {
          const record = candidate.getRecord(kind, capabilityId);
          if (!record || record.ownerPlugin !== id) throw new Error(`Dependency ${id} does not provide ${kind}:${capabilityId}`);
          return dependencyValue(kind, record.implementation);
        },
        list: <K extends CapabilityKind>(kind: K) => Object.freeze(candidate.list(kind).filter((record) => record.ownerPlugin === id).map(record => Object.freeze({ ...record, implementation: dependencyValue(kind, record.implementation) }))),
      });
    };
    const defaults = plugin.config?.defaults ?? {};
    const merged = { ...defaults };
    const sources: Record<string, string> = Object.fromEntries(Object.keys(defaults).map(key => [key, 'default']));
    const layers = this.options.pluginConfigLayers
      ? (['global', 'project', 'session', 'cli'] as const).map(scope => [scope, this.options.pluginConfigLayers?.[scope]?.[plugin.manifest.id] ?? {}] as const)
      : [['provided', this.options.pluginConfig?.[plugin.manifest.id] ?? {}] as const];
    for (const [scope, configured] of layers) {
      if (scope !== 'provided' && Object.keys(configured).length && plugin.config?.scopes && !plugin.config.scopes.includes(scope)) throw new Error(`Plugin ${plugin.manifest.id} configuration is not allowed in ${scope} scope`);
      if (configured.$version !== undefined && configured.$version !== (plugin.manifest.configVersion ?? 1)) throw new Error(`Plugin ${plugin.manifest.id} config version requires explicit migration`);
      for (const [key, value] of Object.entries(configured)) {
        if (key === '$version') continue;
        merged[key] = plugin.config?.merge?.[key] === 'append' && Array.isArray(merged[key]) && Array.isArray(value) ? [...merged[key], ...value] : value;
        sources[key] = scope;
      }
    }
    for (const field of plugin.config?.sensitiveFields ?? []) { const value = merged[field]; if (value !== undefined && (typeof value !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value))) throw new Error(`Plugin ${plugin.manifest.id} sensitive config ${field} requires env:NAME reference`); }
    const parsed = plugin.config?.schema?.parse(merged) ?? merged;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))) throw new Error(`Plugin ${plugin.manifest.id} config schema must return an object`);
    this.configSourceMap.set(plugin.manifest.id, Object.freeze({ ...sources }));
    const subscribe: ReadonlyEventSubscription['on'] = (type, handler) => {
      assertOpen();
      let cancelled = false;
      let detach: Disposer | undefined;
      transaction.subscriptions.push(() => {
        if (cancelled) return () => {};
        detach = this.events.onAll((event) => {
          if (cancelled || event.type !== type) return;
          try {
            Promise.resolve(handler(observationSnapshot(event) as never)).catch((error: unknown) => this.observerError(plugin.manifest.id, error));
          } catch (error) { this.observerError(plugin.manifest.id, error); }
        });
        return () => { cancelled = true; return detach?.(); };
      });
      return () => { cancelled = true; return detach?.(); };
    };
    const events = Object.freeze({ on: subscribe });
    return Object.freeze({
      config: Object.freeze({ revision: this.options.configRevision ?? 0, core: this.options.config!, value: observationSnapshot(parsed as Record<string, unknown>), sources: Object.freeze(sources) }),
      provide: Object.freeze(provide),
      dependencies: Object.freeze({ get: (id: string) => declared(id, false)!, optional: (id: string) => declared(id, true) }),
      events,
      hooks: Object.freeze({ register: (point: HookPoint, handler: HookHandler) => { assertOpen(); transaction.hooks.push({ point, handler }); } }),
      onDispose: (disposer: Disposer) => {
        // activate 内创建的资源也可立即登记；结束后才禁止追加。
        if (this.state !== 'loading') throw new Error('Cannot register cleanup after plugin activation');
        transaction.dispose.push(disposer);
      },
      onActivate: (activate: (signal: AbortSignal) => void | Promise<void>) => { assertOpen(); transaction.activate.push(activate); },
      withResource: async <T>(resource: T, dispose: (resource: T) => void | Promise<void>, initialize?: (resource: T, signal: AbortSignal) => void | Promise<void>): Promise<T> => {
        if (this.state !== 'loading') throw new Error('Cannot allocate resource after plugin activation');
        transaction.dispose.push(() => dispose(resource));
        this.controller.signal.throwIfAborted();
        await initialize?.(resource, this.controller.signal);
        return resource;
      },
    });
  }
  private observerError(pluginId: string, error: unknown): void {
    this.diagnosticList.push({ pluginId, code: 'observer_failed', message: error instanceof Error ? error.message : String(error) });
  }
  private async release(): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const transaction of [...this.transactions].reverse()) {
      for (const dispose of transaction.dispose.splice(0).reverse()) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([Promise.resolve().then(dispose), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`Plugin cleanup timed out: ${transaction.plugin.manifest.id}`)), this.options.cleanupTimeoutMs ?? 5_000);
            })]);
          } finally { if (timer) clearTimeout(timer); }
        } catch (error) {
          errors.push(error);
          this.diagnosticList.push({ pluginId: transaction.plugin.manifest.id, code: error instanceof Error && error.message.includes('timed out') ? 'cleanup_timeout' : 'cleanup_failed', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return errors;
  }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      this.controller.abort(new Error('PluginHost disposed'));
      if (this.loading) { try { await this.loading; } catch { /* 初始化已经处理资源回滚。 */ } }
      this.state = 'disposing';
      const errors = await this.release();
      this.state = errors.length ? 'failed' : 'disposed';
      if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
    })();
  }
}

function versionTuple(version: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Invalid plugin version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function compare(a: readonly number[], b: readonly number[]): number { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; }
/** 明确支持常用稳定版本范围；不认识的范围报错，不默默放宽依赖。 */
export function satisfiesPluginVersion(version: string, range: string): boolean {
  const current = versionTuple(version);
  if (range === version) return true;
  if (version.includes('-')) return false;
  return range.split('||').some((part) => {
    const trimmed = part.trim();
    if (trimmed === '*' || trimmed.toLowerCase() === 'x') return true;
    const wildcard = /^(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(trimmed);
    if (wildcard) return Number(wildcard[1]) === current[0] && (!wildcard[2] || /[x*]/.test(wildcard[2]) || Number(wildcard[2]) === current[1]) && (!wildcard[3] || /[x*]/.test(wildcard[3]) || Number(wildcard[3]) === current[2]);
    return trimmed.split(/\s+/).every((term) => {
      const match = /^(\^|~|>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(term);
      if (!match) throw new Error(`Unsupported plugin version range: ${range}`);
      const target = versionTuple(match[2]!);
      const delta = compare(current, target);
      if (match[1] === '^') { const upper = target[0] ? [target[0] + 1, 0, 0] : target[1] ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1]; return delta >= 0 && compare(current, upper) < 0; }
      if (match[1] === '~') return delta >= 0 && compare(current, [target[0], target[1] + 1, 0]) < 0;
      if (match[1] === '>=') return delta >= 0;
      if (match[1] === '<=') return delta <= 0;
      if (match[1] === '>') return delta > 0;
      if (match[1] === '<') return delta < 0;
      return delta === 0;
    });
  });
}
function orderPlugins(plugins: readonly Plugin[], diagnostic: (diagnostic: PluginDiagnostic) => void): Plugin[] {
  const byId = new Map<string, Plugin>();
  for (const plugin of plugins) {
    const manifest = plugin?.manifest;
    if (!manifest || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.id)) throw new Error('Plugin manifest has an invalid ID');
    if (manifest.apiVersion !== 1) throw new Error(`Plugin ${manifest.id} has unsupported API version ${manifest.apiVersion}`);
    versionTuple(manifest.version);
    if (manifest.configVersion !== undefined && (!Number.isInteger(manifest.configVersion) || manifest.configVersion < 1)) throw new Error(`Plugin ${manifest.id} has invalid configVersion`);
    if (byId.has(manifest.id)) throw new Error(`Duplicate plugin ID: ${manifest.id}`);
    if (typeof plugin.setup !== 'function') throw new Error(`Plugin ${manifest.id} has no setup function`);
    byId.set(manifest.id, plugin);
  }
  const dependencies = new Map<string, string[]>();
  for (const plugin of plugins) {
    const manifest = plugin.manifest;
    const edges: string[] = [];
    for (const [id, range] of Object.entries(manifest.requires ?? {})) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error(`Plugin ${manifest.id} requires missing dependency ${id}`);
      if (!satisfiesPluginVersion(dependency.manifest.version, range)) throw new Error(`Plugin ${manifest.id} requires ${id}@${range}, found ${dependency.manifest.version}`);
      edges.push(id);
    }
    for (const [id, range] of Object.entries(manifest.optional ?? {})) {
      if (Object.hasOwn(manifest.requires ?? {}, id)) throw new Error(`Plugin ${manifest.id} declares ${id} both required and optional`);
      const dependency = byId.get(id);
      if (!dependency) { diagnostic({ pluginId: manifest.id, code: 'optional_dependency_missing', message: `Optional dependency ${id}@${range} is unavailable` }); continue; }
      if (!satisfiesPluginVersion(dependency.manifest.version, range)) throw new Error(`Plugin ${manifest.id} optional dependency ${id}@${range} is incompatible with ${dependency.manifest.version}`);
      edges.push(id);
    }
    dependencies.set(manifest.id, edges);
  }
  const result: Plugin[] = [];
  const done = new Set<string>();
  while (result.length < plugins.length) {
    const next = plugins.find((plugin) => !done.has(plugin.manifest.id) && dependencies.get(plugin.manifest.id)!.every((id) => done.has(id)));
    if (!next) throw new Error(`Plugin dependency cycle: ${plugins.filter((plugin) => !done.has(plugin.manifest.id)).map((plugin) => plugin.manifest.id).join(', ')}`);
    result.push(next); done.add(next.manifest.id);
  }
  return result;
}

/** 工具依赖只提供描述；正常插件执行必须通过 runtime.invokeTool。 */
function dependencyValue<K extends CapabilityKind>(kind: K, implementation: CapabilityMap[K]): DependencyValue<K> {
  if (kind !== 'tool') return implementation as DependencyValue<K>;
  const { execute: _execute, ...descriptor } = implementation as CapabilityMap['tool'];
  return Object.freeze(descriptor) as DependencyValue<K>;
}

function validateImplementation(kind: CapabilityKind, id: string, value: unknown): void {
  const invalid = (detail: string): never => { throw new Error(`Invalid ${kind} implementation ${id}: ${detail}`); };
  if (!value || typeof value !== 'object') invalid('expected an object');
  const object = value as Record<string, unknown>;
  const methods: Partial<Record<CapabilityKind, string[]>> = {
    provider: ['stream'], tool: ['execute'], analyzer: ['analyze'], policy: ['decide'], reviewer: ['review'],
    contextSource: ['getContext'], compactor: ['compact'], cacheStrategy: ['build'], modelCatalog: ['get', 'list'],
    sessionStore: ['path', 'load', 'save', 'list', 'delete', 'latest'], skillSource: ['list', 'get'], command: ['handler'], telemetry: ['onEvent'],
  };
  for (const method of methods[kind] ?? []) if (typeof object[method] !== 'function') invalid(`missing ${method}()`);
  for (const field of kind === 'tool' ? ['name', 'description'] : kind === 'provider' ? ['name'] : kind === 'command' ? ['description'] : kind === 'settings' ? ['title', 'applyMode'] : kind === 'tui' ? ['entry', 'kind'] : []) {
    if (typeof object[field] !== 'string' || !object[field]) invalid(`missing ${field}`);
  }
  if (kind === 'tool' && (!['read', 'write', 'execute'].includes(object.risk as string) || !object.inputSchema || typeof object.inputSchema !== 'object')) invalid('invalid risk/schema');
  if (kind === 'settings') {
    if (!object.schema || typeof object.schema !== 'object') invalid('missing schema');
    if (Boolean(object.draft) !== Boolean(object.commit)) invalid('draft and commit must be supplied together');
    if (!['immediate', 'new-session', 'restart', 'nextRequest', 'idleBoundary', 'newSession'].includes(object.applyMode as string)) invalid('unsupported applyMode');
  }
  if (kind === 'tui' && !['tool-renderer', 'status', 'editor'].includes(object.kind as string)) invalid('unsupported TUI kind');
}
