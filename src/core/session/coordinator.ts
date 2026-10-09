/**
 * 会话与 loop / 权限引擎之间的适配层。
 * 先校验再改内存。自动保存发生在 loop_end 回调里，此时 running 仍为 true，不能因此拒绝写入。
 */
import { bounded, CapabilityTimeout } from '../permission/async.js';
import { resolve, parse } from 'node:path';
import { estimateTokens } from '../context/tokens.js';
import type { EventBus } from '../events.js';
import type { AgentLoop, SessionSnapshot } from '../loop.js';
import type { PermissionMode } from '../config.js';
import type { PermissionController } from '../../sdk/capabilities.js';
import type { SessionRules } from '../permission/contracts.js';
import { emptyUsage, type TokenUsage } from '../protocol/types.js';
import { SessionError } from './errors.js';
import { assertSafeHistory, makeTitle } from './history.js';
import { isValidSessionId, newSessionId } from './identity.js';
import type { SessionStore } from '../../sdk/runtime-capabilities.js';
import { assertCompatibleEnvelope, copyPluginStates, validateSessionSnapshot, type SessionRestoreRequirements } from './envelope.js';
import {
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionListing,
  type SessionSummary,
} from './types.js';

const MODE_RANK: Record<PermissionMode, number> = { ask: 0, auto: 1, yolo: 2 };

export interface SessionManagerOptions {
  store: SessionStore;
  restoreRequirements: SessionRestoreRequirements;
  cwd: string;
  loop: AgentLoop;
  permission: PermissionController;
  validateSessionRules?: (rules: SessionRules) => void;
  events: EventBus;
  autoSave?: boolean;
  /** 后端不响应时停止等待，保留未决操作，不重试可能已提交的写入。 */
  persistenceTimeoutMs?: number;
  /** 当前 provider endpoint 的非敏感指纹，由装配层提供。 */
  endpointKey?: string;
  now?: () => Date;
  makeId?: () => string;
}

/** save() 在摘要上多带本次裁掉的条数，供 /save 拼文案。 */
export interface SessionSaveResult extends SessionSummary {
  trimmed: number;
}

export class SessionManager {
  private pluginStates: NonNullable<SessionFile['pluginStates']> = {};
  private readonly now: () => Date;
  private readonly autoSave: boolean;
  private idValue: string;
  private titleValue = '';
  private createdAtValue: string;
  private usage: TokenUsage = emptyUsage();
  private runs = 0;
  private writePath?: string;
  private revisions = new Map<string, number>();
  private tails = new Map<string, Promise<unknown>>();
  private recreate = new Map<string, number>();
  private pending = new Set<Promise<unknown>>();
  private failures = new Map<string, unknown>();

  constructor(private readonly opts: SessionManagerOptions) {
    const now = (opts.now ?? (() => new Date()))();
    this.now = opts.now ?? (() => new Date());
    this.autoSave = opts.autoSave ?? true;
    this.idValue = opts.makeId?.() ?? newSessionId(now);
    if (!isValidSessionId(this.idValue)) {
      throw new SessionError('invalid_id', `会话 id 不合法: "${this.idValue}"。只允许字母、数字、- 和 _，长度 1~64。`);
    }
    this.createdAtValue = now.toISOString();
  }

  get hasPendingPersistence(): boolean { return this.pending.size > 0; }

  get id(): string {
    return this.idValue;
  }

  get title(): string {
    return this.titleValue;
  }

  get createdAt(): string {
    return this.createdAtValue;
  }

  /** 订阅 loop_end。返回取消订阅。 */
  attach(): () => void {
    const detachEvent = this.opts.events.on('loop_end', (event) => {
      this.runs += 1;
      if (event.usage) this.addUsage(event.usage);
    });
    const detachCompletion = this.opts.loop.onRunSettled(async () => {
      if (this.autoSave) await this.save();
    });
    return () => { detachEvent(); detachCompletion(); };
  }

  save(signal?: AbortSignal): Promise<SessionSaveResult | undefined> {
    try {
      const operationSignal = this.operationSignal(signal);
      operationSignal.throwIfAborted();
      return this.write(this.opts.loop.exportSession(), operationSignal);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.failures.set(this.idValue, error);
      this.opts.events.emit({ type: 'error', error });
      return Promise.reject(error);
    }
  }

  /** 仅等待已经启动的后台持久化；不重试、不清除故障、不开始新写入。 */
  async whenPersistenceSettled(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** 等待本管理器所有会话的保存（包括已切换的旧会话），错误不能被吞掉。 */
  async flush(signal?: AbortSignal): Promise<void> {
    while (this.pending.size) {
      const waiting = Promise.allSettled([...this.pending]);
      if (signal) await bounded(() => waiting, signal, this.opts.persistenceTimeoutMs ?? 30_000);
      else await waiting;
    }
    if (this.failures.size) {
      const errors = [...this.failures.values()];
      this.failures.clear();
      throw new AggregateError(errors, '会话保存失败');
    }
  }

  /** 退出时先观察排队错误，再保存最终设置，即使没有新的对话轮次。 */
  async finalize(signal?: AbortSignal): Promise<void> {
    const own = this.operationSignal(signal);
    const errors: unknown[] = [];
    try {
      await bounded(async (child) => {
        try { await this.flush(child); } catch (error) {
          if (this.hasPendingPersistence) throw error;
          errors.push(error);
        }
        if (this.autoSave) {
          try { await this.save(child); } catch (error) { errors.push(error); }
        }
        try { await this.flush(child); } catch (error) { errors.push(error); }
      }, own, this.opts.persistenceTimeoutMs ?? 30_000);
    } catch (error) { errors.push(error); }
    if (this.hasPendingPersistence) {
      const unresolved = new SessionError('io', '持久化结果尚未确认，后台操作可能仍会提交；未释放存储插件，也未重试保存。');
      this.failures.set(this.idValue, unresolved);
      errors.push(unresolved);
    }
    if (errors.length) throw new AggregateError(errors, '退出时会话保存失败');
  }

  async resume(id: string, options: { allowLegacyProvider?: boolean; signal?: AbortSignal } = {}): Promise<SessionSummary> {
    options.signal?.throwIfAborted();
    if (this.opts.loop.running) {
      throw new SessionError('busy', '当前轮次仍在运行。先按 Esc 中断，再执行 /resume。');
    }

    let resolved = id;
    if (id === 'latest') {
      const latest = await this.latest(options.signal);
      if (!latest) throw new SessionError('not_found', '本项目还没有已保存的会话');
      resolved = latest;
    }

    if (!isValidSessionId(resolved)) throw new SessionError('invalid_id', `会话 id 不合法: ${resolved}`);
    await this.readBoundary(async () => { await this.tails.get(resolved)?.catch(() => undefined); }, options.signal);
    const file = validateSessionSnapshot(await this.readBoundary((child) => this.opts.store.load(this.opts.cwd, resolved, child), options.signal));
    assertCompatibleEnvelope(file, this.opts.restoreRequirements);
    if (canonicalCwd(file.cwd) !== canonicalCwd(this.opts.cwd)) {
      throw new SessionError(
        'cwd_mismatch',
        `这个会话属于目录 ${file.cwd}，当前目录是 ${this.opts.cwd}。会话与项目目录绑定，不能跨项目恢复。`,
        { path: this.opts.store.path(this.opts.cwd, resolved) },
      );
    }
    const provider = this.opts.loop.providerName;
    const endpointKey = this.opts.endpointKey ?? 'default';
    if (!file.provider || !file.endpointKey) {
      if (!options.allowLegacyProvider) {
        throw new SessionError('provider_mismatch', '旧会话缺少 provider / endpoint 身份，不能自动确认兼容性。确认当前配置后使用 /resume <id> --legacy 或 --allow-legacy-session 显式迁移。');
      }
      this.opts.events.emit({ type: 'notice', text: '按显式选择将旧会话迁移到当前 provider / endpoint；请先确认模型与历史兼容。下次保存会记录当前身份。' });
    } else if (file.provider !== provider || file.endpointKey !== endpointKey) {
      throw new SessionError('provider_mismatch', '保存的 provider / endpoint 与当前配置不同。请切换回原配置后恢复；未修改当前会话。');
    }
    assertSafeHistory(file.messages);
    const rules = normalizeRules(file.sessionRules);
    try {
      if (this.opts.validateSessionRules) this.opts.validateSessionRules(rules);
      else this.opts.permission.validateSessionRules?.(rules);
    } catch (err) {
      const path = this.opts.store.path(this.opts.cwd, resolved);
      const detail = err instanceof Error ? err.message : String(err);
      throw new SessionError('invalid_schema', `会话文件结构不合法: ${path} ${detail}`, { cause: err, path });
    }

    const savedMode = file.permissionMode;
    const currentMode = this.opts.permission.mode;
    const restoreMode = MODE_RANK[savedMode] < MODE_RANK[currentMode];
    if (restoreMode) this.opts.permission.validateMode?.(savedMode);
    if (this.opts.loop.running) throw new SessionError('busy', '恢复会话期间启动了新轮次，未修改当前会话。');
    options.signal?.throwIfAborted();
    const previous = this.opts.loop.exportSession();
    const previousRules = structuredClone(this.opts.permission.getSessionRules());
    let loopAttempted = false;
    try {
      // 控制器也是插件边界：先恢复控制器，再提交已验证历史；失败恢复原快照。
      this.opts.permission.setSessionRules(rules);
      if (restoreMode) this.opts.permission.setMode(savedMode);
      loopAttempted = true;
      this.opts.loop.importSession({ messages: file.messages, model: file.model, thinking: file.thinking });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try { this.opts.permission.setSessionRules(previousRules); } catch (rollback) { rollbackErrors.push(rollback); }
      if (this.opts.permission.mode !== currentMode) {
        try { this.opts.permission.setMode(currentMode); } catch (rollback) { rollbackErrors.push(rollback); }
      }
      if (loopAttempted) {
        try { this.opts.loop.importSession(previous); } catch (rollback) { rollbackErrors.push(rollback); }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], '会话恢复失败，部分插件状态无法回滚；请关闭本会话后重新启动。');
      throw error;
    }
    if (MODE_RANK[savedMode] > MODE_RANK[currentMode]) {
      this.opts.events.emit({
        type: 'notice',
        text: `已保存的权限模式是 ${savedMode}，比当前的 ${currentMode} 更宽，已保持当前模式 ${currentMode}。`,
      });
    }
    if (file.id !== resolved) {
      this.opts.events.emit({
        type: 'notice',
        text: `会话文件记录的 id 是 ${file.id}，与文件名 ${resolved} 不一致，已按文件名接管。`,
      });
    }
    this.pluginStates = copyPluginStates(file.pluginStates);
    this.revisions.set(resolved, file.revision ?? 0);
    this.recreate.delete(resolved);
    this.idValue = resolved;
    this.createdAtValue = file.createdAt;
    this.titleValue = file.title;
    this.usage = { ...file.usage };
    this.runs = file.stats.runs;
    this.writePath = this.opts.store.path(resolve(this.opts.cwd), resolved);
    const summary = this.toSummary(this.writePath, file.messages.length, file.updatedAt);
    this.opts.events.emit({
      type: 'session_restored',
      id: resolved,
      title: file.title,
      model: this.opts.loop.model,
      thinking: this.opts.loop.thinking,
      usage: { ...this.usage },
      messages: this.opts.loop.getMessages(),
    });
    return summary;
  }

  list(signal?: AbortSignal): Promise<SessionListing> {
    return this.readBoundary((child) => this.opts.store.list(this.opts.cwd, child), signal);
  }

  delete(id: string, signal?: AbortSignal): Promise<boolean> {
    if (!isValidSessionId(id)) return Promise.reject(new SessionError('invalid_id', `会话 id 不合法: ${id}`));
    const operationSignal = this.operationSignal(signal);
    const previous = this.tails.get(id) ?? Promise.resolve();
    const deleting = previous.catch(() => undefined).then(() => { operationSignal.throwIfAborted(); return this.opts.store.delete(this.opts.cwd, id, operationSignal); }).then(({ deleted, revision }) => {
      if (typeof deleted !== 'boolean' || !Number.isSafeInteger(revision) || revision < (deleted ? 1 : 0)) throw new SessionError('invalid_schema', '会话存储返回了无效的删除结果');
      if (deleted) this.recreate.set(id, revision);
      this.failures.delete(id);
      return deleted;
    }).catch((error) => { this.failures.set(id, error); throw error; });
    this.track(id, deleting);
    return this.waitPersistence(id, deleting, operationSignal);
  }

  latest(signal?: AbortSignal): Promise<string | undefined> {
    return this.readBoundary((child) => this.opts.store.latest(this.opts.cwd, child), signal);
  }

  private write(snapshot: SessionSnapshot, signal: AbortSignal): Promise<SessionSaveResult | undefined> {
    if (snapshot.messages.length === 0) return Promise.resolve(undefined);
    if (!this.titleValue) this.titleValue = makeTitle(snapshot.messages);
    const updatedAt = this.now().toISOString();
    const cwd = resolve(this.opts.cwd);
    const file: SessionFile = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      runtime: { schemaVersion: 1 },
      policy: { ...this.opts.restoreRequirements.policy },
      pluginStates: copyPluginStates(this.pluginStates),
      id: this.idValue,
      title: this.titleValue,
      createdAt: this.createdAtValue,
      updatedAt,
      cwd,
      model: snapshot.model,
      provider: this.opts.loop.providerName,
      endpointKey: this.opts.endpointKey ?? 'default',
      thinking: snapshot.thinking,
      permissionMode: this.opts.permission.mode,
      sessionRules: structuredClone(this.opts.permission.getSessionRules()),
      usage: { ...this.usage },
      stats: {
        messages: snapshot.messages.length,
        estimatedTokens: estimateTokens(snapshot.messages),
        runs: this.runs,
      },
      messages: snapshot.messages,
    };
    this.writePath = this.opts.store.path(cwd, file.id);
    // 捕获调用时是否已明确删除成功；删除前排队的旧保存不能获得重建权。
    const recreateRevision = this.recreate.get(file.id);
    const previous = this.tails.get(file.id) ?? Promise.resolve();
    const saving = previous.catch(() => undefined).then(() => {
      signal.throwIfAborted();
      file.revision = this.revisions.get(file.id) ?? 0;
      return this.opts.store.save(structuredClone(file), { recreate: recreateRevision !== undefined, recreateRevision }, signal);
    }).then((commit) => {
      if (!commit || typeof commit.path !== 'string' || !commit.path || !Number.isSafeInteger(commit.revision) || commit.revision <= (file.revision ?? 0)) throw new SessionError('invalid_schema', '会话存储返回了无效的提交版本');
      return commit;
    });
    const pending = saving.then(
      ({ path, revision }) => {
        this.revisions.set(file.id, revision);
        this.recreate.delete(file.id);
        this.failures.delete(file.id);
        // 返回摘要只读取本次写入的快照；await 期间可能已经恢复了另一会话。
        const summary: SessionSaveResult = {
          id: file.id, title: file.title, createdAt: file.createdAt, updatedAt,
          model: file.model, messageCount: file.stats.messages, path, trimmed: snapshot.trimmed,
        };
        this.opts.events.emit({ type: 'session_saved', id: file.id, path, trimmed: snapshot.trimmed });
        return summary;
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.failures.set(file.id, error);
        this.opts.events.emit({ type: 'error', error });
        throw error;
      },
    );
    this.track(file.id, pending);
    return this.waitPersistence(file.id, pending, signal);
  }

  private operationSignal(parent?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.opts.persistenceTimeoutMs ?? 30_000);
    return parent ? AbortSignal.any([parent, timeout]) : timeout;
  }
  private readBoundary<T>(handler: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return bounded(handler, signal ?? new AbortController().signal, this.opts.persistenceTimeoutMs ?? 30_000);
  }
  private async waitPersistence<T>(id: string, operation: Promise<T>, signal: AbortSignal): Promise<T> {
    try { return await bounded(() => operation, signal, this.opts.persistenceTimeoutMs ?? 30_000); }
    catch (error) {
      if (!this.pending.has(operation)) return await operation;
      if (!signal.aborted && !(error instanceof CapabilityTimeout)) throw error;
      const unknown = new SessionError('io', '已停止等待持久化；结果尚未确认，后台操作可能仍会提交。不能假定已撤销，也不会自动重试。', { cause: error });
      this.failures.set(id, unknown);
      throw unknown;
    }
  }

  private track(id: string, pending: Promise<unknown>): void {
    this.tails.set(id, pending);
    this.pending.add(pending);
    void pending.finally(() => {
      this.pending.delete(pending);
      if (this.tails.get(id) === pending) this.tails.delete(id);
    }).catch(() => undefined);
  }

  private addUsage(usage: TokenUsage): void {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.cacheReadTokens += usage.cacheReadTokens;
    this.usage.cacheWriteTokens += usage.cacheWriteTokens;
  }

  private toSummary(path: string, messageCount: number, updatedAt: string): SessionSummary {
    return {
      id: this.idValue,
      title: this.titleValue,
      createdAt: this.createdAtValue,
      updatedAt,
      model: this.opts.loop.model,
      messageCount,
      path,
    };
  }
}

function normalizeRules(rules: Partial<SessionRules> | undefined): SessionRules {
  return {
    allow: rules?.allow ?? [],
    ask: rules?.ask ?? [],
    deny: rules?.deny ?? [],
  };
}

/** resolve 后去掉结尾分隔符（根目录除外）；Windows 再忽略大小写。不做 realpath。 */
function canonicalCwd(cwd: string): string {
  const resolved = resolve(cwd);
  const root = parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}
