/** 只观测规范化输出，不解析/执行工具、不改变模型结果。截断仅影响调试副本。 */
import type { StreamEvent, StopReason } from './types.js';
/** 只保留标准状态码，不把 SDK 错误正文或请求头送进调试记录。 */
export function modelErrorCode(error: unknown): string {
  try {
    const item =
      error && typeof error === 'object' ? (error as { status?: unknown; code?: unknown }) : {};
    if (
      typeof item.status === 'number' &&
      Number.isInteger(item.status) &&
      item.status >= 400 &&
      item.status <= 599
    )
      return 'http_' + item.status;
    return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'].includes(String(item.code))
      ? String(item.code)
      : 'provider_error';
  } catch {
    return 'provider_error';
  }
}
export interface ModelResponseTrace {
  status: 'completed' | 'error' | 'aborted' | 'interrupted';
  text: string;
  thinking: string;
  tools: Array<{ id: string; name: string; arguments: string }>;
  chunks: number;
  stopReason?: StopReason;
  truncated: boolean;
  errorCode?: string;
}
export class ResponseTrace {
  private text = '';
  private thinking = '';
  private tools = new Map<string, { id: string; name: string; arguments: string }>();
  private chars = 0;
  private chunks = 0;
  private truncated = false;
  private stopReason?: StopReason;
  private bounded(value: string): string {
    const next = value.slice(0, Math.max(0, 1_000_000 - this.chars));
    this.chars += next.length;
    this.truncated ||= next.length < value.length;
    return next;
  }
  push(event: StreamEvent) {
    this.chunks++;
    if (event.type === 'text_delta') this.text += this.bounded(event.text);
    if (event.type === 'thinking_delta') this.thinking += this.bounded(event.text);
    if (event.type === 'tool_use_start') {
      if (this.tools.size < 1000)
        this.tools.set(event.id, { id: event.id, name: event.name, arguments: '' });
      else this.truncated = true;
    }
    if (event.type === 'tool_use_delta') {
      const tool = this.tools.get(event.id);
      if (tool) tool.arguments += this.bounded(event.input);
    }
    if (event.type === 'message_stop') this.stopReason = event.stopReason;
  }
  finish(status?: ModelResponseTrace['status'], errorCode?: string): ModelResponseTrace {
    return {
      status: status ?? (this.stopReason ? 'completed' : 'interrupted'),
      text: this.text,
      thinking: this.thinking,
      tools: [...this.tools.values()],
      chunks: this.chunks,
      stopReason: this.stopReason,
      truncated: this.truncated,
      errorCode,
    };
  }
}
