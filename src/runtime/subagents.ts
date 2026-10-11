/** 根 runtime 拥有一个 supervisor；child 只复用能力，不拥有或关闭插件/MCP 实例。 */
import { randomUUID } from 'node:crypto';
import { bounded } from '../core/permission/async.js';
import { emptyUsage, type TokenUsage } from '../core/protocol/types.js';
import type { AgentEvent, EventBus } from '../core/events.js';
import type {
  InvocationOrigin,
  SubagentRecord,
  SubagentRun,
  SubagentStatus,
} from '../core/agents.js';
import type { AgentLoop, RunInput } from '../core/loop.js';
import { newSessionId, isValidSessionId } from '../core/session/identity.js';
import type { SessionManager } from '../core/session/coordinator.js';
import type { SessionFile } from '../core/session/types.js';

export interface SubagentLimits {
  maxRunning: number;
  maxDepth: number;
  maxTurns: number;
  timeoutMs: number;
  maxInbox: number;
  maxOutputChars: number;
  previewChars: number;
  maxAgents: number;
  maxRuns: number;
}
export const DEFAULT_SUBAGENT_LIMITS: Readonly<SubagentLimits> = Object.freeze({
  maxRunning: 4,
  maxDepth: 1,
  maxTurns: 16,
  timeoutMs: 300_000,
  maxInbox: 16,
  maxOutputChars: 131_072,
  previewChars: 8_192,
  maxAgents: 32,
  maxRuns: 32,
});
export interface SpawnAgentInput {
  task: string;
  planStepId?: string;
  name?: string;
  context?: 'fresh' | 'snapshot';
  readOnly?: boolean;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number;
}
export interface AgentAddress {
  agentId: string;
  runId: string;
}
export interface ChildRuntime {
  loop: AgentLoop;
  events: EventBus;
  session: SessionManager;
  detach(): void;
}
export interface SupervisorOptions {
  rootLoop: AgentLoop;
  rootSession: SessionManager;
  events: EventBus;
  createChild(record: SubagentRecord, limits: SubagentLimits): ChildRuntime;
  lifecycleTimeoutMs?: number;
  autoSave?: boolean;
}
interface Node {
  record: SubagentRecord;
  runtime: ChildRuntime;
  seq: number;
  job?: Promise<void>;
  active?: SubagentRun;
  activeLimits?: SubagentLimits;
  initialSave?: Promise<void>;
  persisted: boolean;
  queue: Array<{ run: SubagentRun; input: RunInput; limits: SubagentLimits }>;
  usageIds: Set<string>;
  notified: Set<string>;
}
const active = (status: SubagentStatus) => ['queued', 'running', 'cancelling'].includes(status);
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const taskText = (text: string) => {
  if (typeof text !== 'string' || !text.trim() || text.length > 16_384)
    throw new Error('Task must contain 1–16384 characters');
  return text;
};
function positive(value: number | undefined, maximum: number, name: string): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  return value;
}

export class AgentSupervisor {
  private nodes = new Map<string, Node>();
  private limits: SubagentLimits = { ...DEFAULT_SUBAGENT_LIMITS };
  private closed = false;
  private switching = false;
  private restoring?: Node[];
  private observers = new Set<() => void>();

  constructor(private readonly opts: SupervisorOptions) {}
  get settings(): Readonly<SubagentLimits> {
    return { ...this.limits };
  }
  configure(limits: Partial<SubagentLimits>): void {
    const next = { ...this.limits, ...limits };
    const bounds: SubagentLimits = {
      maxRunning: 16,
      maxDepth: 4,
      maxTurns: 128,
      timeoutMs: 3_600_000,
      maxInbox: 64,
      maxOutputChars: 1_048_576,
      previewChars: 65_536,
      maxAgents: 64,
      maxRuns: 64,
    };
    for (const key of Object.keys(next) as Array<keyof SubagentLimits>)
      positive(next[key], bounds[key], key);
    if (next.previewChars > next.maxOutputChars)
      throw new Error('previewChars exceeds maxOutputChars');
    this.limits = next;
  }
  private origin(origin?: InvocationOrigin): InvocationOrigin {
    return (
      origin ?? {
        sessionId: this.opts.rootSession.id,
        agentId: 'root',
        runId: '',
        source: 'user',
        userRequest: '',
      }
    );
  }
  private check(origin: InvocationOrigin, readOnly = false): void {
    if (!readOnly && (this.closed || this.switching))
      throw new Error('Agent supervisor is closing or switching sessions');
    if (
      origin.agentId === 'root'
        ? origin.sessionId !== this.opts.rootSession.id
        : ![...this.nodes.values()].some(
            (node) =>
              node.record.sessionId === origin.sessionId &&
              node.record.agentId === origin.agentId &&
              node.record.rootSessionId === this.opts.rootSession.id,
          )
    )
      throw new Error('Agent operation does not belong to the current session');
    if (origin.agentId !== 'root' && !this.nodes.has(origin.agentId))
      throw new Error('Unknown parent agent');
  }
  private get(agentId: string, origin?: InvocationOrigin, readOnly = false): Node {
    this.check(this.origin(origin), readOnly);
    const node = this.nodes.get(agentId);
    if (!node || node.record.rootSessionId !== this.opts.rootSession.id)
      throw new Error('Agent not owned by current session');
    return node;
  }
  private runningCount(): number {
    return [...this.nodes.values()].filter((node) => node.job).length;
  }
  plan(agentId: string) {
    return this.get(agentId).runtime.loop.plan;
  }
  private parentPlan(origin?: InvocationOrigin) {
    return origin && origin.agentId !== 'root'
      ? this.get(origin.agentId, origin).runtime.loop.plan
      : this.opts.rootLoop.plan;
  }
  spawn(input: SpawnAgentInput, provided?: InvocationOrigin): AgentAddress {
    const origin = this.origin(provided);
    this.check(origin);
    this.parentPlan(origin).assertDelegation();
    taskText(input.task);
    if (this.nodes.size >= this.limits.maxAgents) throw new Error('Agent history limit reached');
    if (this.runningCount() >= this.limits.maxRunning)
      throw new Error('Running agent limit reached');
    const parent = origin.agentId === 'root' ? undefined : this.get(origin.agentId, origin);
    const depth = (parent?.record.depth ?? 0) + 1;
    if (depth > this.limits.maxDepth) throw new Error('Agent depth limit reached');
    if (input.context && !['fresh', 'snapshot'].includes(input.context))
      throw new Error('Unknown context mode');
    if (input.name && (input.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(input.name)))
      throw new Error('Invalid agent name');
    const maxTurns = positive(input.maxTurns, this.limits.maxTurns, 'maxTurns');
    const timeoutMs = positive(input.timeoutMs, this.limits.timeoutMs, 'timeoutMs');
    const allowedTools = input.allowedTools
      ? input.allowedTools.filter(
          (name) => !parent?.record.allowedTools || parent.record.allowedTools.includes(name),
        )
      : parent?.record.allowedTools?.slice();
    this.parentPlan(origin).validateChildStep(input.planStepId);
    const record: SubagentRecord = {
      agentId: `a-${randomUUID()}`,
      sessionId: newSessionId(),
      rootSessionId: this.opts.rootSession.id,
      parentAgentId: origin.agentId,
      name: input.name ?? `agent-${this.nodes.size + 1}`,
      depth,
      context: input.context ?? 'fresh',
      readOnly: parent?.record.readOnly || input.readOnly === true,
      ...(allowedTools ? { allowedTools } : {}),
      runs: [],
    };
    const node = this.create(record);
    const snapshot = (parent?.runtime.loop ?? this.opts.rootLoop).exportSession();
    node.runtime.loop.importSession({
      ...snapshot,
      plan: undefined,
      messages: record.context === 'snapshot' ? snapshot.messages : [],
    });
    const parentPlan = (parent?.runtime.loop ?? this.opts.rootLoop).plan;
    node.runtime.loop.plan.configure(parentPlan.snapshot?.mode ?? parentPlan.mode);
    this.nodes.set(record.agentId, node);
    const run = this.newRun(node, input.task);
    this.parentPlan(origin).bindChild(input.planStepId, {
      agentId: record.agentId,
      runId: run.runId,
      name: record.name,
    });
    node.queue.push({
      run,
      input: {
        text: input.task,
        source: provided ? 'delegation' : 'user',
        userRequest: provided ? origin.userRequest : input.task,
      },
      limits: { ...this.limits, maxTurns, timeoutMs },
    });
    if (this.opts.autoSave !== false) this.initialize(node);
    this.launch(node);
    try {
      this.opts.rootLoop.deliverData(
        JSON.stringify({
          source: 'subagent',
          event: 'spawned',
          agentId: record.agentId,
          runId: run.runId,
          task: input.task,
        }),
      );
    } catch {
      this.opts.events.emit({
        type: 'notice',
        text: `子任务 ${record.name} 已创建；父 inbox 已满，通过 /agents 查看。`,
      });
    }
    this.persistRoot();
    return { agentId: record.agentId, runId: run.runId };
  }
  send(
    agentId: string,
    text: string,
    provided?: InvocationOrigin,
  ): AgentAddress & { queued: boolean } {
    this.parentPlan(provided).assertDelegation();
    const node = this.get(agentId, provided);
    if (provided && provided.agentId !== 'root') {
      const sender = this.get(provided.agentId, provided).record;
      if (
        (sender.readOnly && !node.record.readOnly) ||
        (sender.allowedTools &&
          (!node.record.allowedTools ||
            node.record.allowedTools.some((name) => !sender.allowedTools!.includes(name))))
      )
        throw new Error('Cannot delegate to an agent with broader child permissions');
    }
    taskText(text);
    const input: RunInput = {
      text,
      source: provided ? 'delegation' : 'user',
      userRequest: provided ? provided.userRequest : text,
    };
    if (node.active?.status === 'cancelling') throw new Error('Agent cancellation has not settled');
    if (
      node.runtime.loop.inboxSize + node.queue.length >=
      (node.activeLimits ?? this.limits).maxInbox
    )
      throw new Error('Agent inbox limit reached');
    if (node.active && node.runtime.loop.enqueueInput(input)) {
      node.active.activity = '已追加消息，等待处理';
      this.emit(node, node.active, 'status');
      return { agentId, runId: node.active.runId, queued: true };
    }
    if (!node.job && this.runningCount() >= this.limits.maxRunning)
      throw new Error('Running agent limit reached');
    const localPlan = node.runtime.loop.plan.snapshot;
    if (localPlan && ['paused', 'cancelled', 'interrupted'].includes(localPlan.phase))
      node.runtime.loop.plan.resume();
    const run = this.newRun(node, text);
    (
      this.nodes.get(node.record.parentAgentId)?.runtime.loop ?? this.opts.rootLoop
    ).plan.childRestarted(agentId, run);
    node.queue.push({ run, input, limits: { ...this.limits } });
    this.emit(node, run, 'status');
    this.launch(node);
    this.persistRoot();
    return { agentId, runId: run.runId, queued: Boolean(node.active) };
  }
  status(agentId?: string, runId?: string, origin?: InvocationOrigin): SubagentRecord[] {
    // 纯状态快照在切换/关闭期间仍可读取；控制操作继续保持门禁与所有权校验。
    this.check(this.origin(origin), true);
    const nodes = agentId ? [this.get(agentId, origin, true)] : [...this.nodes.values()];
    return nodes.map(({ record }) => {
      if (runId && !record.runs.some((run) => run.runId === runId))
        throw new Error('Run not owned by this agent');
      return structuredClone({
        ...record,
        runs: runId ? record.runs.filter((run) => run.runId === runId) : record.runs,
      });
    });
  }
  async wait(
    agentId: string,
    options: { runId?: string; timeoutMs?: number; signal?: AbortSignal } = {},
    origin?: InvocationOrigin,
  ): Promise<{ timedOut: boolean; agentId: string; run: SubagentRun }> {
    const node = this.get(agentId, origin);
    const run = options.runId
      ? node.record.runs.find((run) => run.runId === options.runId)
      : node.record.runs.at(-1);
    if (!run) throw new Error('Run not owned by this agent');
    // 自己或祖先不会在当前控制调用结束前完成；明确返回，避免等待环。
    let ancestor = origin?.agentId;
    while (ancestor && ancestor !== 'root') {
      if (ancestor === agentId && active(run.status))
        throw new Error('Cannot wait for self or active ancestor');
      ancestor = this.nodes.get(ancestor)?.record.parentAgentId;
    }
    const timeoutMs = positive(options.timeoutMs, 3_600_000, 'timeoutMs');
    const snapshot = (timedOut: boolean) => ({ timedOut, agentId, run: structuredClone(run) });
    options.signal?.throwIfAborted();
    if (!active(run.status)) return snapshot(false);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.observers.delete(changed);
        options.signal?.removeEventListener('abort', cancel);
      };
      const changed = () => {
        if (!active(run.status)) {
          cleanup();
          resolve(snapshot(false));
        }
      };
      const cancel = () => {
        cleanup();
        reject(options.signal?.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(snapshot(true));
      }, options.timeoutMs ?? 30_000);
      this.observers.add(changed);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      else changed();
      void timeoutMs;
    });
  }
  cancel(agentId: string, runId?: string, origin?: InvocationOrigin): SubagentRecord {
    const node = this.get(agentId, origin);
    if (runId && !node.record.runs.some((run) => run.runId === runId))
      throw new Error('Run not owned by this agent');
    this.cancelNode(node, runId);
    this.persistRoot();
    return this.status(agentId, undefined, origin)[0];
  }
  cancelAll(): void {
    for (const node of this.nodes.values()) this.cancelNode(node);
  }
  private cancelNode(node: Node, runId?: string): void {
    const cancelDescendants =
      !runId || (node.active?.runId === runId && active(node.active.status));
    if (node.active && (!runId || node.active.runId === runId) && active(node.active.status)) {
      node.active.status = 'cancelling';
      node.active.activity = '正在取消，等待实际执行结算';
      node.runtime.loop.abort_current();
      this.emit(node, node.active, 'status');
    }
    node.queue = node.queue.filter((entry) => {
      if (runId && entry.run.runId !== runId) return true;
      entry.run.status = 'cancelled';
      entry.run.activity = '已取消未开始任务';
      this.complete(node, entry.run);
      if (this.opts.autoSave !== false)
        void node.runtime.session.save().catch((error) =>
          this.opts.events.emit({
            type: 'notice',
            text: `取消子任务保存失败: ${failure(error)}`,
          }),
        );
      return false;
    });
    if (cancelDescendants)
      for (const child of this.nodes.values())
        if (child.record.parentAgentId === node.record.agentId) this.cancelNode(child);
  }
  get hasPendingActivity(): boolean {
    return [...this.nodes.values()].some(
      (node) =>
        node.job ||
        node.queue.length ||
        node.runtime.loop.hasPendingActivity ||
        node.runtime.session.hasPendingPersistence,
    );
  }
  async whenSettled(): Promise<void> {
    while (this.hasPendingActivity)
      await Promise.allSettled(
        [...this.nodes.values()].flatMap((node) => [
          node.job,
          node.runtime.loop.whenSettled(),
          node.runtime.session.whenPersistenceSettled(),
        ]),
      );
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.cancelAll();
    await bounded(
      () => this.whenSettled(),
      new AbortController().signal,
      this.opts.lifecycleTimeoutMs ?? 30_000,
    );
    const results = await Promise.allSettled(
      [...this.nodes.values()].map(async (node) => {
        await node.runtime.loop.dispose();
        await node.runtime.session.finalize();
        node.runtime.detach();
      }),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Child cleanup failed');
  }
  state(): { children: SubagentRecord[] } {
    return {
      children: [...this.nodes.values()]
        .filter((node) => node.persisted)
        .map((node) => structuredClone(node.record)),
    };
  }
  usage(): { self: TokenUsage; tree: TokenUsage } {
    const self = this.opts.rootSession.tokenUsage;
    const tree = { ...self };
    for (const node of this.nodes.values())
      for (const run of node.record.runs)
        for (const key of Object.keys(tree) as Array<keyof TokenUsage>) tree[key] += run.usage[key];
    return { self, tree };
  }
  async prepareResume(signal?: AbortSignal): Promise<void> {
    if (this.switching || this.closed) throw new Error('Supervisor is busy');
    this.switching = true;
    try {
      this.cancelAll();
      this.opts.rootLoop.abort_current();
      await bounded(
        () =>
          Promise.all([
            this.whenSettled(),
            this.opts.rootLoop.whenSettled(),
            this.opts.rootSession.whenPersistenceSettled(),
          ]),
        signal ?? new AbortController().signal,
        this.opts.lifecycleTimeoutMs ?? 30_000,
      );
      // 先完成旧会话的写入，再读目标 CAS 基线；门禁一直保持到 restored/失败回滚。
      if (this.opts.autoSave !== false) await this.opts.rootSession.save(signal);
    } catch (error) {
      this.resumeFailed();
      throw error;
    }
  }
  async beforeResume(file: SessionFile, signal?: AbortSignal): Promise<void> {
    if (!this.switching || this.closed) throw new Error('Supervisor is not preparing a restore');
    const nodes: Node[] = [];
    this.restoring = nodes;
    try {
      const records = structuredClone(file.agents?.children ?? []);
      const seen = new Set<string>();
      for (const record of records) {
        if (
          record.rootSessionId !== file.id ||
          !isValidSessionId(record.sessionId) ||
          record.sessionId === file.id ||
          seen.has(record.agentId) ||
          seen.has(record.sessionId)
        )
          throw new Error('Invalid child session ownership');
        seen.add(record.agentId);
        seen.add(record.sessionId);
        const parent = records.find((parent) => parent.agentId === record.parentAgentId);
        if (
          record.parentAgentId === 'root'
            ? record.depth !== 1
            : !parent ||
              parent.depth !== record.depth - 1 ||
              (parent.readOnly && !record.readOnly) ||
              (parent.allowedTools &&
                (!record.allowedTools ||
                  record.allowedTools.some((name) => !parent.allowedTools!.includes(name))))
        )
          throw new Error('Invalid child task tree or permission intersection');
        const node = this.create(record);
        try {
          await node.runtime.session.resume(record.sessionId, { signal });
        } catch (error) {
          node.runtime.detach();
          throw error;
        }
        nodes.push(node);
        node.persisted = true;
        for (const run of record.runs)
          if (active(run.status)) {
            run.status = 'interrupted';
            run.activity = '恢复时标记中断；未重放工具或模型请求';
          }
      }
    } catch (error) {
      this.resumeFailed();
      throw error;
    }
  }
  resumeFailed(): void {
    for (const node of this.restoring ?? []) node.runtime.detach();
    this.restoring = undefined;
    this.switching = false;
  }
  restored(): void {
    for (const node of this.nodes.values()) node.runtime.detach();
    this.nodes = new Map((this.restoring ?? []).map((node) => [node.record.agentId, node]));
    this.restoring = undefined;
    this.switching = false;
    for (const node of this.nodes.values()) {
      const run = node.record.runs.at(-1);
      if (run)
        (
          this.nodes.get(node.record.parentAgentId)?.runtime.loop ?? this.opts.rootLoop
        ).plan.childChanged(node.record.agentId, node.record.name, run);
    }
  }
  private create(record: SubagentRecord): Node {
    const runtime = this.opts.createChild(record, { ...this.limits });
    const node: Node = {
      record,
      runtime,
      seq: 0,
      queue: [],
      persisted: this.opts.autoSave === false,
      usageIds: new Set(),
      notified: new Set(record.runs.filter((run) => !active(run.status)).map((run) => run.runId)),
    };
    const off = runtime.events.onAll((event) => this.observe(node, event));
    const original = runtime.detach;
    runtime.detach = () => {
      off();
      original();
    };
    return node;
  }
  private newRun(node: Node, task: string): SubagentRun {
    if (node.record.runs.length >= this.limits.maxRuns)
      throw new Error('Agent run history limit reached');
    const run: SubagentRun = {
      runId: `r-${randomUUID()}`,
      task,
      status: 'queued',
      activity: '准备运行',
      output: '',
      truncated: false,
      usage: emptyUsage(),
      turns: 0,
    };
    node.record.runs.push(run);
    return run;
  }
  private launch(node: Node): void {
    if (node.job) return;
    node.job = Promise.resolve()
      .then(async () => {
        try {
          if (!node.persisted) await (node.initialSave ?? this.initialize(node));
        } catch (error) {
          await node.runtime.session.whenPersistenceSettled();
          // 旧任务明确失败，不自动重放；只有显式新 send 才重试已结算的初始保存。
          node.initialSave = undefined;
          for (const entry of node.queue.splice(0)) {
            entry.run.status = 'failed';
            entry.run.error = `初始化保存失败: ${failure(error)}`;
            this.complete(node, entry.run);
          }
          return;
        }
        while (node.queue.length) {
          const { run, input, limits } = node.queue.shift()!;
          node.activeLimits = limits;
          node.active = run;
          run.status = 'running';
          run.activity = '等待模型';
          node.runtime.loop.setModel(this.opts.rootLoop.model);
          node.runtime.loop.setThinking(this.opts.rootLoop.thinking);
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            this.cancelNode(node, run.runId);
          }, limits.timeoutMs);
          try {
            const execution = node.runtime.loop.run(input.text, {
              ...input,
              runId: run.runId,
              maxTurns: limits.maxTurns,
              maxInbox: limits.maxInbox,
              maxOutputChars: limits.maxOutputChars,
            });
            // running 可见前 loop 必须已绑定 abort/inbox，首个同步观察者也能 cancel/send。
            this.emit(node, run, 'status');
            const result = await execution;
            await node.runtime.loop.whenSettled();
            run.turns = result.turns;
            run.reason = timedOut
              ? 'timeout'
              : run.reason === 'output_limit'
                ? 'output_limit'
                : result.reason;
            run.error = result.error;
            const localPlan = node.runtime.loop.plan.snapshot;
            run.status =
              timedOut || run.reason === 'output_limit'
                ? 'limited'
                : result.reason === 'aborted'
                  ? 'cancelled'
                  : result.reason === 'error'
                    ? 'failed'
                    : result.reason === 'completed'
                      ? localPlan && localPlan.mode !== 'only' && localPlan.phase !== 'completed'
                        ? 'failed'
                        : 'completed'
                      : 'limited';
          } catch (error) {
            await node.runtime.loop.whenSettled();
            run.status = 'failed';
            run.error = failure(error);
          } finally {
            clearTimeout(timer);
          }
          run.activity = run.status;
          this.complete(node, run);
          if (this.opts.autoSave !== false) {
            try {
              await node.runtime.session.save();
            } catch (error) {
              run.error = `保存失败: ${failure(error)}`;
              this.emit(node, run, 'status');
            }
          }
          node.active = undefined;
          node.activeLimits = undefined;
        }
      })
      .finally(() => {
        node.job = undefined;
        // send 可能发生在 while 退出与 finally 之间；显式 inbox 不能遗留为永久 queued。
        if (node.queue.length) this.launch(node);
        this.persistRoot();
        for (const observer of this.observers) observer();
      });
    void node.job.catch((error) =>
      this.opts.events.emit({ type: 'notice', text: `子任务结算失败: ${failure(error)}` }),
    );
  }
  private initialize(node: Node): Promise<void> {
    node.initialSave = node.runtime.session.save().then(() => undefined);
    void node.initialSave.catch(() => undefined);
    return node.initialSave;
  }
  private complete(node: Node, run: SubagentRun): void {
    if (node.notified.has(run.runId)) return;
    node.notified.add(run.runId);
    this.emit(node, run, 'complete');
    const preview = (node.activeLimits ?? this.limits).previewChars;
    const output =
      run.output.length > preview
        ? run.output.slice(0, preview) +
          '\n[结果已截断；/agents 详情或 agent_status 可查看完整结果]'
        : run.output;
    const data = JSON.stringify({
      source: 'subagent',
      agentId: node.record.agentId,
      runId: run.runId,
      status: run.status,
      output,
      error: run.error,
    });
    const parent = this.nodes.get(node.record.parentAgentId)?.runtime.loop ?? this.opts.rootLoop;
    try {
      parent.deliverData(data);
    } catch {
      this.opts.events.emit({
        type: 'notice',
        text: `子任务 ${node.record.name} 已完成；inbox 已满，请通过 /agents 查看。`,
      });
    }
    for (const observer of this.observers) observer();
    this.persistRoot();
  }
  private observe(node: Node, event: AgentEvent): void {
    if (event.type === 'session_saved' && event.id === node.record.sessionId) {
      // 原始提交为准：取消/退出保存以及超时后的迟到成功也建立可恢复的根关联。
      node.persisted = true;
      this.persistRoot();
    }
    const run =
      (event.type === 'model_usage' || event.type === 'model_request') && event.runId
        ? node.record.runs.find((run) => run.runId === event.runId)
        : node.active;
    if (!run) return;
    if (event.type === 'text_delta') {
      const remaining = Math.max(
        0,
        (node.activeLimits ?? this.limits).maxOutputChars - run.output.length,
      );
      run.output += event.text.slice(0, remaining);
      if (run.activity === '等待模型' || run.activity === '正在思考') run.activity = '正在回复';
      if (event.text.length > remaining) {
        run.truncated = true;
        this.cancelNode(node, run.runId);
      }
      this.emit(node, run, 'text', { text: event.text.slice(0, remaining) });
    } else if (event.type === 'model_usage') {
      const key = `${node.record.agentId}:${event.requestId}`;
      if (node.usageIds.has(key)) return;
      node.usageIds.add(key);
      for (const key of Object.keys(run.usage) as Array<keyof TokenUsage>)
        run.usage[key] += event.usage[key];
      this.emit(node, run, 'usage', {
        requestId: event.requestId,
        usage: { ...event.usage },
        purpose: event.purpose,
      });
    } else if (event.type === 'permission_request') {
      run.activity = '等待审批';
      this.emit(node, run, 'status');
    } else {
      if (event.type === 'tool_result' && run.status === 'cancelling') {
        const limit = (node.activeLimits ?? this.limits).maxOutputChars;
        const partial = `\n[工具 ${event.name} 的部分结果]\n${event.result.content}`;
        const remaining = Math.max(0, limit - run.output.length);
        run.output += partial.slice(0, remaining);
        if (partial.length > remaining) run.truncated = true;
      }
      if (event.type === 'thinking_delta') run.activity = '正在思考';
      if (event.type === 'tool_call') run.activity = `执行 ${event.toolUse.name}`;
      if (event.type === 'model_request')
        run.activity =
          event.purpose === 'judge'
            ? '审核权限'
            : event.purpose === 'compact'
              ? '压缩上下文'
              : '等待模型';
      if (event.type === 'error') run.error = event.error.message;
      if (event.type === 'notice' && event.text.startsWith('output_limit:')) {
        run.truncated = true;
        run.reason = 'output_limit';
      }
      this.emit(node, run, 'status', {
        detail: structuredClone(event) as unknown as Record<string, unknown>,
      });
    }
  }
  private emit(
    node: Node,
    run: SubagentRun,
    kind: 'status' | 'text' | 'usage' | 'complete',
    fields: Partial<Extract<AgentEvent, { type: 'subagent_event' }>> = {},
  ): void {
    const parent = this.nodes.get(node.record.parentAgentId)?.runtime.loop ?? this.opts.rootLoop;
    parent.plan.childChanged(node.record.agentId, node.record.name, run);
    this.opts.events.emit({
      ...fields,
      type: 'subagent_event',
      agentId: node.record.agentId,
      runId: run.runId,
      seq: ++node.seq,
      name: node.record.name,
      kind,
      status: run.status,
      activity: run.activity,
    });
  }
  private persistRoot(): void {
    if (this.opts.autoSave === false || this.closed || this.switching) return;
    void this.opts.rootSession
      .save(undefined, { background: true })
      .catch((error) =>
        this.opts.events.emit({ type: 'notice', text: `子任务关联保存失败: ${failure(error)}` }),
      );
  }
}
