/** 历史提交边界。策略只能返回候选，不能持有或修改 loop 的消息数组。 */
import { z } from 'zod';
import type { Compactor, ContextCoordinator } from '../../sdk/runtime-capabilities.js';
import type { Message } from '../protocol/types.js';
import type { Provider } from '../provider.js';
import { EventBus } from '../events.js';
import { assertSafeHistory } from '../session/history.js';
import { MessageSchema } from '../session/schema.js';
import { bounded } from '../permission/async.js';
import { estimateTokens } from './tokens.js';

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Compaction aborted', 'AbortError');
}

export class ContextManager implements ContextCoordinator {
  constructor(private readonly options: { compactThreshold: number; compactor: Compactor; compactTimeoutMs?: number }) {}
  setThreshold(n: number): void { this.options.compactThreshold = n; }
  get threshold(): number { return this.options.compactThreshold; }
  shouldCompact(messages: readonly Message[]): boolean { return estimateTokens(messages) > this.threshold; }
  async compact(messages: Message[], provider: Provider | null, signal: AbortSignal, model = '', events?: EventBus): Promise<Message[]> {
    checkAbort(signal);
    const before = JSON.stringify(messages);
    const snapshot = freeze(structuredClone(messages));
    // 压缩器只能发布本次 compact 的用量/请求，不能订阅主总线审批 resolver。
    const scopedEvents = events ? new EventBus() : undefined;
    const detach = scopedEvents?.onAll((event) => {
      if ((event.type === 'model_request' || event.type === 'model_usage') && event.purpose === 'compact') events!.emit(structuredClone(event));
    });
    let proposal: readonly Message[];
    try { proposal = await bounded((child) => this.options.compactor.compact(snapshot, provider, child, model, scopedEvents), signal, this.options.compactTimeoutMs ?? 120_000); }
    catch (error) {
      if (signal.aborted && signal.reason instanceof Error && signal.reason.name === 'AbortError') throw new Error('Compaction cancelled', { cause: error });
      throw error;
    } finally { detach?.(); }
    checkAbort(signal);
    if (JSON.stringify(messages) !== before) throw new Error('压缩期间历史已变化，候选历史未提交');
    if (proposal === snapshot || JSON.stringify(proposal) === before) return messages;
    const parsed = z.array(MessageSchema).min(1).safeParse(proposal);
    if (!parsed.success) throw new Error(`压缩器返回了无效历史: ${parsed.error.message}`);
    assertSafeHistory(proposal);
    // 再次复制，插件持有的返回引用在提交之后也不能改写会话。
    const next = structuredClone(proposal) as Message[];
    preserveProvenance(snapshot, next);
    checkAbort(signal);
    return next;
  }
}

/** 摘要不能制造用户授权或工具证据。保留的真实用户消息与工具块分别必须是原历史的有序子序列。 */
function preserveProvenance(original: readonly Message[], candidate: Message[]): void {
  const realUsers: string[] = [];
  const toolBlocks: string[] = [];
  for (const message of original) {
    if (message.role === 'user' && message.source !== 'summary') {
      realUsers.push(JSON.stringify(message));
    }
    if (typeof message.content !== 'string') for (const block of message.content) {
      if (block.type === 'tool_use' || block.type === 'tool_result') toolBlocks.push(JSON.stringify(block));
    }
  }
  let userCursor = 0; let toolCursor = 0;
  for (const message of candidate) {
    if (message.role === 'user' && (typeof message.content === 'string' || message.content.some(block => block.type === 'text'))) {
      // 重复原文逐次向后匹配，不能把较早的授权重排到较晚的撤销之后。
      const found = message.source === 'summary' ? -1 : realUsers.indexOf(JSON.stringify(message), userCursor);
      if (found >= 0) userCursor = found + 1;
      else message.source = 'summary';
    }
    if (typeof message.content !== 'string') for (const block of message.content) {
      if (block.type !== 'tool_use' && block.type !== 'tool_result') continue;
      const key = JSON.stringify(block); const found = toolBlocks.indexOf(key, toolCursor);
      if (found < 0) throw new Error('压缩器不能伪造、改写或重排工具交换证据');
      toolCursor = found + 1;
    }
  }
}
