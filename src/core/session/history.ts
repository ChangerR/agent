/**
 * 会话历史的纯函数：配对检查、保存前裁剪、标题。
 * 不改入参。空结果交给调用方跳过落盘。
 */
import { SUMMARY_MARKER } from '../context/manager.js';
import type { Message } from '../protocol/types.js';
import { SessionError } from './errors.js';

export function findUnpairedToolUse(messages: readonly Message[]): { index: number; id: string } | undefined {
  const resultIds = collectResultIds(messages);
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use' && !resultIds.has(block.id)) return { index, id: block.id };
    }
  }
  return undefined;
}

export function findOrphanToolResults(messages: readonly Message[]): Array<{ index: number; id: string }> {
  const useIds = collectUseIds(messages);
  const orphans: Array<{ index: number; id: string }> = [];
  messages.forEach((message, index) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block.type === 'tool_result' && !useIds.has(block.toolUseId)) {
        orphans.push({ index, id: block.toolUseId });
      }
    }
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
  const resultIds = collectResultIds(messages);
  let cut = messages.length;
  let reason: TrimResult['reason'];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const dangling = message.content.some((block) => block.type === 'tool_use' && !resultIds.has(block.id));
    if (dangling) {
      cut = index;
      reason = 'dangling_tool_use';
      break;
    }
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
  const unpaired = findUnpairedToolUse(messages);
  if (unpaired) {
    throw new SessionError(
      'invariant',
      `会话历史不满足 tool_use / tool_result 配对（消息 ${unpaired.index} 的 tool_use "${unpaired.id}" 没有结果），已拒绝保存或加载。`,
    );
  }
  const orphans = findOrphanToolResults(messages);
  if (orphans.length > 0) {
    const detail = orphans.map((item) => `消息 ${item.index} 的 tool_result "${item.id}" 没有调用`).join('，');
    throw new SessionError(
      'invariant',
      `会话历史不满足 tool_use / tool_result 配对（${detail}），已拒绝保存或加载。`,
    );
  }
}

/** 第一条非摘要的用户原文；否则退回第一条 user 的首个 text 块。按码点截到 40。 */
export function makeTitle(messages: readonly Message[]): string {
  let raw: string | undefined;
  for (const message of messages) {
    if (message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith(SUMMARY_MARKER)) {
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

function collectResultIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result') ids.add(block.toolUseId);
    }
  }
  return ids;
}

function collectUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') ids.add(block.id);
    }
  }
  return ids;
}

function isOrphanToolResultTail(messages: readonly Message[]): boolean {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== 'user' || !Array.isArray(tail.content) || tail.content.length === 0) return false;
  if (!tail.content.every((block) => block.type === 'tool_result')) return false;
  const useIds = collectUseIds(messages.slice(0, -1));
  return tail.content.every((block) => block.type === 'tool_result' && !useIds.has(block.toolUseId));
}

function isLeadingToolResult(message: Message): boolean {
  return message.role === 'user'
    && Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result');
}
