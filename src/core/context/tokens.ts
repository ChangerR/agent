import type { Message } from '../protocol/types.js';

export function messageChars(m: Message): number {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}

/** 启发式 token 估算：英文 ~4 字符/token，中文 ~1.5 字符/token，取保守值 3 */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / 3);
}

