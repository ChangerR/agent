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
 *           → PermissionEngine 决策管线（allow/ask/deny）
 *           → ask 时发 permission_request 事件，挂起等待 UI 决策
 *           → 执行工具（只读工具并行）
 *           → PostToolUse 钩子
 *         tool_result 作为 user 消息回填 → 继续循环
 *
 * 用户拒绝工具调用时，反馈同样以 tool_result(isError) 回填给模型 ——
 * 模型据此调整后续行为，这是"人在回路"的标准实现方式。
 */
import type { EventBus, LoopEndReason, UserDecision } from './events.js';
import type { HookRunner } from './hooks.js';
import type { PermissionEngine } from './permission/engine.js';
import type { AutoJudge } from './permission/judge.js';
import { mergeJudgeDecision } from './permission/judge.js';
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
import type { Tool, ToolRegistry } from './registry.js';
import { estimateTokens, type ContextManager } from './context/manager.js';
import { SessionError } from './session/errors.js';
import { assertSafeHistory, trimToSafeTail } from './session/history.js';

export interface AgentLoopOptions {
  provider: Provider;
  model: string;
  tools: ToolRegistry;
  permission: PermissionEngine;
  hooks: HookRunner;
  events: EventBus;
  context: ContextManager;
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
   * auto 模式的可选 LLM 审批员：确定性管线判定 ask（来源为模式默认值）时，
   * 先让小模型判断"是否明显安全"，allow 才静默放行，其余回落询问用户。
   */
  autoJudge?: AutoJudge;
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

  constructor(private opts: AgentLoopOptions) {
    this.configuredThreshold = opts.context.threshold;
    this.configuredMaxTokens = opts.maxTokens;
    this.applyModelInfo(opts.model);
  }

  getMessages(): readonly Message[] {
    return this.messages;
  }

  get providerName(): string {
    return this.opts.provider.name;
  }

  get model(): string {
    return this.opts.model;
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
  importSession(snapshot: { messages: readonly Message[]; model?: string; thinking?: ThinkingLevel }): void {
    if (this.disposed) throw new SessionError('busy', 'AgentLoop 已释放');
    if (this.abort) throw new SessionError('busy', '当前轮次仍在运行。先按 Esc 中断，再执行 /resume。');
    assertSafeHistory(snapshot.messages);
    this.messages = structuredClone(snapshot.messages) as Message[];
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
    this.opts.context.setThreshold(info
      ? Math.min(this.configuredThreshold, Math.floor(info.contextWindow * 0.8))
      : this.configuredThreshold);
  }

  abort_current(): void {
    this.abort?.abort();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.abort_current();
    await this.idle;
  }

  async run(userInput: string): Promise<AgentRunResult> {
    if (this.disposed) throw new Error('AgentLoop is disposed');
    if (this.abort) throw new Error('AgentLoop is already running');
    const { events, hooks, provider, tools, context } = this.opts;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    let release!: () => void;
    this.idle = new Promise<void>((resolve) => { release = resolve; });
    let turns = 0;
    const totalUsage = emptyUsage();
    const stopUsage = events.on('model_usage', ({ usage }) => {
      for (const key of Object.keys(totalUsage) as Array<keyof TokenUsage>) totalUsage[key] += usage[key];
    });
    const finish = (reason: LoopEndReason, error?: string): AgentRunResult => {
      events.emit({ type: 'loop_end', reason, turns, usage: { ...totalUsage }, ...(error ? { error } : {}) });
      return { reason, turns, usage: totalUsage, ...(error ? { error } : {}) };
    };

    try {
      await hooks.notify('UserPromptSubmit', { input: userInput });
      this.messages.push({ role: 'user', content: userInput });
      await this.maybeCompact(signal);

      while (turns < this.opts.maxTurns) {
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
        const stream = observedStream(provider,
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
          { events, purpose: 'agent' },
        );
        this.lastRequestMessageCount = this.messages.length;

        // 边收事件边转发给 UI
        const forwarding = forwardEvents(stream, events);
        const { message, stopReason, usage } = await collectStreamAsync(forwarding);
        this.messages.push(message);
        events.emit({ type: 'assistant_message', message });
        events.emit({ type: 'turn_end', stopReason, usage });
        await hooks.notify('TurnEnd', { turn: turns, message: structuredClone(message), stopReason, usage: { ...usage } });

        const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0 || stopReason !== 'tool_use') {
          return finish(signal.aborted ? 'aborted' : stopReason === 'max_tokens' ? 'max_tokens' : 'completed');
        }

        // --- 执行工具，回填结果 ---
        const toolStarted = Date.now();
        const results = await this.executeTools(toolUses, signal);
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
      this.abort = null;
      stopUsage();
      release();
    }
  }

  /** 只在历史真的被替换时发 compacted，并把读断点清掉 */
  private async maybeCompact(signal: AbortSignal, emergency = false): Promise<void> {
    const { events, provider, context } = this.opts;
    if (!context.shouldCompact(this.messages)) return;
    const before = this.messages.length;
    const next = await context.compact(this.messages, provider, signal, this.opts.model, events);
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
    const { enabled, ttl, escalateAfterMs } = this.cacheSettings();
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
  private async executeTools(toolUses: ToolUseBlock[], signal: AbortSignal): Promise<ToolResultBlock[]> {
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
        const batchResults = await Promise.all(batch.map((tu) => this.runOneTool(tu, signal)));
        results.push(...batchResults);
      } else {
        results.push(await this.runOneTool(toolUses[i], signal));
        i++;
      }
    }
    return results;
  }

  private async runOneTool(toolUse: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    const { tools, permission, hooks, events, cwd } = this.opts;
    const tool: Tool | undefined = tools.get(toolUse.name);

    const fail = async (content: string): Promise<ToolResultBlock> => {
      const result: ToolResult = { content, isError: true };
      events.emit({ type: 'tool_result', toolUseId: toolUse.id, name: toolUse.name, result });
      return { type: 'tool_result', toolUseId: toolUse.id, content, isError: true };
    };

    if (signal.aborted) return fail('Tool cancelled');

    if (!tool) return fail(`Unknown tool: ${toolUse.name}`);
    let input = (toolUse.input ?? {}) as Record<string, unknown>;

    // 权限管线第 0 步：PreToolUse 钩子（可改写参数 / 否决）
    const hookResult = await hooks.runPreToolUse({ toolName: tool.name, input });
    if (hookResult.veto) return fail(`Vetoed by PreToolUse hook: ${hookResult.veto}`);
    if (hookResult.input) input = hookResult.input;
    if (signal.aborted) return fail('Tool cancelled');

    // 权限决策管线
    let decision = permission.check(tool, input);

    // auto 模式 + LLM 审批员：管线判定为 ask（模式默认值）时，让小模型兜底判断
    if (decision.kind === 'ask' && decision.source === 'mode' && this.opts.autoJudge && permission.mode === 'auto') {
      events.emit({ type: 'notice', text: `LLM 审批员审核中: ${tool.name}…` });
      const verdict = await this.opts.autoJudge.review(tool, input, signal, events);
      decision = mergeJudgeDecision(decision, verdict);
      permission.recordDecision(tool, input, decision);
      if (decision.kind === 'allow') {
        events.emit({ type: 'notice', text: decision.reason });
      }
    }

    if (decision.kind === 'deny') return fail(`Permission denied: ${decision.reason}`);

    if (decision.kind === 'ask') {
      const analysis = tool.analyzeInput?.(input);
      if (signal.aborted) return fail('Tool cancelled');
      const userDecision = await new Promise<UserDecision>((resolve) => {
        let settled = false;
        const finish = (value: UserDecision) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', cancel);
          resolve(value);
        };
        const cancel = () => finish({ allow: false, feedback: 'Tool cancelled' });
        signal.addEventListener('abort', cancel, { once: true });
        events.emit({
          type: 'permission_request',
          request: {
            toolName: tool.name,
            input,
            summary: analysis?.summary ?? tool.name,
            reason: decision.reason,
          },
          signal,
          resolve: finish,
        });
      });
      if (signal.aborted) return fail('Tool cancelled');
      if (!userDecision.allow) {
        return fail(`User denied this action.${userDecision.feedback ? ` Feedback: ${userDecision.feedback}` : ''}`);
      }
      // "始终允许" → 写回会话级规则，后续同类调用自动放行
      if (userDecision.remember) {
        const rule = ruleFor(tool, input);
        permission.addSessionRule('allow', rule);
        if (userDecision.remember === 'project') {
          events.emit({
            type: 'notice',
            text: `已加入会话规则。要持久化到项目，请把 "${rule}" 加入 agent.config.json 的 permissions.allow`,
          });
        }
      }
    }

    // 执行
    if (signal.aborted) return fail('Tool cancelled');
    events.emit({ type: 'tool_call', toolUse: { ...toolUse, input } });
    let result: ToolResult;
    try {
      result = await tool.execute(input, { cwd, signal });
    } catch (err) {
      result = { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    await hooks.notify('PostToolUse', { toolName: tool.name, input, result });
    events.emit({ type: 'tool_result', toolUseId: toolUse.id, name: tool.name, result });
    return { type: 'tool_result', toolUseId: toolUse.id, content: result.content, isError: result.isError };
  }
}

/** 为工具调用生成一条可记忆的规则，如 bash(npm test *) → 简化起见用精确命令或整工具 */
function ruleFor(tool: Tool, input: Record<string, unknown>): string {
  const target = tool.analyzeInput?.(input).patternTarget;
  // 参数模式可能过于具体，但教学上清晰：精确匹配本次调用
  return target ? `${tool.name}(${target})` : tool.name;
}

/** 把 provider 的流式事件实时转发给事件总线，同时保持可被 collectStreamAsync 消费 */
async function* forwardEvents(
  stream: AsyncIterable<import('./protocol/types.js').StreamEvent>,
  events: EventBus,
): AsyncGenerator<import('./protocol/types.js').StreamEvent> {
  for await (const ev of stream) {
    if (ev.type === 'text_delta') events.emit({ type: 'text_delta', text: ev.text });
    else if (ev.type === 'thinking_delta') events.emit({ type: 'thinking_delta', text: ev.text });
    yield ev;
  }
}
