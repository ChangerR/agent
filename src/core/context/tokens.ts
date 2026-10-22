import type { Message } from '../protocol/types.js';
import type { ChatRequest } from '../provider.js';

export function messageChars(m: Message): number {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}

/** 启发式 token 估算：英文 ~4 字符/token，中文 ~1.5 字符/token，取保守值 3 */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) chars += messageChars(m);
  return Math.ceil(chars / 3);
}

/** 无 tokenizer 时的保守启发式：ASCII 每 3 字符，非 ASCII 每个码点 2 tokens。 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const point of text) {
    if (point.codePointAt(0)! <= 0x7f) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3 + other * 2);
}

/** 包含 system、schema、消息封装及输出预留；估算值不冒充厂商 usage。 */
export function estimateRequestTokens(req: ChatRequest) {
  const inputTokens =
    estimateTextTokens(
      JSON.stringify({
        system: req.system,
        tools: req.tools,
        messages: req.messages,
      }),
    ) + 32;
  const outputTokens = req.maxTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
