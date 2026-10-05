/**
 * 上下文管理：token 估算 + 压缩。
 *
 * 策略（与 Claude Code 思路一致）：
 * - 用启发式估算（~4 字符 ≈ 1 token）监视对话体积
 * - 超过阈值时，把最早的一半消息交给 LLM 总结成一段摘要，
 *   以一条 user 消息替换，保留最近的消息原样
 * - LLM 不可用时降级为硬截断
 */
import { complete, type Provider } from '../provider.js';
import type { Message } from '../protocol/types.js';
import type { EventBus } from '../events.js';

/** 启发式 token 估算：英文 ~4 字符/token，中文 ~1.5 字符/token，取保守值 3 */
export function estimateTokens(messages: readonly Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
  }
  return Math.ceil(chars / 3);
}

const SUMMARY_PROMPT = `请把以下对话历史压缩成一份简洁摘要，保留：用户的任务目标、已完成的工作、关键决定、重要的文件路径/代码片段、尚未解决的问题。直接输出摘要文本。

<conversation>
%s
</conversation>`;

export class ContextManager {
  constructor(private options: { compactThreshold: number }) {}

  /** 切换模型时由 loop 调用，按新模型的上下文窗口调整阈值 */
  setThreshold(n: number): void {
    this.options.compactThreshold = n;
  }

  get threshold(): number {
    return this.options.compactThreshold;
  }

  shouldCompact(messages: Message[]): boolean {
    return estimateTokens(messages) > this.options.compactThreshold;
  }

  /**
   * 压缩消息历史：前一半 → 摘要，后一半原样保留。
   * 返回新历史；若消息太少则原样返回。
   */
  async compact(messages: Message[], provider: Provider | null, signal: AbortSignal, model = '', events?: EventBus): Promise<Message[]> {
    if (messages.length < 8) return messages;
    let cut = Math.floor(messages.length / 2);
    const calls = new Map<string, number>();
    const spans: Array<{ start: number; end: number }> = [];
    messages.forEach((message, index) => {
      if (typeof message.content === 'string') return;
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.set(block.id, index);
        if (block.type === 'tool_result') {
          const start = calls.get(block.toolUseId);
          if (start !== undefined) {
            spans.push({ start, end: index });
            calls.delete(block.toolUseId);
          }
        }
      }
    });
    // 切点退到完整工具交换之前，多个结果消息与未完成的调用都不能被拆开。
    for (const start of calls.values()) spans.push({ start, end: messages.length });
    let crossing: { start: number; end: number } | undefined;
    while ((crossing = spans.find((span) => span.start < cut && span.end >= cut))) cut = crossing.start;
    if (cut === 0) return messages;
    const old = messages.slice(0, cut);
    const recent = messages.slice(cut);

    let summary: string;
    if (provider) {
      try {
        const { text } = await complete(
          provider,
          {
            model,
            system: '你是对话压缩器。',
            messages: [{ role: 'user', content: SUMMARY_PROMPT.replace('%s', JSON.stringify(old, null, 1).slice(0, 60_000)) }],
            tools: [],
          },
          signal,
          events ? { events, purpose: 'compact' } : undefined,
        );
        summary = text;
      } catch (error) {
        if (signal.aborted) throw error;
        summary = `[截断的早期对话，共 ${old.length} 条消息]`;
      }
    } else {
      summary = `[截断的早期对话，共 ${old.length} 条消息]`;
    }

    return [
      { role: 'user', content: `[早期对话摘要]\n${summary}` },
      ...recent,
    ];
  }
}
