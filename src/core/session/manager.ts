/**
 * 会话与 loop / 权限引擎之间的适配层。
 * 先校验再改内存。自动保存发生在 loop_end 回调里，此时 running 仍为 true，不能因此拒绝写入。
 */
import { resolve, parse } from 'node:path';
import { estimateTokens } from '../context/manager.js';
import type { EventBus } from '../events.js';
import type { AgentLoop, SessionSnapshot } from '../loop.js';
import type { PermissionMode } from '../config.js';
import { parseRule, type PermissionEngine, type SessionRules } from '../permission/engine.js';
import { emptyUsage, type TokenUsage } from '../protocol/types.js';
import { flushWrites } from './atomic.js';
import { SessionError } from './errors.js';
import { assertSafeHistory, makeTitle } from './history.js';
import {
  deleteSession,
  isValidSessionId,
  latestSessionId,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  sessionPath,
} from './store.js';
import {
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionListing,
  type SessionSummary,
} from './types.js';

const MODE_RANK: Record<PermissionMode, number> = { ask: 0, auto: 1, yolo: 2 };

export interface SessionManagerOptions {
  cwd: string;
  loop: AgentLoop;
  permission: PermissionEngine;
  events: EventBus;
  autoSave?: boolean;
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
  private readonly now: () => Date;
  private readonly autoSave: boolean;
  private idValue: string;
  private titleValue = '';
  private createdAtValue: string;
  private usage: TokenUsage = emptyUsage();
  private runs = 0;
  private writePath?: string;

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
    return this.opts.events.on('loop_end', (event) => {
      this.runs += 1;
      if (event.usage) this.addUsage(event.usage);
      if (!this.autoSave) return;
      const snapshot = this.opts.loop.exportSession();
      void this.write(snapshot).catch(() => {});
    });
  }

  save(): Promise<SessionSaveResult | undefined> {
    return this.write(this.opts.loop.exportSession());
  }

  async flush(): Promise<void> {
    if (!this.writePath) return;
    await flushWrites(this.writePath);
  }

  async resume(id: string, options: { allowLegacyProvider?: boolean } = {}): Promise<SessionSummary> {
    if (this.opts.loop.running) {
      throw new SessionError('busy', '当前轮次仍在运行。先按 Esc 中断，再执行 /resume。');
    }

    let resolved = id;
    if (id === 'latest') {
      const latest = await this.latest();
      if (!latest) throw new SessionError('not_found', '本项目还没有已保存的会话');
      resolved = latest;
    }

    const file = await loadSession(this.opts.cwd, resolved);
    if (canonicalCwd(file.cwd) !== canonicalCwd(this.opts.cwd)) {
      throw new SessionError(
        'cwd_mismatch',
        `这个会话属于目录 ${file.cwd}，当前目录是 ${this.opts.cwd}。会话与项目目录绑定，不能跨项目恢复。`,
        { path: sessionPath(this.opts.cwd, resolved) },
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
      for (const rule of [...rules.allow, ...rules.ask, ...rules.deny]) parseRule(rule);
    } catch (err) {
      const path = sessionPath(this.opts.cwd, resolved);
      const detail = err instanceof Error ? err.message : String(err);
      throw new SessionError('invalid_schema', `会话文件结构不合法: ${path} ${detail}`, { cause: err, path });
    }

    this.opts.loop.importSession({
      messages: file.messages,
      model: file.model,
      thinking: file.thinking,
    });
    this.opts.permission.setSessionRules(rules);
    const savedMode = file.permissionMode;
    const currentMode = this.opts.permission.mode;
    if (MODE_RANK[savedMode] <= MODE_RANK[currentMode]) {
      this.opts.permission.setMode(savedMode);
    } else {
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
    this.idValue = resolved;
    this.createdAtValue = file.createdAt;
    this.titleValue = file.title;
    this.usage = { ...file.usage };
    this.runs = file.stats.runs;
    this.writePath = sessionPath(resolve(this.opts.cwd), resolved);
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

  list(): Promise<SessionListing> {
    return listSessions(this.opts.cwd);
  }

  delete(id: string): Promise<boolean> {
    return deleteSession(this.opts.cwd, id);
  }

  latest(): Promise<string | undefined> {
    return latestSessionId(this.opts.cwd);
  }

  private write(snapshot: SessionSnapshot): Promise<SessionSaveResult | undefined> {
    if (snapshot.messages.length === 0) return Promise.resolve(undefined);
    if (!this.titleValue) this.titleValue = makeTitle(snapshot.messages);
    const updatedAt = this.now().toISOString();
    const cwd = resolve(this.opts.cwd);
    const file: SessionFile = {
      schemaVersion: SESSION_SCHEMA_VERSION,
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
      sessionRules: this.opts.permission.getSessionRules(),
      usage: { ...this.usage },
      stats: {
        messages: snapshot.messages.length,
        estimatedTokens: estimateTokens(snapshot.messages),
        runs: this.runs,
      },
      messages: snapshot.messages,
    };
    this.writePath = sessionPath(cwd, file.id);
    return saveSession(file).then(
      (path) => {
        const summary: SessionSaveResult = { ...this.toSummary(path, file.stats.messages, updatedAt), trimmed: snapshot.trimmed };
        this.opts.events.emit({ type: 'session_saved', id: file.id, path, trimmed: snapshot.trimmed });
        return summary;
      },
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.opts.events.emit({ type: 'error', error });
        throw error;
      },
    );
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
