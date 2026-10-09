/**
 * 钩子系统：在 agent 生命周期的关键点允许插件介入。
 *
 * PreToolUse 在权限管线第 0 步执行，可改写参数或直接否决；
 * 其余点主要用于注入上下文与观测。
 */
import { prepareRegistration, type RegistrationBatch } from './registration.js';
import type { ToolResult } from './protocol/types.js';

export type HookPoint = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'TurnEnd';

export interface PreToolUsePayload {
  toolName: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface PreToolUseResult {
  /** 改写后的工具参数 */
  input?: Record<string, unknown>;
  /** 非空则否决此次调用，内容作为错误回填给模型 */
  veto?: string;
}

/**
 * 钩子处理器：参数按钩子点不同而不同，教学版统一用宽松签名，
 * 各钩子点的载荷形状见 PreToolUsePayload 与 notify() 的调用处。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HookHandler = (payload: any) => any;

export interface RegisteredHook {
  point: HookPoint;
  handler: HookHandler;
}

export class HookRunner {
  private hooks: RegisteredHook[] = [];
  private frozen = false;
  freeze(): void { this.frozen = true; }

  register(point: HookPoint, handler: HookHandler): void {
    const batch = this.prepareBatch([{ point, handler }]); batch.commit(); batch.seal();
  }
  prepareBatch(hooks: readonly RegisteredHook[]): RegistrationBatch {
    const assertMutable = () => { if (this.frozen) throw new Error('Hook registry is frozen'); };
    assertMutable();
    for (const hook of hooks) {
      if (!['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'TurnEnd'].includes(hook.point) || typeof hook.handler !== 'function') throw new Error('Invalid hook registration');
    }
    return prepareRegistration(this.hooks, [...this.hooks, ...hooks], () => this.hooks, value => { this.hooks = value; }, assertMutable);
  }
  /** PreToolUse：依次执行，允许改写 input，任一钩子 veto 即短路 */
  async runPreToolUse(payload: PreToolUsePayload): Promise<PreToolUseResult> {
    let input = payload.input;
    for (const hook of this.hooks) {
      if (hook.point !== 'PreToolUse') continue;
      payload.signal?.throwIfAborted();
      const result = (await hook.handler({ ...payload, input })) as PreToolUseResult | void;
      payload.signal?.throwIfAborted();
      if (result !== undefined && (!result || typeof result !== 'object'
        || (result.veto !== undefined && typeof result.veto !== 'string')
        || (result.input !== undefined && (!result.input || typeof result.input !== 'object' || Array.isArray(result.input))))) {
        throw new Error('Invalid PreToolUse hook result');
      }
      if (result?.veto) return { veto: result.veto };
      if (result?.input) input = result.input;
    }
    return { input };
  }

  /** 通知型钩子（PostToolUse / UserPromptSubmit / TurnEnd） */
  async notify(point: Exclude<HookPoint, 'PreToolUse'>, payload: unknown, signal?: AbortSignal): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.point !== point) continue;
      signal?.throwIfAborted();
      await hook.handler(payload && typeof payload === 'object' ? { ...payload, signal } : payload);
      signal?.throwIfAborted();
    }
  }

  /** PostToolUse 载荷类型（便于插件书写） */
  static postToolUsePayload(toolName: string, input: unknown, result: ToolResult) {
    return { toolName, input, result };
  }
}
