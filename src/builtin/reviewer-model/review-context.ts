/** 审批上下文：保留来源与执行结果，独立于可被压缩的模型历史。 */
import { createHash } from 'node:crypto';
import { SUMMARY_MARKER } from '../../core/context/manager.js';
import type { Message, ToolResult } from '../../core/protocol/types.js';
import type { Tool } from '../../core/registry.js';
import type { Decision, ReviewRecord, ReviewContext } from '../../core/permission/contracts.js';
export type { ReviewRecord, ReviewContext } from '../../core/permission/contracts.js';

/** 只规范化 JSON 对象的键序；数组顺序、路径、空白与命令语法均不改变。 */
function fingerprint(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
  return createHash('sha256').update(json).digest('hex');
}

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 80) / 2);
  return `${text.slice(0, half)}\n[节选：省略 ${text.length - half * 2} 字符]\n${text.slice(-half)}`;
}

export class ReviewHistory {
  private entries: Array<{ record: ReviewRecord; fingerprint: string }> = [];

  clear(): void {
    this.entries = [];
  }

  record(tool: Omit<Tool, 'execute'>, input: Record<string, unknown>, cwd: string, userRequest: string, decision: Decision): ReviewRecord {
    const serialized = JSON.stringify(input);
    const record: ReviewRecord = {
      toolName: tool.name,
      ...(serialized.length <= 2000 ? { input: JSON.parse(serialized) as Record<string, unknown> } : {}),
      inputOmitted: serialized.length > 2000,
      cwd,
      userRequest: excerpt(userRequest, 1000),
      decision: { ...decision, reason: excerpt(decision.reason, 500) },
      outcome: decision.kind === 'allow' ? 'pending' : 'not_executed',
      at: Date.now(),
    };
    this.entries.push({ record, fingerprint: fingerprint(input) });
    // 内存有界；不把隐含授权写进会话文件或项目配置。
    if (this.entries.length > 100) this.entries.shift();
    return record;
  }

  finish(record: ReviewRecord, result: ToolResult, cancelled: boolean): void {
    record.outcome = cancelled ? 'cancelled' : result.isError ? 'error' : 'success';
    record.result = excerpt(result.content, 1000);
  }

  build(tool: Omit<Tool, 'execute'>, input: Record<string, unknown>, cwd: string, userRequest: string, messages: readonly Message[]): ReviewContext {
    const conversation: ReviewContext['conversation'] = [];
    let omittedConversation = false;
    let remaining = 6000;
    // 从最近消息开始取，完整当前操作另放在请求中，不依赖这里的参数节选。
    for (const message of [...messages].reverse()) {
      const parts: ReviewContext['conversation'] = [];
      if (typeof message.content === 'string') {
        parts.push({ source: message.role === 'user' && message.source === 'summary' || message.content.startsWith(SUMMARY_MARKER) ? 'summary' : 'user', text: message.content });
      } else {
        for (const block of message.content) {
          if (block.type === 'text') parts.push({ source: message.role === 'user' && (message.source === 'summary' || block.text.startsWith(SUMMARY_MARKER)) ? 'summary' : message.role, text: block.text });
          if (block.type === 'tool_result') parts.push({ source: 'tool', text: `${block.toolUseId} (${block.isError ? '失败' : '成功'}): ${block.content}` });
          if (block.type === 'tool_use') parts.push({ source: 'assistant', text: `${block.name}#${block.id}: ${JSON.stringify(block.input)}` });
          // thinking / signature 从不进入审批请求。
        }
      }
      for (const part of parts.reverse()) {
        const text = excerpt(part.text, 1600);
        const entry = { ...part, text };
        const size = JSON.stringify(entry).length;
        if (size > remaining || conversation.length >= 12) {
          omittedConversation = true;
          continue;
        }
        omittedConversation ||= text !== part.text;
        remaining -= size;
        conversation.unshift(entry);
      }
    }

    const key = fingerprint(input);
    const recent = [...this.entries].reverse();
    const matches = (entry: typeof recent[number]) => entry.record.toolName === tool.name && entry.record.cwd === cwd && entry.fingerprint === key;
    const matching = recent.filter(matches);
    // 最新相同操作及人工确认/拒绝优先，避免多次模型放行把人工记录挤出预算。
    // 接着保留近期工具结果，余下预算再补其他相同操作与历史。
    const candidates = [...new Set([
      ...matching.slice(0, 1),
      ...matching.filter((entry) => entry.record.decision.source === 'user'),
      ...recent.slice(0, 4),
      ...matching,
      ...recent,
    ])];
    const previousReviews: ReviewContext['previousReviews'] = [];
    remaining = 6000;
    for (const entry of candidates) {
      const record = { ...entry.record, sameOperation: matches(entry) };
      const size = JSON.stringify(record).length;
      if (size > remaining || previousReviews.length >= 8) continue;
      remaining -= size;
      previousReviews.push(structuredClone(record));
    }
    return { cwd, userRequest, conversation, previousReviews, omittedConversation, omittedReviews: this.entries.length - previousReviews.length };
  }
}
