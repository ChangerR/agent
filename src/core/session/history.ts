/**
 * 会话历史的纯函数：配对检查、保存前裁剪、标题。
 * 不改入参。空结果交给调用方跳过落盘。
 */
import type { Message } from '../protocol/types.js';
import { SessionError } from './errors.js';

export function findUnpairedToolUse(messages: readonly Message[]): { index: number; id: string } | undefined {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const pending = new Set(message.content.filter((b) => b.type === 'tool_use').map((b) => b.id));
    for (let next = index + 1; next < messages.length && pending.size; next++) {
      const result = messages[next];
      if (result.role !== 'user' || typeof result.content === 'string' || result.content.some((b) => b.type !== 'tool_result')) break;
      for (const block of result.content) if (block.type === 'tool_result') pending.delete(block.toolUseId);
    }
    const id = pending.values().next().value;
    if (id !== undefined) return { index, id };
  }
  return undefined;
}

export function findOrphanToolResults(messages: readonly Message[]): Array<{ index: number; id: string }> {
  const pending = new Set<string>();
  const orphans: Array<{ index: number; id: string }> = [];
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      pending.clear();
      for (const block of message.content) if (block.type === 'tool_use') pending.add(block.id);
      return;
    }
    if (typeof message.content === 'string') { pending.clear(); return; }
    for (const block of message.content) {
      if (block.type === 'tool_result' && !pending.delete(block.toolUseId)) {
        orphans.push({ index, id: block.toolUseId });
      }
    }
    if (message.content.some((block) => block.type !== 'tool_result')) pending.clear();
  });
  return orphans;
}

export interface TrimResult {
  messages: Message[];
  dropped: number;
  reason?: 'dangling_tool_use' | 'orphan_tool_result' | 'empty_tail';
}

/**
 * 裁到可以安全续写的前缀。
 *
 * 尾部只弹出「自身全部是 tool_result，且 id 在保留部分里没有对应 tool_use」的 user 消息。
 * 已完成的工具回合也是这种形状，但不能裁，否则下一轮会丢结果。
 */
export function trimToSafeTail(messages: readonly Message[]): TrimResult {
  let cut = messages.length;
  let reason: TrimResult['reason'];
  const dangling = findUnpairedToolUse(messages);
  if (dangling) {
    cut = dangling.index;
    reason = 'dangling_tool_use';
  }

  const out = messages.slice(0, cut);
  while (out.length > 0) {
    const tail = out[out.length - 1];
    if (Array.isArray(tail.content) && tail.content.length === 0) {
      out.pop();
      reason ??= 'empty_tail';
      continue;
    }
    if (isOrphanToolResultTail(out)) {
      out.pop();
      reason ??= 'orphan_tool_result';
      continue;
    }
    break;
  }

  while (out.length > 0 && isLeadingToolResult(out[0])) {
    out.shift();
    reason ??= 'orphan_tool_result';
  }

  return { messages: out, dropped: messages.length - out.length, reason };
}

export function assertSafeHistory(messages: readonly Message[]): void {
  const pending = new Set<string>();
  const fail = (index: number, detail: string): never => {
    throw new SessionError('invariant', `会话历史不满足 tool_use / tool_result 配对（消息 ${index}: ${detail}），已拒绝保存或加载。`);
  };
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      if (pending.size) fail(index, '上一次工具调用尚未返回结果');
      for (const block of message.content) {
        if (block.type !== 'tool_use') continue;
        if (pending.has(block.id)) fail(index, `重复 tool_use "${block.id}"`);
        pending.add(block.id);
      }
      return;
    }
    const blocks = typeof message.content === 'string' ? [] : message.content;
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (pending.size && (results.length === 0 || blocks.some((b) => b.type !== 'tool_result'))) {
      fail(index, '工具结果之前插入了用户正文');
    }
    for (const block of results) {
      if (!pending.delete(block.toolUseId)) fail(index, `孤儿或重复 tool_result "${block.toolUseId}"`);
    }
  });
  if (pending.size) fail(messages.length, `tool_use "${[...pending][0]}" 没有结果`);
}

/** 第一条非摘要的用户原文；否则退回第一条 user 的首个 text 块。按码点截到 40。 */
export function makeTitle(messages: readonly Message[]): string {
  let raw: string | undefined;
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string' && message.source !== 'summary') {
      raw = message.content;
      break;
    }
  }
  if (raw === undefined) {
    const firstUser = messages.find((message) => message.role === 'user');
    if (firstUser && Array.isArray(firstUser.content)) {
      const text = firstUser.content.find((block) => block.type === 'text');
      if (text && text.type === 'text') raw = text.text;
    }
  }
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '(未命名会话)';
  const points = [...collapsed];
  if (points.length <= 40) return collapsed;
  return `${points.slice(0, 40).join('')}…`;
}

function isOrphanToolResultTail(messages: readonly Message[]): boolean {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== 'user' || !Array.isArray(tail.content) || tail.content.length === 0) return false;
  if (!tail.content.every((block) => block.type === 'tool_result')) return false;
  return findOrphanToolResults(messages).filter((item) => item.index === messages.length - 1).length === tail.content.length;
}

function isLeadingToolResult(message: Message): boolean {
  return message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result');
}
