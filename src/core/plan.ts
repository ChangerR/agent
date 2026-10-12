/** 计划只管理状态与执行约束；不调度工具或子任务。 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventBus, LoopEndReason } from './events.js';
import type { Provider, ThinkingLevel } from './provider.js';
import type { PolicyInput } from '../sdk/capabilities.js';
import type { SubagentRun } from './agents.js';
import type { Message } from './protocol/types.js';

export type PlanningMode = 'auto' | 'only' | 'off';
const text = z.string().trim().min(1).max(2000);
export const PlanSchema = z
  .object({
    id: text,
    revision: z.number().int().nonnegative(),
    goal: text,
    activeStepId: z.string().optional(),
    mode: z.enum(['auto', 'only']),
    /** 任务本身只授权研究；与 only（仅产出方案）分开。 */
    readOnly: z.boolean().optional(),
    denialReason: z.string().max(2000).optional(),
    phase: z.enum([
      'planning',
      'ready',
      'executing',
      'paused',
      'cancelled',
      'interrupted',
      'blocked',
      'completed',
    ]),
    reason: z.string().max(2000).optional(),
    steps: z
      .array(
        z.object({
          id: text,
          title: text,
          status: z.enum([
            'pending',
            'running',
            'blocked',
            'completed',
            'cancelled',
            'interrupted',
          ]),
          evidence: z.string().max(2000).optional(),
          evidenceStepIds: z.array(text).max(64).optional(),
          reason: z.string().max(2000).optional(),
          children: z
            .array(
              z.object({
                agentId: text,
                runId: text,
                name: text,
                status: text,
                activity: z.string().max(2000),
              }),
            )
            .max(64),
        }),
      )
      .min(1)
      .max(64),
  })
  .superRefine((p, ctx) => {
    if (new Set(p.steps.map((s) => s.id)).size !== p.steps.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate step id' });
    if (p.activeStepId && !p.steps.some((s) => s.id === p.activeStepId))
      ctx.addIssue({ code: 'custom', message: 'Unknown active step' });
    if (
      p.phase === 'completed' &&
      p.steps.some((s) => s.status !== 'completed' || !s.evidence?.trim())
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Completed plans require completed steps with evidence',
      });
  });
export type Plan = z.infer<typeof PlanSchema>;
export interface PlannerInput {
  input: string;
  /** 与执行阶段相同的有效上下文，包含本轮输入和此前对话。 */
  messages: readonly Message[];
  systemPrompt: string;
  mode: PlanningMode;
  force: boolean;
  provider: Provider;
  model: string;
  thinking: ThinkingLevel;
  signal: AbortSignal;
  events: EventBus;
  runId: string;
}
export interface PlanningStrategy {
  prepare(
    input: PlannerInput,
  ): Promise<{ goal: string; steps: string[]; readOnly?: boolean } | undefined>;
  /** 模型准备结束时，由规划插件决定是否提醒它继续；loop 仍负责预算和中断。 */
  continuation?(plan: Plan): string | undefined;
  /** 只声明可用于调研的已注册工具身份；权限管线仍然必须通过。 */
  readTools: readonly { name: string; ownerPlugin: string }[];
  controlTools: readonly { name: string; ownerPlugin: string; planningSafe?: boolean }[];
}
export class PlanController {
  private value?: Plan;
  private successful = new Set<string>();
  private calls = new Map<string, string>();
  private epoch = 0;
  private denialEpoch = 0;
  mode: PlanningMode = 'auto';
  force = false;
  preparing = false;
  constructor(
    private events: EventBus,
    readonly owner = 'root',
  ) {}
  get snapshot(): Plan | undefined {
    return this.value && structuredClone(this.value);
  }
  get generation(): number {
    return this.epoch;
  }
  get researchOnly(): boolean {
    return this.value?.readOnly === true;
  }
  get denialReason(): string | undefined {
    return this.value?.denialReason;
  }
  /** 拒绝与显式解锁均递增，避免旧审批跨 false→true→false 边界复用。 */
  get denialGeneration(): number {
    return this.denialEpoch;
  }
  deny(reason: string, stepTitle = '被拒绝的操作') {
    this.denialEpoch++;
    // 简单任务或直接委派也必须保留拒绝边界；复用现有计划持久化和显式继续入口。
    if (!this.value || this.value.phase === 'completed') {
      this.create(
        '操作被拒绝，等待用户明确继续',
        [stepTitle],
        this.mode === 'only' ? 'only' : 'auto',
        this.researchOnly,
      );
      this.value!.steps[0].status = 'running';
    }
    this.value!.denialReason = reason.slice(0, 2000);
    this.stop('blocked', this.value!.denialReason);
  }
  get readOnly(): boolean {
    return (
      (this.value?.phase === 'completed' ? this.mode : (this.value?.mode ?? this.mode)) === 'only'
    );
  }
  get current() {
    return this.value?.steps.find(
      (s) => s.id === this.value?.activeStepId && s.status === 'running',
    );
  }
  private changed(invalidateExecution = true) {
    if (invalidateExecution) this.epoch++;
    if (this.value) this.value.revision++;
    this.events.emit({ type: 'plan_changed', owner: this.owner, plan: this.snapshot });
  }
  configure(mode: PlanningMode) {
    if (this.mode !== mode || (mode === 'only' && this.value?.mode === 'auto')) {
      this.mode = mode;
      if (mode === 'only' && this.value) this.value.mode = 'only';
      this.changed();
    }
  }
  create(goal: string, titles: string[], mode: 'auto' | 'only', readOnly = false) {
    const plan = PlanSchema.parse({
      id: randomUUID(),
      revision: 0,
      goal,
      mode,
      ...(readOnly ? { readOnly: true } : {}),
      phase: mode === 'only' ? 'planning' : 'executing',
      steps: titles.map((title) => ({ id: randomUUID(), title, status: 'pending', children: [] })),
    });
    if (this.denialReason) this.denialEpoch++;
    this.value = plan;
    this.successful.clear();
    this.calls.clear();
    this.changed();
  }
  restore(raw?: Plan) {
    this.denialEpoch++;
    this.value = raw ? PlanSchema.parse(raw) : undefined;
    this.successful.clear();
    this.calls.clear();
    if (
      this.value &&
      !this.value.denialReason &&
      !['completed', 'cancelled', 'ready'].includes(this.value.phase)
    ) {
      this.value.phase = 'interrupted';
      this.value.reason = '会话恢复：执行已中断，需显式继续，不会重放工具';
      for (const step of this.value.steps)
        if (step.status === 'running') step.status = 'interrupted';
    }
    if (this.value?.mode === 'only') this.mode = 'only';
    // importSession 是无事件提交；避免恢复期间把新计划写入旧会话。
    if (this.value) {
      for (const step of this.value.steps)
        for (const child of step.children)
          if (['queued', 'running', 'cancelling'].includes(child.status)) {
            child.status = 'interrupted';
            child.activity = '恢复中断，未重放';
          }
      this.value.revision++;
    }
    this.epoch++;
  }
  clear() {
    if (this.denialReason) this.denialEpoch++;
    this.value = undefined;
    this.successful.clear();
    this.calls.clear();
    this.changed();
  }
  update(
    revision: number,
    input: {
      stepId?: string;
      status?: 'running' | 'blocked' | 'completed';
      evidence?: string;
      evidenceStepIds?: string[];
      reason?: string;
      goal?: string;
      steps?: { id?: string; title: string }[];
    },
  ) {
    const p = this.value;
    if (!p || p.revision !== revision)
      throw new Error('plan_stale: refresh plan_status before updating');
    if (p.denialReason)
      throw new Error(`plan_denied: explicit user continuation required: ${p.denialReason}`);
    if (['paused', 'cancelled', 'interrupted', 'completed'].includes(p.phase))
      throw new Error('Plan requires explicit user continuation');
    if (input.steps) {
      const next = input.steps.map((s) => {
        const old = p.steps.find((x) => x.id === s.id);
        if (s.id && !old) throw new Error('Unknown stable step id');
        if (old && old.title !== s.title && (old.status === 'completed' || old.children.length))
          throw new Error('Retain completed/bound steps; add a new step for changed work');
        return old
          ? { ...old, title: s.title }
          : { id: randomUUID(), title: s.title, status: 'pending' as const, children: [] };
      });
      if (
        p.steps.some(
          (s) =>
            (s.status === 'completed' ||
              s.children.some((c) => ['queued', 'running', 'cancelling'].includes(c.status))) &&
            !next.some((n) => n.id === s.id),
        )
      )
        throw new Error('Revision must retain completed and child-bound steps');
      const parsed = PlanSchema.parse({ ...p, goal: input.goal ?? p.goal, steps: next });
      this.value = parsed;
    } else {
      const s = p.steps.find((s) => s.id === input.stepId);
      if (!s || !input.status) throw new Error('A valid stepId and status are required');
      if (s.status === 'completed')
        throw new Error('Completed steps are immutable; add a follow-up step');
      if (input.status === 'completed') {
        if (this.readOnly) throw new Error('Planning does not complete implementation steps');
        if (!input.evidence?.trim()) throw new Error('Completion evidence is required');
        if ([...this.calls.values()].includes(s.id)) throw new Error('Execution has not settled');
        if (s.children.some((c) => c.status !== 'completed'))
          throw new Error('Child work has not completed');
        const references = input.evidenceStepIds ?? [];
        if (
          references.length &&
          (!this.researchOnly ||
            references.some((id) => {
              const index = p.steps.findIndex((step) => step.id === id);
              return (
                index < 0 ||
                index >= p.steps.indexOf(s) ||
                p.steps[index].status !== 'completed' ||
                !p.steps[index].evidence?.trim()
              );
            }))
        )
          throw new Error('Analysis evidence must reference earlier completed read-only steps');
        if (!this.successful.has(s.id) && !s.children.length && !references.length)
          throw new Error('No successful execution evidence for this step');
        if (s.status !== 'running')
          throw new Error('Start the step and resolve blockers before completing it');
        s.evidence = input.evidence;
        if (references.length) s.evidenceStepIds = [...new Set(references)];
      }
      if (input.status === 'running') {
        const other = p.steps.find(
          (x) => x.id !== s.id && x.status === 'running' && !x.children.length,
        );
        if (other) throw new Error('Finish or block the current parent step first');
        p.activeStepId = s.id;
      }
      if (input.status === 'blocked' && !input.reason?.trim())
        throw new Error('Blocked steps require a reason');
      s.status = input.status;
      s.reason = input.status === 'blocked' ? input.reason : undefined;
    }
    const next = this.value!;
    next.phase = next.steps.every((s) => s.status === 'completed')
      ? 'completed'
      : this.readOnly
        ? 'planning'
        : 'executing';
    next.reason = undefined;
    this.changed();
  }
  stop(phase: 'paused' | 'cancelled' | 'interrupted' | 'blocked', reason: string) {
    if (!this.value || this.value.phase === 'completed') return;
    this.value.phase = phase;
    this.value.reason = reason;
    this.value.activeStepId = undefined;
    for (const s of this.value.steps)
      if (s.status === 'running') {
        s.status =
          phase === 'cancelled' ? 'cancelled' : phase === 'blocked' ? 'blocked' : 'interrupted';
        s.reason = reason;
      }
    this.changed();
  }
  execute() {
    if (!this.value) throw new Error('No plan to execute');
    this.successful.clear();
    this.value.mode = 'auto';
    this.resume();
  }
  resume() {
    if (!this.value) throw new Error('No plan to continue');
    if (this.value.phase === 'completed') throw new Error('Plan is already complete');
    if (this.denialReason) this.denialEpoch++;
    this.value.denialReason = undefined;
    this.value.phase = this.readOnly ? 'planning' : 'executing';
    this.value.reason = undefined;
    this.changed();
  }
  finish(reason: LoopEndReason) {
    if (!this.value || ['paused', 'cancelled', 'completed'].includes(this.value.phase)) return;
    if (this.value.denialReason) return;
    if (reason === 'completed' && this.readOnly) {
      this.value.phase = 'ready';
      for (const step of this.value.steps) if (step.status === 'running') step.status = 'pending';
      this.value.activeStepId = undefined;
      this.changed();
    } else if (reason !== 'completed')
      this.stop(reason === 'aborted' ? 'interrupted' : 'blocked', `轮次结束：${reason}`);
    else if (this.value.steps.some((s) => s.status !== 'completed'))
      this.stop('blocked', '模型结束，但计划步骤尚未验证完成');
  }
  restrict(operation: PolicyInput, strategy?: PlanningStrategy): string | undefined {
    if (this.preparing) return 'plan_preparing: wait for the published plan';
    const p = this.value;
    if (p && ['paused', 'cancelled', 'interrupted'].includes(p.phase))
      return 'Plan is paused/cancelled/interrupted';
    const match = (list: readonly { name: string; ownerPlugin: string }[] = []) =>
      list.some(
        (t) => t.name === operation.tool.name && t.ownerPlugin === operation.tool.ownerPlugin,
      );
    const control = strategy?.controlTools.find(
      (t) => t.name === operation.tool.name && t.ownerPlugin === operation.tool.ownerPlugin,
    );
    if (control && (!this.readOnly || control.planningSafe !== false)) return;
    if (p?.denialReason)
      return `plan_denied: explicit user continuation required: ${p.denialReason}`;
    if (this.readOnly) {
      const a = operation.analysis;
      if (
        !match(strategy?.readTools) ||
        a?.completeness !== 'complete' ||
        !a.effects.length ||
        a.effects.some((e) => e.kind !== 'read')
      )
        return 'plan_read_only: only verified dedicated research tools are allowed; shell and delegation are disabled';
    } else if (
      this.researchOnly &&
      (operation.analysis?.completeness !== 'complete' ||
        !operation.analysis.effects.length ||
        operation.analysis.effects.some((effect) => effect.kind !== 'read'))
    ) {
      // 未执行的未知命令不是步骤执行失败；保留可用只读工具继续调查的运行步骤。
      // 只撤销可信调用登记，不能通过伪造工具错误文本绕过实际失败或明确拒绝。
      if (
        operation.toolCallId &&
        operation.analysis?.completeness !== 'complete' &&
        !operation.analysis?.effects.some((effect) => !['read', 'unknown'].includes(effect.kind)) &&
        this.current?.status === 'running'
      ) {
        this.calls.delete(operation.toolCallId);
        return 'task_read_only: command not executed; only verified read effects are allowed. For an unverified shell shape, use dedicated read_file/glob/grep tools instead; do not retry that shape or restart the plan step.';
      }
      return 'task_read_only: this task only authorizes verified read effects';
    } else if (p && !this.current)
      return 'plan_step_required: start a step with plan_update before execution';
  }
  waiting(reason: string) {
    if (!this.current) return;
    this.current.reason = reason;
    // 审批的展示不改变执行语义版本，避免让当前批准永远过期。
    this.events.emit({ type: 'plan_changed', owner: this.owner, plan: this.snapshot });
  }
  toolStarted(id: string) {
    if (this.current) this.calls.set(id, this.current.id);
  }
  toolFinished(id: string, error: boolean, content: string) {
    const stepId = this.calls.get(id);
    this.calls.delete(id);
    const s = this.value?.steps.find((s) => s.id === stepId);
    if (!s) return;
    if (error) {
      this.successful.delete(s.id);
      if (['paused', 'cancelled', 'interrupted'].includes(this.value!.phase)) return;
      s.status = 'blocked';
      s.reason = content.slice(0, 2000);
      this.changed();
    } else {
      this.successful.add(s.id);
      if (!['paused', 'cancelled', 'interrupted'].includes(this.value!.phase)) s.reason = undefined;
    }
  }
  assertDelegation() {
    if (this.preparing) throw new Error('Plan is still preparing');
    if (this.denialReason)
      throw new Error(`plan_denied: explicit user continuation required: ${this.denialReason}`);
    if (this.readOnly)
      throw new Error('plan_read_only: delegation is disabled during planning-only');
    if (this.value && ['paused', 'cancelled', 'interrupted'].includes(this.value.phase))
      throw new Error('Plan is not executing');
  }
  validateChildStep(stepId?: string) {
    const p = this.value;
    if (!p) {
      if (stepId) throw new Error('No parent plan');
      return;
    }
    const step = p.steps.find((s) => s.id === (stepId ?? this.current?.id));
    if (!step || step.status === 'completed')
      throw new Error('A pending/running plan step is required for delegation');
  }
  bindChild(stepId: string | undefined, child: { agentId: string; runId: string; name: string }) {
    const p = this.value;
    if (!p) {
      if (stepId) throw new Error('No parent plan');
      return;
    }
    const step = p.steps.find((s) => s.id === (stepId ?? this.current?.id));
    if (!step || step.status === 'completed')
      throw new Error('A pending/running plan step is required for delegation');
    if (p.activeStepId === step.id) p.activeStepId = undefined;
    step.children.push({ ...child, status: 'queued', activity: '准备运行' });
    step.status = 'running';
    this.changed();
  }
  childRestarted(agentId: string, run: SubagentRun) {
    const step = this.value?.steps.find((s) => s.children.some((c) => c.agentId === agentId));
    if (!step) return;
    const child = step.children.find((c) => c.agentId === agentId)!;
    child.runId = run.runId;
    child.status = 'new';
    this.childChanged(agentId, child.name, run);
  }
  childChanged(agentId: string, name: string, run: SubagentRun) {
    const step = this.value?.steps.find((s) => s.children.some((c) => c.agentId === agentId));
    if (!step) return;
    const child = step.children.find((c) => c.agentId === agentId)!;
    if (child.runId !== run.runId) return;
    if (child.runId === run.runId && child.status === run.status && child.activity === run.activity)
      return;
    const activityOnly = child.status === run.status;
    Object.assign(child, { runId: run.runId, name, status: run.status, activity: run.activity });
    if (activityOnly) {
      // 活动文字不改变授权或执行边界，不能令父在途响应和审批失效。
      this.events.emit({ type: 'plan_changed', owner: this.owner, plan: this.snapshot });
      return;
    }
    const failed = step.children.find((c) =>
      ['failed', 'cancelled', 'limited', 'interrupted'].includes(c.status),
    );
    if (this.value!.denialReason) {
      // 新的活动/终态仍展示，但不能冲掉真实拒绝已锁定的步骤和来源。
      this.changed(false);
      return;
    }
    if (failed && !['paused', 'cancelled', 'interrupted'].includes(this.value!.phase)) {
      step.status = 'blocked';
      step.reason =
        failed.agentId === agentId
          ? (run.error ?? `child ${name}: ${run.status}`)
          : (step.reason ?? `child ${failed.name}: ${failed.status}`);
    } else if (
      run.status !== 'completed' &&
      !['paused', 'cancelled', 'interrupted'].includes(this.value!.phase)
    ) {
      step.status = 'running';
      step.evidence = undefined;
      step.reason = run.activity.includes('审批') ? run.activity : undefined;
      if (this.value?.phase === 'completed') this.value.phase = 'executing';
    }
    // 生命周期更新可令 CAS 修订过期，但不是新授权，不能丢弃父正在生成的 spawn/wait。
    this.changed(false);
  }
}
