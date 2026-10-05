import { describe, expect, it } from 'vitest';
import { ContextManager } from '../src/core/context/manager.js';
import { EventBus } from '../src/core/events.js';
import type { Message } from '../src/core/protocol/types.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (ids: string[]): Message => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'read_file', input: { path: id } })) });
const result = (id: string): Message => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: id }] });

describe('上下文压缩边界', () => {
  it('切点退到工具调用之前，多个分开的结果消息仍与调用一起保留', async () => {
    const messages = [user('start'), assistant('ok'), user('read'), call(['a', 'b']), result('a'), result('b'), assistant('done'), user('next')];
    const provider = new FakeProvider([textResponse('summary')]);
    const events = new EventBus();
    const usage: unknown[] = [];
    events.on('model_usage', (e) => usage.push(e));
    const compacted = await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, new AbortController().signal, 'fake', events);
    expect(compacted.slice(1)).toEqual(messages.slice(3));
    expect(usage).toMatchObject([{ purpose: 'compact', usage: { inputTokens: 10, outputTokens: 10 } }]);
  });

  it('没有可切分的工具交换时保留历史，不调用摘要模型', async () => {
    const messages: Message[] = [call(['a']), ...Array.from({ length: 6 }, () => user('pending')), result('a')];
    const provider = new FakeProvider([textResponse('unused')]);
    const compacted = await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, new AbortController().signal, 'fake');
    expect(compacted).toBe(messages);
    expect(provider.requests).toHaveLength(0);
  });

  it('摘要模型失败可以降级，但取消不能被吞掉并改写历史', async () => {
    const messages = Array.from({ length: 8 }, (_, i) => i % 2 ? assistant('a') : user('u'));
    const controller = new AbortController();
    const provider = new FakeProvider([() => { controller.abort(); throw new Error('cancelled'); }]);
    await expect(new ContextManager({ compactThreshold: 1 }).compact(messages, provider, controller.signal, 'fake')).rejects.toThrow('cancelled');
    expect(messages).toHaveLength(8);
  });
});
