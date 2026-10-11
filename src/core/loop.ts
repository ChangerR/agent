/**
 * Agent Loop —— 整个系统的心脏。
 *
 * 一台事件驱动的状态机，本身完全不碰 UI：
 *
 *   run(userInput)
 *     → UserPromptSubmit 钩子
 *     → 必要时压缩一次（工具轮次中间不压缩，除非体积超过阈值的 1.5 倍）
 *     → while turns < maxTurns:
 *         provider.stream(messages, tools)
 *           ├─ 流式产出 text/thinking/tool_use（转发为 UI 事件）
 *           └─ 聚合成完整 AssistantMessage
 *         若无 tool_use → turn_end，结束
 *         对每个 tool_use：
 *           PreToolUse 钩子（可改写/否决）
 *           → 选定 Policy 决策管线（allow/ask/deny）
 *           → ask 时发 permission_request 事件，挂起等待 UI 决策
 *           → 执行工具（只读工具并行）
 *           → PostToolUse 钩子
 *         tool_result 作为 user 消息回填 → 继续循环
 *
 * 用户拒绝工具调用时，反馈同样以 tool_result(isError) 回填给模型 ——
 * 模型据此调整后续行为，这是"人在回路"的标准实现方式。
 */
import { randomUUID } from 'node:crypto';
import type { EventBus, LoopEndReason } from './events.js';
import type { HookRunner } from './hooks.js';
import type { JudgeStatus } from './permission/contracts.js';
import {
  ToolExecutor,
  type ToolExecutorOptions,
  type ToolInvocationContext,
} from './tool-executor.js';
import type { ContextCoordinator, CacheStrategy } from '../sdk/runtime-capabilities.js';
import type { Policy, Reviewer, ToolAnalyzer } from '../sdk/capabilities.js';
import type { CachePolicy, CacheTtl, Provider, ThinkingLevel } from './provider.js';
import { observedStream } from './provider.js';
import { collectStreamAsync, emptyUsage } from './protocol/types.js';
import type {
  Message,
  ToolDefinition,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
  TokenUsage,
} from './protocol/types.js';
import type { ToolRegistry } from './registry.js';
import { estimateTokens } from './context/tokens.js';
import { SessionError } from './session/errors.js';
import { assertSafeHistory, trimToSafeTail } from './session/history.js';
import type { InputSource, InvocationOrigin } from './agents.js';

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  tools: ToolRegistry;
  policy: Policy;
  policyIdentity?: ToolExecutorOptions['policyIdentity'];
  reviewer?: Reviewer;
  analyzer?: ToolAnalyzer;
  configRevision?: () => string | number;
  sessionId?: () => string;
  toolIdentity?: ToolExecutorOptions['toolIdentity'];
  approvalResponder?: ToolExecutorOptions['approvalResponder'];
  reviewTimeoutMs?: number;
  capabilityTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  toolExecutor?: ToolExecutor;
  scheduler?: ToolExecutorOptions['scheduler'];
  isControlTool?: ToolExecutorOptions['isControlTool'];
  restrict?: ToolExecutorOptions['restrict'];
  agentId?: string;
  agentName?: string;
  task?: () => string;
  onCancel?: () => void;
  maxInbox?: number;
  maxOutputChars?: number;
  cacheStrategy?: CacheStrategy | null;
  hooks: HookRunner;
  events: EventBus;
  context: ContextCoordinator;
  systemPrompt: string;
  maxTurns: number;
  cwd: string;
  /** 模型的最大输出 token 数（随 setModel 联动） */
  maxTokens?: number;
  /** 思考等级（/think 可切换） */
  thinking?: ThinkingLevel;
  /**
   * 模型规格解析器：输入模型名，返回 contextWindow/maxOutputTokens。
   * setModel 时用它自动调整压缩阈值（窗口的 80%，不超过 compactThreshold 配置值）
   */
  modelInfo?: (model: string) => { contextWindow: number; maxOutputTokens: number } | undefined;
  /**
   * 提示缓存。不传时默认开启（ttl 5 分钟，不因工具耗时升级）。
   * enabled: false 时请求不带 cache 策略。
   */
  cache?: { enabled: boolean; ttl: CacheTtl; escalateAfterMs?: number };
}

/** 给会话层的内存快照。trimmed 是裁掉的尾部条数，messages 已是副本。 */
export interface SessionSnapshot {
  messages: Message[];
  model: string;
  thinking: ThinkingLevel;
  trimmed: number;
}

/** completed 表示循环正常结束；任务是否完成由外部评测器判断。 */
export interface AgentRunResult {
  reason: LoopEndReason;
  turns: number;
  usage: TokenUsage;
  error?: string;
}
export interface RunInput {
  text: string;
  source: InputSource;
  userRequest: string;
}
export interface RunOptions {
  runId?: string;
  source?: InputSource;
  userRequest?: string;
  maxTurns?: number;
  maxInbox?: number;
  maxOutputChars?: number;
}

export class UnresolvedExecutionError extends Error {
  readonly code = 'shutdown_timeout';
  constructor() {
    super(
      'Shutdown timed out with unresolved execution; resources must remain available until whenSettled() completes',
    );
    this.name = 'UnresolvedExecutionError';
  }
}

export class AgentLoop {
  private messages: Message[] = [];
  private abort: AbortController | null = null;
  /** 第一次 stream 前冻结，避免会话中途注册工具把前缀打散 */
  private toolsSnapshot: ToolDefinition[] | null = null;
  /** 上一次 stream 发出时的 messages.length，用来给上一轮末尾留读断点 */
  private lastRequestMessageCount = 0;
  /** 上一批工具（含权限等待）耗时，超过 escalateAfterMs 时把 ttl 升到 1 小时 */
  private lastToolBatchMs = 0;
  private readonly configuredThreshold: number;
  private readonly configuredMaxTokens?: number;
  private disposed = false;
  private idle: Promise<void> = Promise.resolve();
  private completionTasks = new Set<() => Promise<void>>();
  private startTasks = new Set<() => Promise<void>>();
  private readonly executor: ToolExecutor;
  private sessionId = randomUUID();
  private activeRunId = '';
  private detachedRuns = new Set<AbortController>();
  private detachedTasks = new Set<Promise<ToolResult>>();
  private detachedRunIds = new Set<string>();
  private inbox: RunInput[] = [];
  private accepting = false;
  private sessionTransition = false;
  private inboxLimit?: number;

  constructor(private opts: AgentLoopOptions) {
    this.executor =
      opts.toolExecutor ??
      new ToolExecutor({
        ...opts,
        sessionId: opts.sessionId ?? (() => this.sessionId),
        runActive: (runId) => this.activeRunId === runId || this.detachedRunIds.has(runId),
      });
    this.configuredThreshold = opts.context.threshold;
    this.configuredMaxTokens = opts.maxTokens;
    this.applyModelInfo(opts.model);
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }
  get acceptingInput(): boolean {
    return this.accepting;
  }
  get inboxSize(): number {
    return this.inbox.length;
  }
  enqueueInput(input: RunInput): boolean {
    if (!this.accepting) return false;
    if (this.inbox.length >= (this.inboxLimit ?? this.opts.maxInbox ?? 16))
      throw new Error('Agent inbox limit exceeded');
    this.inbox.push(structuredClone(input));
    return true;
  }
  /** 来源数据仅在安全边界入历史，不发起模型请求，也不产生真实用户授权。 */
  deliverData(text: string): void {
    if (this.running) {
      if (this.inbox.length >= (this.inboxLimit ?? this.opts.maxInbox ?? 16))
        throw new Error('Agent inbox limit exceeded');
      this.inbox.push({ text, source: 'subagent', userRequest: '' });
    } else {
      this.messages.push({ role: 'user', source: 'subagent', content: text });
    }
  }

  get providerName(): string {
    return this.opts.provider.name;
  }

  get model(): string {
    return this.opts.model;
  }

  getJudgeStatus(): JudgeStatus {
    return this.executor.getJudgeStatus();
  }

  /** 独立调用没有模型请求授权；只有 ToolContext.invokeTool 继承显式绑定的父上下文。 */
  async invokeTool(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (this.disposed) throw new Error('AgentLoop is disposed');
    if (this.sessionTransition) throw new SessionError('busy', '会话正在恢复。');
    const detached = new AbortController();
    this.detachedRuns.add(detached);
    const invocationSignal = signal ? AbortSignal.any([detached.signal, signal]) : detached.signal;
    const runId = randomUUID();
    this.detachedRunIds.add(runId);
    const task = this.executor.invokeTool(name, input, {
      signal: invocationSignal,
      runId,
      userRequest: '',
      messages: [],
      origin: {
        sessionId: this.opts.sessionId?.() ?? this.sessionId,
        agentId: this.opts.agentId ?? 'root',
        runId,
        source: 'tool',
        userRequest: '',
      },
    });
    this.detachedTasks.add(task);
    try {
      return await task;
    } finally {
      detached.abort();
      this.executor.finishRun(runId);
      this.detachedRunIds.delete(runId);
      this.detachedRuns.delete(detached);
      this.detachedTasks.delete(task);
    }
  }

  setModel(model: string): void {
    this.opts.model = model;
    this.applyModelInfo(model);
  }

  get thinking(): ThinkingLevel {
    return this.opts.thinking ?? 'off';
  }

  setThinking(level: ThinkingLevel): void {
    this.opts.thinking = level;
  }

  /** 当前有没有还没结束的 run。loop_end 发出时 abort 尚未清空，这里仍为 true。 */
  get running(): boolean {
    return this.abort !== null;
  }

  get hasPendingActivity(): boolean {
    return (
      this.abort !== null ||
      this.detachedTasks.size > 0 ||
      this.executor.hasPendingActivity ||
      this.opts.events.hasPendingActivity
    );
  }

  /** 等待原始执行结算；不会执行重试、伪造结果或释放仍被使用的资源。 */
  async whenSettled(): Promise<void> {
    while (this.hasPendingActivity)
      await Promise.allSettled([
        this.idle,
        ...this.detachedTasks,
        this.executor.whenSettled(),
        this.opts.events.whenSettled(),
      ]);
  }

  /** 裁掉不安全的尾部再克隆。不改 this.messages，也不发事件。 */
  exportSession(): SessionSnapshot {
    const trimmed = trimToSafeTail(this.messages);
    return {
      messages: structuredClone(trimmed.messages),
      model: this.model,
      thinking: this.thinking,
      trimmed: trimmed.dropped,
    };
  }

  /**
   * 用一份已校验的历史替换内存状态，准备下一轮重新快照工具。
   * 不发事件、不重放工具、不调用 provider。
   */
  importSession(snapshot: {
    messages: readonly Message[];
    model?: string;
    thinking?: ThinkingLevel;
  }): void {
    if (this.disposed) throw new SessionError('busy', 'AgentLoop 已释放');
    if (this.hasPendingActivity)
      throw new SessionError('busy', '当前轮次仍在运行。先按 Esc 中断，再执行 /resume。');
    assertSafeHistory(snapshot.messages);
    this.messages = structuredClone(snapshot.messages) as Message[];
    this.executor.clear();
    this.sessionId = randomUUID();
    this.toolsSnapshot = null;
    this.lastRequestMessageCount = 0;
    this.lastToolBatchMs = 0;
    if (snapshot.model !== undefined) this.setModel(snapshot.model);
    if (snapshot.thinking !== undefined) this.setThinking(snapshot.thinking);
  }

  /** 按模型规格联动 maxTokens 与压缩阈值 */
  private applyModelInfo(model: string): void {
    const info = this.opts.modelInfo?.(model);
    this.opts.maxTokens = info?.maxOutputTokens ?? this.configuredMaxTokens;
    this.opts.context.setThreshold(
      info
        ? Math.min(this.configuredThreshold, Math.floor(info.contextWindow * 0.8))
        : this.configuredThreshold,
    );
  }

  abort_current(): void {
    this.abort?.abort();
    for (const controller of this.detachedRuns) controller.abort();
    this.opts.onCancel?.();
  }

  /** 轮次完成前等待持久化等任务；失败传给 run 调用方，仍保证释放运行状态。 */
  onRunSettled(task: () => Promise<void>): () => void {
    this.completionTasks.add(task);
    return () => {
      this.completionTasks.delete(task);
    };
  }
  onRunStarted(task: () => Promise<void>): () => void {
    this.startTasks.add(task);
    return () => {
      this.startTasks.delete(task);
    };
  }
  /** 恢复从读文件到提交期间不能启动另一轮或独立工具调用。 */
  beginSessionTransition(): () => void {
    if (this.disposed || this.running || this.sessionTransition)
      throw new SessionError('busy', '会话正在运行、恢复或释放。');
    this.sessionTransition = true;
    return () => {
      this.sessionTransition = false;
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort_current();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.whenSettled(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new UnresolvedExecutionError()),
            this.opts.shutdownTimeoutMs ?? 30_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.executor.clear();
    this.sessionId = randomUUID();
  }

  async run(userInput: string, options: RunOptions = {}): Promise<AgentRunResult> {
    if (this.disposed) throw new Error('AgentLoop is disposed');
    if (this.sessionTransition) throw new SessionError('busy', '会话正在恢复。');
    if (this.abort) throw new Error('AgentLoop is already running');
    const { events, hooks, provider, tools, context } = this.opts;
    this.abort = new AbortController();
    const runId = (this.activeRunId = options.runId ?? randomUUID());
    this.accepting = true;
    this.inboxLimit = options.maxInbox;
    let origin: InvocationOrigin = {
      sessionId: this.opts.sessionId?.() ?? this.sessionId,
      agentId: this.opts.agentId ?? 'root',
      runId,
      source: options.source ?? 'user',
      userRequest:
        options.source && options.source !== 'user' ? (options.userRequest ?? '') : userInput,
    };
    const signal = this.abort.signal;
    let release!: () => void;
    this.idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turns = 0;
    const totalUsage = emptyUsage();
    const seenUsage = new Set<string>();
    const stopUsage = events.on('model_usage', ({ usage, requestId, runId: usageRunId }) => {
      if (usageRunId !== runId) return;
      if (seenUsage.has(requestId)) return;
      seenUsage.add(requestId);
      for (const key of Object.keys(totalUsage) as Array<keyof TokenUsage>)
        totalUsage[key] += usage[key];
    });
    const finish = (reason: LoopEndReason, error?: string): AgentRunResult => {
      this.accepting = false;
      events.emit({
        type: 'loop_end',
        reason,
        turns,
        usage: { ...totalUsage },
        ...(error ? { error } : {}),
      });
      return { reason, turns, usage: totalUsage, ...(error ? { error } : {}) };
    };

    let outputCharacters = 0;
    try {
      await this.notify('UserPromptSubmit', { input: userInput }, signal);
      this.messages = trimToSafeTail(this.messages).messages;
      this.messages.push({
        role: 'user',
        content: userInput,
        ...(origin.source !== 'user' ? { source: origin.source } : {}),
      });
      await Promise.all([...this.startTasks].map((task) => task()));
      await this.maybeCompact(signal);

      while (turns < Math.min(options.maxTurns ?? this.opts.maxTurns, this.opts.maxTurns)) {
        for (const input of this.inbox.splice(0)) {
          this.messages.push({
            role: 'user',
            content: input.text,
            ...(input.source !== 'user' ? { source: input.source } : {}),
          });
          if (input.source !== 'subagent')
            origin = { ...origin, source: input.source, userRequest: input.userRequest };
        }
        turns++;
        if (signal.aborted) {
          return finish('aborted');
        }

        // 工具轮次中间只在快撑破窗口时才压缩，并接受这次缓存失效
        if (estimateTokens(this.messages) > context.threshold * 1.5) {
          await this.maybeCompact(signal, true);
        }

        // --- 调用模型，流式产出 ---
        this.toolsSnapshot ??= structuredClone(tools.definitions());
        const stream = observedStream(
          provider,
          {
            model: this.opts.model,
            system: this.opts.systemPrompt,
            messages: structuredClone(this.messages),
            tools: structuredClone(this.toolsSnapshot),
            maxTokens: this.opts.maxTokens,
            thinking: this.opts.thinking,
            cache: this.buildCachePolicy(),
          },
          signal,
          { events, purpose: 'agent', runId },
        );
        this.lastRequestMessageCount = this.messages.length;

        // 边收事件边转发给 UI
        const forwarding = forwardEvents(
          stream,
          events,
          (options.maxOutputChars ?? this.opts.maxOutputChars ?? Number.POSITIVE_INFINITY) -
            outputCharacters,
          () => {
            events.emit({ type: 'notice', text: 'output_limit: 子任务输出达到限制，保留部分结果' });
            this.abort?.abort();
          },
          (count) => {
            outputCharacters += count;
          },
        );
        const { message, stopReason, usage } = await collectStreamAsync(forwarding);
        this.messages.push(message);
        events.emit({ type: 'assistant_message', message });
        events.emit({ type: 'turn_end', stopReason, usage });
        await this.notify(
          'TurnEnd',
          { turn: turns, message: structuredClone(message), stopReason, usage: { ...usage } },
          signal,
        );

        const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0 || stopReason !== 'tool_use') {
          if (!signal.aborted && this.inbox.length && stopReason !== 'max_tokens') continue;
          return finish(
            signal.aborted ? 'aborted' : stopReason === 'max_tokens' ? 'max_tokens' : 'completed',
          );
        }

        // --- 执行工具，回填结果 ---
        const toolStarted = Date.now();
        const results = await this.executeTools(toolUses, {
          signal,
          runId,
          userRequest: origin.userRequest,
          origin,
          messages: structuredClone(this.messages),
        });
        this.lastToolBatchMs = Date.now() - toolStarted;
        this.messages.push({ role: 'user', content: results });
        signal.throwIfAborted();
      }
      return finish('max_turns');
    } catch (err) {
      if (signal.aborted) {
        return finish('aborted');
      } else {
        events.emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        return finish('error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.accepting = false;
      if (!findUnsafeTail(this.messages)) {
        for (const input of this.inbox.splice(0))
          this.messages.push({
            role: 'user',
            source: input.source === 'user' ? undefined : input.source,
            content: input.text,
          });
      }
      try {
        const settled = await Promise.allSettled([...this.completionTasks].map((task) => task()));
        const errors = settled
          .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
          .map((item) => item.reason);
        if (errors.length) throw new AggregateError(errors, '轮次完成后的保存失败');
      } finally {
        this.abort?.abort();
        this.abort = null;
        this.executor.finishRun(this.activeRunId);
        this.activeRunId = '';
        this.inboxLimit = undefined;
        if (events.hasPendingActivity) void events.whenSettled().then(stopUsage);
        else stopUsage();
        release();
      }
    }
  }

  private async notify(
    point: 'UserPromptSubmit' | 'TurnEnd',
    payload: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.opts.events.bounded(
        (s) => this.opts.hooks.notify(point, payload, s),
        signal,
        this.opts.capabilityTimeoutMs ?? 30_000,
      );
    } catch {
      signal.throwIfAborted();
      this.opts.events.emit({
        type: 'notice',
        text: `${point} observer failed or timed out; continuing with the original state`,
      });
    }
  }

  /** 只在历史真的被替换时发 compacted，并把读断点清掉 */
  private async maybeCompact(signal: AbortSignal, emergency = false): Promise<void> {
    const { events, provider, context } = this.opts;
    if (!context.shouldCompact(this.messages)) return;
    const before = this.messages.length;
    const next = await context.compact(
      this.messages,
      provider,
      signal,
      this.opts.model,
      events,
      this.activeRunId,
    );
    if (next === this.messages) return;
    if (emergency) {
      events.emit({
        type: 'notice',
        text: '上下文超限，工具轮中间紧急压缩（本次缓存会失效）',
      });
    }
    this.messages = next;
    this.lastRequestMessageCount = 0;
    events.emit({ type: 'compacted', beforeMessages: before, afterMessages: this.messages.length });
  }

  private cacheSettings(): { enabled: boolean; ttl: CacheTtl; escalateAfterMs: number } {
    return {
      enabled: this.opts.cache?.enabled ?? true,
      ttl: this.opts.cache?.ttl ?? '5m',
      escalateAfterMs: this.opts.cache?.escalateAfterMs ?? 0,
    };
  }

  /** 工具和系统提示各一个稳定断点；消息上保留上一轮末尾（读）和本轮末尾（写） */
  private buildCachePolicy(): CachePolicy | undefined {
    if (this.opts.cacheStrategy === null) return undefined;
    const { enabled, ttl, escalateAfterMs } = this.cacheSettings();
    if (this.opts.cacheStrategy)
      return this.opts.cacheStrategy.build({
        messageCount: this.messages.length,
        previousMessageCount: this.lastRequestMessageCount,
        lastToolBatchMs: this.lastToolBatchMs,
        hasSystem: this.opts.systemPrompt.length > 0,
        hasTools: (this.toolsSnapshot?.length ?? 0) > 0,
        settings: { enabled, ttl, escalateAfterMs },
      });
    if (!enabled) return undefined;
    const last = this.messages.length - 1;
    const prev = this.lastRequestMessageCount - 1;
    const messageBreakpoints = [...new Set([prev, last])]
      .filter((i) => i >= 0 && i <= last)
      .sort((a, b) => a - b);
    const effectiveTtl: CacheTtl =
      escalateAfterMs > 0 && this.lastToolBatchMs > escalateAfterMs ? '1h' : ttl;
    return {
      system: this.opts.systemPrompt.length > 0,
      tools: (this.toolsSnapshot?.length ?? 0) > 0,
      messageBreakpoints,
      ttl: effectiveTtl,
    };
  }

  /** 执行一轮中的所有 tool_use：连续的只读工具并行，写/执行类串行 */
  private async executeTools(
    toolUses: ToolUseBlock[],
    context: ToolInvocationContext,
  ): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let i = 0;
    while (i < toolUses.length) {
      const t = this.opts.tools.get(toolUses[i].name);
      if (t?.isConcurrencySafe) {
        // 收集连续的可并行工具
        const batch: ToolUseBlock[] = [];
        while (i < toolUses.length && this.opts.tools.get(toolUses[i].name)?.isConcurrencySafe) {
          batch.push(toolUses[i]);
          i++;
        }
        const batchResults = await Promise.all(
          batch.map((tu) => this.executor.execute(tu, context)),
        );
        results.push(...batchResults);
      } else {
        results.push(await this.executor.execute(toolUses[i], context));
        i++;
      }
    }
    return results;
  }
}

/** 把 provider 的流式事件实时转发给事件总线，同时保持可被 collectStreamAsync 消费 */
async function* forwardEvents(
  stream: AsyncIterable<import('./protocol/types.js').StreamEvent>,
  events: EventBus,
  maxChars = Number.POSITIVE_INFINITY,
  cancel?: () => void,
  count?: (characters: number) => void,
): AsyncGenerator<import('./protocol/types.js').StreamEvent> {
  let characters = 0;
  for await (const ev of stream) {
    const structural =
      ev.type === 'tool_use_delta'
        ? ev.input
        : ev.type === 'signature_delta'
          ? ev.signature
          : ev.type === 'redacted_thinking'
            ? ev.data
            : undefined;
    if (structural !== undefined) {
      characters += structural.length;
      count?.(structural.length);
      if (characters > maxChars) {
        cancel?.();
        throw new Error('Agent output limit reached');
      }
    }
    if (ev.type === 'text_delta' || ev.type === 'thinking_delta') {
      const remaining = Math.max(0, maxChars - characters);
      characters += ev.text.length;
      if (characters > maxChars) cancel?.();
      const text = ev.text.slice(0, remaining);
      count?.(text.length);
      if (text) {
        events.emit({ type: ev.type, text });
        yield { ...ev, text };
      }
      continue;
    }
    yield ev;
  }
}

function findUnsafeTail(messages: readonly Message[]): boolean {
  return trimToSafeTail(messages).dropped > 0;
}
