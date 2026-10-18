/**
 * 唯一工具执行门：模型、runtime 和子工具都在这里完成校验、审批、绑定与审计。
 * 插件是受信任进程内代码；这个协议不宣称提供操作系统沙箱。
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AnalysisInput,
  Policy,
  PolicyDecision,
  PolicyInput,
  Reviewer,
  ToolAnalysis,
  ToolAnalyzer,
} from '../sdk/capabilities.js';
import { EventBus, type AgentEvent, type PermissionRequest, type UserDecision } from './events.js';
import type { HookRunner } from './hooks.js';
import type { Decision, JudgeStatus, ReviewHistoryStore } from './permission/contracts.js';
import { jsonInput } from './permission/input-validation.js';
import { CapabilityTimeout } from './permission/async.js';
import { RequestPermissionGuard } from './permission/request-scope.js';
import type { Message, ToolResult, ToolResultBlock, ToolUseBlock } from './protocol/types.js';
import type { Tool, ToolRegistry } from './registry.js';
import type { InvocationOrigin } from './agents.js';
import type { ToolLease, ToolScheduler } from './tool-scheduler.js';

/** 只记录内核已知的限制类别；宿主自定义理由可能含路径或任务正文。 */
function restrictionCode(reason: string): string {
  const separator = reason.indexOf(':');
  if (separator < 0) return 'execution_restriction';
  const prefix = reason.slice(0, separator);
  return [
    'plan_preparing',
    'plan_read_only',
    'task_read_only',
    'plan_step_required',
    'plan_denied',
  ].includes(prefix)
    ? prefix
    : 'execution_restriction';
}

export interface ToolInvocationContext {
  readonly signal: AbortSignal;
  readonly runId: string;
  readonly userRequest: string;
  readonly messages: readonly Message[];
  readonly depth?: number;
  readonly origin?: InvocationOrigin;
  readonly lease?: ToolLease;
}
export interface ToolExecutorOptions {
  tools: ToolRegistry;
  hooks: HookRunner;
  events: EventBus;
  cwd: string;
  policy: Policy;
  /** 选中能力的 canonical 身份，供实现未声明身份时使用。 */
  policyIdentity?: Readonly<{ id: string; version: string }>;
  reviewer?: Reviewer;
  analyzer?: ToolAnalyzer;
  /** 可选的审批历史存储；默认由 reviewer 提供。 */
  reviewHistory?: ReviewHistoryStore;
  sessionId?: () => string;
  configRevision?: () => string | number;
  toolIdentity?: (
    name: string,
  ) => { capabilityId: string; ownerPlugin: string; version: string } | undefined;
  runActive?: (runId: string) => boolean;
  approvalResponder?: (
    request: Readonly<PermissionRequest>,
    signal: AbortSignal,
  ) => Promise<UserDecision> | UserDecision;
  reviewTimeoutMs?: number;
  capabilityTimeoutMs?: number;
  scheduler?: ToolScheduler;
  /** 由宿主按注册身份指定控制工具，不采用工具自报 risk。 */
  isControlTool?: (tool: Tool) => boolean;
  /** 拒绝后仅允许宿主指定的观察/取消/计划控制，不允许再委派工作。 */
  isDenialExemptTool?: (tool: Tool) => boolean;
  requestPermission?: RequestPermissionGuard;
  restrict?: (input: PolicyInput) => string | undefined;
  agentName?: string;
  task?: () => string;
}
interface Binding {
  sessionId: string;
  runId: string;
  toolCallId: string;
  requestId: string;
  tool: Tool;
  execute: Tool['execute'];
  analyzeInput: Tool['analyzeInput'];
  toolVersion: string;
  toolDefinitionHash: string;
  toolIdentityHash: string;
  toolOwner?: string;
  capabilityId?: string;
  inputHash: string;
  policyRevision: string | number;
  policyIdentityHash: string;
  policyHandler: Policy['decide'];
  configRevision: string | number;
  signal: AbortSignal;
}

export class ToolExecutor {
  private readonly fallbackSession = randomUUID();
  private readonly history?: ReviewHistoryStore;
  private readonly used = new Map<string, Set<string>>();
  private readonly pending = new Set<Promise<ToolResultBlock>>();
  readonly requestPermission: RequestPermissionGuard;

  constructor(private readonly opts: ToolExecutorOptions) {
    this.history = opts.reviewHistory ?? opts.reviewer?.createHistory?.();
    this.requestPermission = opts.requestPermission ?? new RequestPermissionGuard();
    if (!opts.policy) throw new Error('ToolExecutor requires a selected policy');
  }

  clear(): void {
    this.history?.clear();
    this.used.clear();
  }
  finishRun(runId: string): void {
    this.used.delete(runId);
  }
  get hasPendingActivity(): boolean {
    return this.pending.size > 0 || this.opts.events.hasPendingActivity;
  }
  /** 只观察已发出的实际执行，不重试，也不把超时冒充执行结束。 */
  async whenSettled(): Promise<void> {
    while (this.hasPendingActivity)
      await Promise.allSettled([...this.pending, this.opts.events.whenSettled()]);
  }
  getJudgeStatus(): JudgeStatus {
    return this.opts.reviewer?.getStatus?.() ?? { loaded: false };
  }

  async invokeTool(
    name: string,
    input: Record<string, unknown>,
    context: ToolInvocationContext,
  ): Promise<ToolResult> {
    const result = await this.execute({ type: 'tool_use', id: randomUUID(), name, input }, context);
    return { content: result.content, isError: result.isError };
  }

  execute(toolUse: ToolUseBlock, context: ToolInvocationContext): Promise<ToolResultBlock> {
    const task = this.executeOne(toolUse, context);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }

  private async executeOne(
    toolUse: ToolUseBlock,
    context: ToolInvocationContext,
  ): Promise<ToolResultBlock> {
    toolUse = { ...toolUse };
    const { signal } = context;
    const { events, tools, hooks, cwd } = this.opts;
    const requestId = randomUUID();
    const permissionScope =
      context.origin?.permissionScope ??
      `${String(safeMetadata(() => this.sessionId()))}:${context.runId}`;
    let tool = tools.get(toolUse.name);
    let input: Record<string, unknown> = {};
    let resultEmitted = false;
    let lease: ToolLease | undefined;
    const finish = (result: ToolResult): ToolResultBlock => {
      if (!resultEmitted) {
        resultEmitted = true;
        events.emit({
          type: 'tool_result',
          toolUseId: toolUse.id,
          name: toolUse.name,
          result: structuredClone(result),
        });
      }
      return {
        type: 'tool_result',
        toolUseId: toolUse.id,
        content: result.content,
        isError: result.isError,
      };
    };
    const fail = (content: string) => finish({ content, isError: true });
    const audit = (
      phase: 'validation' | 'analysis' | 'policy' | 'reviewer' | 'human' | 'execution',
      reasonCode: string,
      decision?: PolicyDecision['kind'],
      binding?: Binding,
      durationMs?: number,
    ) => {
      events.emit({
        type: 'tool_execution',
        runId: context.runId,
        toolCallId: toolUse.id,
        requestId,
        sessionId: binding?.sessionId ?? String(safeMetadata(() => this.sessionId())),
        toolName: toolUse.name,
        toolVersion: binding?.toolVersion ?? tool?.version ?? 'unversioned',
        policyId: this.policyIdentity().id,
        toolOwner: binding?.toolOwner,
        capabilityId: binding?.capabilityId,
        policyVersion: this.policyIdentity().version,
        configRevision: binding?.configRevision ?? safeMetadata(() => this.configRevision()),
        policyRevision: binding?.policyRevision ?? safeMetadata(() => this.policyRevision()),
        inputHash: binding?.inputHash,
        phase,
        reasonCode,
        ...(decision ? { decision } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    };
    const restrictedResult = (reason: string, binding: Binding) => {
      const reasonCode = restrictionCode(reason);
      // 执行约束拒绝也进入权限审计；只记录当前调用，不产生新的整请求拒绝锁。
      // 已有的计划拒绝/用户拒绝仍由各自状态机保留，不能通过此事件解除。
      events.emit({
        type: 'permission_decision',
        permissionScope: context.origin?.permissionScope,
        rootPermissionScope: context.origin?.rootPermissionScope,
        denialScope: 'invocation',
        runId: context.runId,
        requestId,
        toolUseId: toolUse.id,
        toolName: toolUse.name,
        input: structuredClone(input),
        phase: 'pipeline',
        decision: { kind: 'deny', source: 'builtin', reasonCode, reason },
      });
      audit('policy', reasonCode, 'deny', binding);
      return fail(`Permission denied: ${reason}`);
    };
    const cancelled = () => {
      audit('execution', 'cancelled');
      return fail('Tool cancelled');
    };
    const requestDenied = () =>
      this.requestPermission.isDenied(permissionScope) &&
      !(tool && this.opts.isDenialExemptTool?.(tool));
    const stopped = () => {
      audit('execution', 'request_permission_denied', 'deny');
      return fail(
        'request_permission_denied: this user request was denied; stop work and await a new user direction',
      );
    };

    try {
      if (signal.aborted) return cancelled();
      if (!(this.opts.runActive?.(context.runId) ?? true))
        return fail('approval_stale: originating run has ended');
      if (!tool) {
        audit('validation', 'unknown_tool');
        return fail(`Unknown tool: ${toolUse.name}`);
      }
      if (requestDenied()) return stopped();
      if ((context.depth ?? 0) > 32) {
        audit('validation', 'nesting_limit');
        return fail('Tool nesting limit exceeded');
      }
      const used = this.used.get(context.runId) ?? new Set<string>();
      if (used.has(toolUse.id)) {
        audit('validation', 'duplicate_call');
        return fail('Duplicate tool call ID');
      }
      used.add(toolUse.id);
      this.used.set(context.runId, used);
      input = jsonInput(toolUse.input, tool.inputSchema);
      const hook = await this.opts.events.bounded(
        (hookSignal) => hooks.runPreToolUse({ toolName: tool!.name, input, signal: hookSignal }),
        signal,
        this.opts.capabilityTimeoutMs ?? 30_000,
      );
      if (signal.aborted) return cancelled();
      if (hook.veto) {
        audit('validation', 'hook_veto');
        return fail(`Vetoed by PreToolUse hook: ${hook.veto}`);
      }
      input = freeze(jsonInput(hook.input ?? input, tool.inputSchema));
      audit('validation', 'input_valid');

      // 同一次调用里，用户已经批准过的 ask/review 可以在仅 policyRevision 变化时复用。
      // 配置、工具身份或分析指纹变化仍重新询问；deny 不复用。
      let humanApproval:
        | {
            inputHash: string;
            toolDefinitionHash: string;
            toolIdentityHash: string;
            sessionId: string;
            configRevision: string | number;
            analysisFingerprint: string;
            remember?: 'session' | 'project';
          }
        | undefined = undefined;
      // 配置或环境在询问期间改变时重新评估，绝不复用之前的一次性批准。
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted) return cancelled();
        if (requestDenied()) return stopped();
        jsonInput(input, tool.inputSchema);
        if (tools.get(toolUse.name) !== tool) {
          audit('validation', 'tool_changed');
          return fail('Tool identity changed; invoke the selected tool again');
        }
        const binding = this.bind(tool, toolUse.id, requestId, input, context);
        const descriptor = approvalTool(tool);
        const analysisInput: AnalysisInput = {
          tool: descriptor,
          input,
          cwd,
          configRevision: binding.configRevision,
          policyRevision: binding.policyRevision,
        };
        const analyzer = this.opts.analyzer ?? this.opts.policy?.analyzer;
        let analysis: ToolAnalysis | undefined;
        let analysisFailed = false;
        if (analyzer) {
          try {
            analysis = freeze(
              structuredClone(
                await this.opts.events.bounded(
                  (s) => analyzer.analyze(analysisInput, s),
                  signal,
                  this.opts.capabilityTimeoutMs ?? 30_000,
                ),
              ),
            );
            if (!analysis || !validAnalysis(analysis)) throw new Error('Invalid analyzer result');
            audit(
              'analysis',
              analysis.reasonCode ?? `analysis_${analysis.completeness}`,
              undefined,
              binding,
            );
          } catch {
            if (signal.aborted) return cancelled();
            analysisFailed = true;
            audit('analysis', 'analyzer_error', 'ask', binding);
          }
        }
        const reviewContext = this.history?.build(
          descriptor,
          input,
          cwd,
          context.userRequest,
          context.messages,
        );
        const operation: PolicyInput = freeze({
          tool: descriptor,
          input,
          cwd,
          analysis,
          context: reviewContext,
          sessionId: binding.sessionId,
          runId: context.runId,
          toolCallId: toolUse.id,
          configRevision: binding.configRevision,
          policyRevision: binding.policyRevision,
        });
        const restricted = this.opts.restrict?.(operation);
        if (restricted) return restrictedResult(restricted, binding);
        let policyDecision: PolicyDecision;
        try {
          policyDecision = structuredClone(
            await this.opts.events.bounded(
              (s) => this.decide(operation, s),
              signal,
              this.opts.capabilityTimeoutMs ?? 30_000,
            ),
          );
          if (!validDecision(policyDecision)) throw new Error('Invalid policy result');
        } catch {
          if (signal.aborted) return cancelled();
          policyDecision = {
            kind: 'ask',
            source: 'builtin',
            reason: '审批策略失败，需人工确认',
            reasonCode: 'policy_error',
          };
        }
        if (analysisFailed && policyDecision.kind !== 'deny') {
          policyDecision = {
            kind: 'ask',
            source: 'builtin',
            reason: '操作分析失败，需人工确认',
            reasonCode: 'analyzer_error',
          };
        }
        if (requestDenied()) return stopped();
        let decision: Decision = {
          ...policyDecision,
          kind: policyDecision.kind === 'review' ? 'ask' : policyDecision.kind,
        };
        const emitDecision = (phase: 'pipeline' | 'judge' | 'user') =>
          events.emit({
            type: 'permission_decision',
            permissionScope: context.origin?.permissionScope,
            rootPermissionScope: context.origin?.rootPermissionScope,
            ...(policyDecision.kind === 'deny' && policyDecision.denialScope === 'invocation'
              ? { denialScope: 'invocation' as const }
              : {}),
            runId: context.runId,
            requestId,
            toolUseId: toolUse.id,
            toolName: tool!.name,
            input: structuredClone(input),
            phase,
            decision: structuredClone(decision),
          });
        const invocationOnlyDenial =
          policyDecision.kind === 'deny' && policyDecision.denialScope === 'invocation';
        if (policyDecision.kind === 'deny' && !invocationOnlyDenial)
          this.requestPermission.deny(permissionScope);
        emitDecision('pipeline');
        audit(
          'policy',
          policyDecision.reasonCode ?? `${policyDecision.source}_${policyDecision.kind}`,
          policyDecision.kind,
          binding,
        );

        let remember: 'session' | 'project' | undefined;
        const approvalReused =
          humanApproval !== undefined &&
          (policyDecision.kind === 'ask' || policyDecision.kind === 'review') &&
          humanApproval.inputHash === binding.inputHash &&
          humanApproval.toolDefinitionHash === binding.toolDefinitionHash &&
          humanApproval.toolIdentityHash === binding.toolIdentityHash &&
          humanApproval.sessionId === binding.sessionId &&
          humanApproval.configRevision === binding.configRevision &&
          humanApproval.analysisFingerprint === approvalAnalysisFingerprint(analysis);
        if (approvalReused && humanApproval) {
          decision = {
            kind: 'allow',
            source: 'user',
            reason: '用户确认本次操作',
            reasonCode: 'user_allow',
          };
          remember = humanApproval.remember;
          this.recordDecision(descriptor, input, decision);
          emitDecision('user');
          audit('human', 'user_allow_reused', 'allow', binding);
        } else if (policyDecision.kind === 'review') {
          // 明确 ask/deny 不可被 reviewer 改写，只有 policy 的 review 才能委托一次。
          const finalRestriction = this.opts.restrict?.(operation);
          if (finalRestriction) return restrictedResult(finalRestriction, binding);
          const started = Date.now();
          decision = await this.review(operation, policyDecision, context, signal, requestId);
          if (signal.aborted) return cancelled();
          if (requestDenied()) return stopped();
          if (decision.kind === 'deny') this.requestPermission.deny(permissionScope);
          this.recordDecision(descriptor, input, decision);
          emitDecision('judge');
          audit(
            'reviewer',
            decision.reasonCode ?? decision.judge?.reasonCode ?? 'reviewer_unknown',
            decision.kind,
            binding,
            Date.now() - started,
          );
        }

        if (decision.kind === 'deny') {
          if (!invocationOnlyDenial) this.requestPermission.deny(permissionScope);
          this.history?.record(
            descriptor,
            input,
            cwd,
            context.userRequest,
            structuredClone(decision),
          );
          return fail(`Permission denied: ${decision.reason}`);
        }

        if (decision.kind === 'ask') {
          const summary =
            analysis?.summary ?? descriptor.analyzeInput?.(input).summary ?? tool.name;
          const request = freeze({
            ...(context.origin?.agentId !== 'root' && context.origin
              ? {
                  agentId: context.origin.agentId,
                  agentName: this.opts.agentName,
                  task: this.opts.task?.(),
                }
              : {}),
            runId: context.runId,
            requestId: randomUUID(),
            toolRequestId: requestId,
            toolName: tool.name,
            toolUseId: toolUse.id,
            decisionSource: decision.source,
            ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
            ...(policyDecision.reasonCode ? { policyReasonCode: policyDecision.reasonCode } : {}),
            ...(analysis?.reasonCode ? { analysisReasonCode: analysis.reasonCode } : {}),
            matchedRule: decision.matchedRule,
            cwd,
            input: structuredClone(input),
            summary,
            reason: decision.reason,
          });
          const userDecision = await this.ask(request, signal);
          if (signal.aborted) return cancelled();
          if (requestDenied()) return stopped();
          if (!userDecision) {
            audit('human', 'approval_required', 'ask', binding);
            this.history?.record(
              descriptor,
              input,
              cwd,
              context.userRequest,
              structuredClone(decision),
            );
            return fail('approval_required: this operation requires an approval responder');
          }
          decision = {
            kind: userDecision.allow ? 'allow' : 'deny',
            source: 'user',
            reason: userDecision.allow
              ? '用户确认本次操作'
              : `用户拒绝本次操作${userDecision.feedback ? `：${userDecision.feedback}` : ''}`,
            reasonCode: userDecision.allow ? 'user_allow' : 'user_deny',
          };
          if (!userDecision.allow) this.requestPermission.deny(permissionScope);
          this.recordDecision(descriptor, input, decision);
          emitDecision('user');
          audit('human', decision.reasonCode!, decision.kind, binding);
          if (userDecision.allow) {
            humanApproval = {
              inputHash: binding.inputHash,
              toolDefinitionHash: binding.toolDefinitionHash,
              toolIdentityHash: binding.toolIdentityHash,
              sessionId: binding.sessionId,
              configRevision: binding.configRevision,
              analysisFingerprint: approvalAnalysisFingerprint(analysis),
              ...(userDecision.remember ? { remember: userDecision.remember } : {}),
            };
          }
          if (!userDecision.allow) {
            this.requestPermission.deny(permissionScope);
            this.history?.record(
              descriptor,
              input,
              cwd,
              context.userRequest,
              structuredClone(decision),
            );
            return fail(
              `User denied this action.${userDecision.feedback ? ` Feedback: ${userDecision.feedback}` : ''}`,
            );
          }
          remember = userDecision.remember;
        }

        if (signal.aborted) return cancelled();
        if (requestDenied()) return stopped();
        const control = this.opts.isControlTool?.(tool) === true;
        if (control && context.lease)
          return fail('Control tools cannot run inside a workspace tool lease');
        if (!control && this.opts.scheduler) {
          const read =
            analysis?.completeness === 'complete' &&
            analysis.effects.length > 0 &&
            analysis.effects.every((effect) => effect.kind === 'read');
          lease = await this.opts.scheduler.acquire(read ? 'read' : 'write', signal, context.lease);
        }
        let environmentValid = true;
        if (analyzer && analysis) {
          try {
            environmentValid =
              (await this.opts.events.bounded(
                async (s) =>
                  analyzer.revalidate
                    ? analyzer.revalidate(analysis!, analysisInput, s)
                    : fingerprint(await analyzer.analyze(analysisInput, s)) ===
                      fingerprint(analysis),
                signal,
                this.opts.capabilityTimeoutMs ?? 30_000,
                lease && this.opts.scheduler
                  ? async (s) => {
                      const retained = await this.opts.scheduler!.acquire(lease!.mode, s, lease);
                      return () => retained.release();
                    }
                  : undefined,
              )) === true;
          } catch {
            environmentValid = false;
          }
        }
        if (signal.aborted) return cancelled();
        if (requestDenied()) return stopped();
        if (!environmentValid || !this.bindingValid(binding, toolUse.name, input)) {
          audit(
            'execution',
            environmentValid ? 'approval_stale' : 'environment_changed',
            'ask',
            binding,
          );
          if (
            this.sessionId() !== binding.sessionId ||
            !(this.opts.runActive?.(context.runId) ?? true)
          ) {
            return fail('approval_stale: originating session or run has changed');
          }
          if (attempt < 2) {
            lease?.release();
            lease = undefined;
            continue;
          }
          return fail(
            'approval_stale: tool, configuration, policy, or environment changed during approval',
          );
        }
        // 从最终重验到 execute 不再 await；记忆规则是本次有效人工批准的附带结果。
        // child 的人工批准只绑定此次调用；不能把规则写进共享父控制器。
        if (context.origin && context.origin.agentId !== 'root') remember = undefined;
        if (remember) this.remember(descriptor, input, remember);
        const expectedRevision = remember ? this.policyRevision() : binding.policyRevision;
        const reviewRecord = this.history?.record(
          descriptor,
          input,
          cwd,
          context.userRequest,
          structuredClone(decision),
        );
        events.emit({ type: 'tool_call', toolUse: { ...toolUse, input: structuredClone(input) } });
        // 观测者可能同步取消或更新配置，所以 tool_call 后还须检查一次绑定。
        if (signal.aborted) return cancelled();
        if (requestDenied()) return stopped();
        if (
          !this.bindingValid({ ...binding, policyRevision: expectedRevision }, toolUse.name, input)
        ) {
          audit('execution', 'approval_stale', 'ask', binding);
          return fail('approval_stale: invocation changed before execution');
        }
        const started = Date.now();
        let result: ToolResult;
        try {
          // 子调用只继承本次执行的来源与取消信号，不读取 loop 的当前活动请求。
          result = await binding.execute.call(tool, input, {
            cwd,
            signal,
            analysis,
            invocation: context.origin,
            invokeTool: (name, childInput) =>
              this.invokeTool(name, childInput, {
                ...context,
                lease: lease ?? context.lease,
                depth: (context.depth ?? 0) + 1,
              }),
          });
          if (
            !result ||
            typeof result.content !== 'string' ||
            (result.isError !== undefined && typeof result.isError !== 'boolean')
          ) {
            result = { content: 'Tool returned an invalid result', isError: true };
          }
          result = {
            content: result.content,
            ...(result.isError !== undefined ? { isError: result.isError } : {}),
          };
        } catch (error) {
          result = {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
        if (reviewRecord) this.history?.finish(reviewRecord, result, signal.aborted);
        try {
          await this.opts.events.bounded(
            (s) =>
              hooks.notify(
                'PostToolUse',
                {
                  toolName: tool.name,
                  input: structuredClone(input),
                  result: structuredClone(result),
                },
                s,
              ),
            signal,
            this.opts.capabilityTimeoutMs ?? 30_000,
            lease && this.opts.scheduler
              ? async (s) => {
                  const retained = await this.opts.scheduler!.acquire(lease!.mode, s, lease);
                  return () => retained.release();
                }
              : undefined,
          );
        } catch {
          events.emit({
            type: 'notice',
            text: 'PostToolUse observer failed; the original tool result was retained',
          });
        }
        audit(
          'execution',
          signal.aborted ? 'cancelled' : result.isError ? 'tool_error' : 'tool_success',
          decision.kind,
          binding,
          Date.now() - started,
        );
        return finish(result);
      }
      return fail('approval_stale');
    } catch (error) {
      if (signal.aborted) return cancelled();
      audit('validation', 'invalid_input_or_handler');
      return fail(error instanceof Error ? error.message : String(error));
    } finally {
      lease?.release();
    }
  }

  private async decide(input: PolicyInput, signal: AbortSignal): Promise<PolicyDecision> {
    return this.opts.policy.decide(input, signal);
  }

  private async review(
    operation: PolicyInput,
    original: PolicyDecision,
    context: ToolInvocationContext,
    signal: AbortSignal,
    toolRequestId: string,
  ): Promise<Decision> {
    const fallback = (reasonCode: string, reason: string): Decision => ({
      ...original,
      kind: 'ask',
      source: 'judge',
      reasonCode,
      reason,
    });
    if (!this.opts.reviewer) return fallback('reviewer_unavailable', '审批员未加载，需人工确认');
    const events = new ReviewerEventBus(this.opts.events, {
      runId: context.runId,
      toolCallId: operation.toolCallId,
      toolRequestId,
    });
    try {
      const result = structuredClone(
        await this.opts.events.bounded(
          async (s) => {
            return this.opts.events.track(
              this.opts.reviewer!.review(
                {
                  ...operation,
                  decision: freeze(structuredClone(original)),
                  events,
                  userRequest: context.userRequest,
                  messages: freeze(structuredClone(context.messages)),
                },
                s,
              ),
            );
          },
          signal,
          this.opts.reviewTimeoutMs ?? 30_000,
        ),
      );
      if (
        !result ||
        !['allow', 'ask', 'deny', 'unknown'].includes(result.decision) ||
        typeof result.reason !== 'string' ||
        typeof result.reasonCode !== 'string'
      ) {
        return fallback('invalid_response', '审批员返回无效结果，需人工确认');
      }
      const kind = result.decision === 'unknown' ? 'ask' : result.decision;
      return {
        ...original,
        kind,
        source: 'judge',
        reasonCode: result.reasonCode,
        judge: result.judge,
        reason: `${kind === 'allow' ? 'LLM 审批员放行' : kind === 'deny' ? 'LLM 审批员拒绝' : 'LLM 审批员要求询问'}：${result.reason}`,
      };
    } catch (error) {
      return fallback(
        signal.aborted
          ? 'cancelled'
          : error instanceof CapabilityTimeout
            ? 'timeout'
            : 'provider_error',
        '审批员调用失败或超时，需人工确认',
      );
    }
  }

  private async ask(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<UserDecision | undefined> {
    if (signal.aborted) return undefined;
    if (!this.opts.approvalResponder && !this.opts.events.hasListeners('permission_request'))
      return undefined;
    return new Promise<UserDecision>((resolve) => {
      let settled = false;
      const finish = (value: UserDecision) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        try {
          value = structuredClone(value);
        } catch {
          value = { allow: false, feedback: 'Invalid approval response' };
        }
        // 畸形 responder 返回值绝不能被 truthy 值解释成批准。
        const valid =
          value &&
          typeof value === 'object' &&
          typeof value.allow === 'boolean' &&
          (value.allow
            ? value.remember === undefined ||
              value.remember === 'session' ||
              value.remember === 'project'
            : value.feedback === undefined || typeof value.feedback === 'string');
        resolve(valid ? freeze(value) : { allow: false, feedback: 'Invalid approval response' });
      };
      const cancel = () => finish({ allow: false, feedback: 'Tool cancelled' });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return;
      }
      if (this.opts.approvalResponder) {
        Promise.resolve()
          .then(() => this.opts.approvalResponder!(request, signal))
          .then(finish, () => finish({ allow: false, feedback: 'Approval responder failed' }));
      } else {
        try {
          this.opts.events.emit({ type: 'permission_request', request, signal, resolve: finish });
        } catch {
          finish({ allow: false, feedback: 'Approval responder failed' });
        }
      }
    });
  }

  private sessionId(): string {
    return this.opts.sessionId?.() ?? this.fallbackSession;
  }
  private configRevision(): string | number {
    return this.opts.configRevision?.() ?? 0;
  }
  private policyRevision(): string | number {
    return this.opts.policy?.revision ?? this.opts.policy?.controller?.revision ?? 0;
  }
  private bind(
    tool: Tool,
    toolCallId: string,
    requestId: string,
    input: Record<string, unknown>,
    context: ToolInvocationContext,
  ): Binding {
    const identity = this.opts.toolIdentity?.(tool.name);
    return Object.freeze({
      sessionId: this.sessionId(),
      runId: context.runId,
      toolCallId,
      requestId,
      tool,
      execute: tool.execute,
      analyzeInput: tool.analyzeInput,
      toolVersion: identity?.version ?? tool.version ?? 'unversioned',
      toolOwner: identity?.ownerPlugin,
      capabilityId: identity?.capabilityId,
      toolIdentityHash: fingerprint(identity ?? null),
      toolDefinitionHash: definitionHash(tool),
      inputHash: fingerprint(input),
      policyRevision: this.policyRevision(),
      configRevision: this.configRevision(),
      signal: context.signal,
      policyIdentityHash: this.policyIdentityHash(),
      policyHandler: this.opts.policy.decide,
    });
  }
  private bindingValid(binding: Binding, name: string, input: Record<string, unknown>): boolean {
    return (
      !binding.signal.aborted &&
      this.sessionId() === binding.sessionId &&
      this.configRevision() === binding.configRevision &&
      (this.opts.runActive?.(binding.runId) ?? true) &&
      this.policyRevision() === binding.policyRevision &&
      this.opts.tools.get(name) === binding.tool &&
      this.policyIdentityHash() === binding.policyIdentityHash &&
      this.opts.policy.decide === binding.policyHandler &&
      binding.tool.execute === binding.execute &&
      fingerprint(this.opts.toolIdentity?.(binding.tool.name) ?? null) ===
        binding.toolIdentityHash &&
      binding.tool.analyzeInput === binding.analyzeInput &&
      definitionHash(binding.tool) === binding.toolDefinitionHash &&
      fingerprint(input) === binding.inputHash
    );
  }
  private policyIdentity(): { id: string; version: string } {
    return {
      id: this.opts.policy?.id ?? this.opts.policyIdentity?.id ?? 'unidentified',
      version: this.opts.policy?.version ?? this.opts.policyIdentity?.version ?? '1.0.0',
    };
  }
  private policyIdentityHash(): string {
    return fingerprint(this.policyIdentity());
  }
  private recordDecision(
    tool: AnalysisInput['tool'],
    input: Record<string, unknown>,
    decision: Decision,
  ): void {
    this.opts.policy.controller?.recordDecision(tool, input, structuredClone(decision));
  }
  private remember(
    tool: AnalysisInput['tool'],
    input: Record<string, unknown>,
    remember: 'session' | 'project',
  ): void {
    const controller = this.opts.policy.controller;
    if (!controller) return;
    const target = tool.analyzeInput?.(input).patternTarget;
    const rule = target !== undefined ? `${tool.name}(=${JSON.stringify(target)})` : tool.name;
    controller.addSessionRule('allow', rule);
    if (remember === 'project')
      this.opts.events.emit({
        type: 'notice',
        text: `已加入会话规则。要持久化到项目，请把 "${rule}" 加入 agent.config.json 的 permissions.allow`,
      });
  }
}

function approvalTool(tool: Tool): AnalysisInput['tool'] {
  return freeze({
    name: tool.name,
    version: tool.version,
    ownerPlugin: tool.ownerPlugin,
    description: tool.description,
    inputSchema: structuredClone(tool.inputSchema),
    risk: tool.risk,
    isConcurrencySafe: tool.isConcurrencySafe,
    ...(tool.analyzeInput ? { analyzeInput: tool.analyzeInput.bind(tool) } : {}),
  });
}
function definitionHash(tool: Tool): string {
  return fingerprint({
    name: tool.name,
    version: tool.version ?? 'unversioned',
    ownerPlugin: tool.ownerPlugin,
    description: tool.description,
    risk: tool.risk,
    inputSchema: tool.inputSchema,
  });
}
/** 分析指纹不包含 $operation：它嵌入 policyRevision，记住规则本身不应使同一次批准失效。 */
function approvalAnalysisFingerprint(analysis: ToolAnalysis | undefined): string {
  if (!analysis?.environment) return fingerprint(analysis ?? null);
  const environment = { ...analysis.environment };
  delete environment['$operation'];
  return fingerprint({ ...analysis, environment });
}
function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      ),
    )
    .digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}
function validDecision(value: unknown): value is PolicyDecision {
  return (
    !!value &&
    typeof value === 'object' &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    ['allow', 'ask', 'deny', 'review'].includes(value.kind) &&
    (!('denialScope' in value) ||
      value.denialScope === undefined ||
      (value.kind === 'deny' && value.denialScope === 'invocation')) &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    'source' in value &&
    typeof value.source === 'string' &&
    ['session', 'config', 'builtin', 'mode', 'danger', 'judge', 'user'].includes(value.source) &&
    (!('reasonCode' in value) ||
      value.reasonCode === undefined ||
      typeof value.reasonCode === 'string') &&
    (!('matchedRule' in value) ||
      value.matchedRule === undefined ||
      typeof value.matchedRule === 'string')
  );
}
function validAnalysis(value: ToolAnalysis): boolean {
  return (
    !!value &&
    typeof value.analyzerId === 'string' &&
    typeof value.analyzerVersion === 'string' &&
    ['complete', 'partial', 'unknown'].includes(value.completeness) &&
    Array.isArray(value.effects) &&
    value.effects.every(
      (effect) =>
        effect &&
        ['read', 'write', 'execute', 'network', 'unknown'].includes(effect.kind) &&
        (effect.target === undefined || typeof effect.target === 'string') &&
        (effect.scope === undefined ||
          ['project', 'external', 'sensitive', 'unknown'].includes(effect.scope)),
    ) &&
    (value.targets === undefined ||
      (Array.isArray(value.targets) &&
        value.targets.every((target) => typeof target === 'string'))) &&
    (value.evidence === undefined ||
      (Array.isArray(value.evidence) &&
        value.evidence.every(
          (evidence) =>
            evidence && typeof evidence.source === 'string' && typeof evidence.detail === 'string',
        ))) &&
    (value.environment === undefined ||
      (value.environment !== null &&
        typeof value.environment === 'object' &&
        !Array.isArray(value.environment) &&
        Object.values(value.environment).every((v) => typeof v === 'string'))) &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.reasonCode === undefined || typeof value.reasonCode === 'string')
  );
}
function safeMetadata(read: () => string | number): string | number {
  try {
    return read();
  } catch {
    return 'unavailable';
  }
}

/** reviewer 看不到父总线和人工 resolver，只能提交关联后的模型请求/usage。 */
class ReviewerEventBus extends EventBus {
  readonly #parent: EventBus;
  readonly #correlation: { runId: string; toolCallId?: string; toolRequestId: string };
  constructor(
    parent: EventBus,
    correlation: { runId: string; toolCallId?: string; toolRequestId: string },
  ) {
    super();
    this.#parent = parent;
    this.#correlation = correlation;
  }
  override emit(event: AgentEvent): void {
    if (event.type === 'model_request' || event.type === 'model_usage') {
      this.#parent.emit({ ...event, ...this.#correlation, purpose: 'judge', modelRole: 'judge' });
    }
  }
  override track<T>(task: Promise<T>): Promise<T> {
    return this.#parent.track(task);
  }
}
