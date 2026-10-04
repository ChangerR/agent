/**
 * FakeProvider —— 脚本化假 provider。
 *
 * 教学要点：有了它，agent loop / 权限管线 / 工具回填 的全链路
 * 都可以在无网络、确定性的条件下做单元测试。
 *
 * 脚本是一组"响应"，每次 stream() 调用消费一条；
 * 响应可以是静态事件数组，也可以是能看到当前请求的函数（断言请求的利器）。
 */
import type { ChatRequest, Provider } from '../core/provider.js';
import type { StreamEvent } from '../core/protocol/types.js';

export type ScriptedResponse =
  | StreamEvent[]
  | ((req: ChatRequest) => StreamEvent[]);

/** 便捷构造器：一轮纯文本回复 */
export function textResponse(text: string): StreamEvent[] {
  return [
    { type: 'message_start' },
    { type: 'text_delta', text },
    { type: 'message_stop', stopReason: 'end_turn' },
    { type: 'usage', inputTokens: 10, outputTokens: 10 },
  ];
}

/** 便捷构造器：一轮工具调用（可多个） */
export function toolUseResponse(calls: Array<{ id: string; name: string; input: unknown }>, text = ''): StreamEvent[] {
  const events: StreamEvent[] = [{ type: 'message_start' }];
  if (text) events.push({ type: 'text_delta', text });
  for (const c of calls) {
    events.push(
      { type: 'tool_use_start', id: c.id, name: c.name },
      { type: 'tool_use_delta', input: JSON.stringify(c.input) },
      { type: 'tool_use_stop' },
    );
  }
  events.push(
    { type: 'message_stop', stopReason: 'tool_use' },
    { type: 'usage', inputTokens: 10, outputTokens: 10 },
  );
  return events;
}

export class FakeProvider implements Provider {
  readonly name = 'fake';
  readonly capabilities = { thinking: false, streaming: true };
  /** 每次 stream() 收到的请求，测试里用来断言 */
  readonly requests: ChatRequest[] = [];
  private cursor = 0;

  constructor(private script: ScriptedResponse[]) {}

  async *stream(req: ChatRequest, _signal: AbortSignal): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    let step = this.script[this.cursor];
    // 函数型剧本由请求驱动、天然可复用：耗尽后复用最后一个函数，便于演示/长对话测试
    if (!step) {
      const last = this.script.at(-1);
      if (typeof last === 'function') {
        step = last;
      } else {
        // 脚本耗尽：默认结束对话，避免测试死循环
        yield { type: 'message_start' };
        yield { type: 'text_delta', text: '[fake provider: script exhausted]' };
        yield { type: 'message_stop', stopReason: 'end_turn' };
        return;
      }
    } else {
      this.cursor++;
    }
    const events = typeof step === 'function' ? step(req) : step;
    for (const ev of events) yield ev;
  }
}
