import { describe, expect, it } from 'vitest';
import { collectUserQuotes, ContextManager, findCompactCut, renderTranscript, SUMMARY_MARKER } from '../src/core/context/manager.js';
import { EventBus } from '../src/core/events.js';
import type { Message } from '../src/core/protocol/types.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (ids: string[]): Message => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'read_file', input: { path: id } })) });
const result = (id: string, content = id, isError = false): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content, ...(isError ? { isError: true } : {}) }],
});

const boundarySample = (): Message[] => [
  user('start'),
  assistant('ok'),
  user('read'),
  call(['a', 'b']),
  result('a'),
  result('b'),
  assistant('done'),
  user('next'),
];

const signal = () => new AbortController().signal;

describe('上下文压缩边界', () => {
  it('切点吸附到真实用户轮次之前，保留段以 user 开头时补一条确认', async () => {
    const messages = boundarySample();
    const provider = new FakeProvider([textResponse('summary')]);
    const events = new EventBus();
    const usage: unknown[] = [];
    events.on('model_usage', (e) => usage.push(e));
    const compacted = await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, signal(), 'fake', events);
    expect(compacted).toHaveLength(3);
    expect(compacted[0]).toMatchObject({ role: 'user' });
    expect(String(compacted[0]?.content).startsWith(SUMMARY_MARKER)).toBe(true);
    expect(compacted[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '收到，我会基于上面的摘要继续当前任务。' }] });
    expect(compacted[2]).toEqual(messages[7]);
    expect(usage).toMatchObject([{ purpose: 'compact', usage: { inputTokens: 10, outputTokens: 10 } }]);
  });

  it('送给摘要模型的是按角色渲染的转写，而不是整段 JSON', async () => {
    const messages = boundarySample();
    const provider = new FakeProvider([textResponse('summary')]);
    await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, signal(), 'fake');
    const request = provider.requests[0];
    expect(request?.system).toContain('压缩器');
    expect(request?.system).not.toContain('你是 AgentLab');
    expect(request?.tools).toEqual([]);
    expect(request?.cache).toBeUndefined();
    expect(request?.maxTokens).toBe(2048);
    const prompt = String(request?.messages[0]?.content);
    expect(prompt).toContain('USER: start');
    expect(prompt).toContain('ASSISTANT: ok');
    expect(prompt).toContain('ASSISTANT → read_file#a');
    expect(prompt).toContain('TOOL[read_file#a]');
    expect(prompt).toContain('## 用户目标与约束');
    expect(prompt).not.toContain('"toolUseId"');
    expect(prompt).not.toContain('"role":"user"');
  });

  it('转写里的 $& 按字面量送出', async () => {
    const messages = [user('pay $& now'), assistant('ok'), user('b'), assistant('ok'), user('c'), assistant('ok'), user('d'), assistant('ok'), user('keep')];
    const provider = new FakeProvider([textResponse('summary')]);
    await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, signal(), 'fake');
    expect(String(provider.requests[0]?.messages[0]?.content)).toContain('pay $& now');
  });

  it('thinking 与 signature 不进入转写', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '秘密推理', signature: 'SIGBASE64' },
          { type: 'redacted_thinking', data: 'REDACTEDDATA' },
          { type: 'text', text: '可见正文' },
        ],
      },
    ];
    const transcript = renderTranscript(messages);
    expect(transcript).toContain('可见正文');
    expect(transcript).not.toContain('秘密推理');
    expect(transcript).not.toContain('SIGBASE64');
    expect(transcript).not.toContain('REDACTEDDATA');
  });

  it('工具结果截断时保留头尾，错误结果带失败标记', () => {
    const transcript = renderTranscript([
      call(['a']),
      result('a', `HEAD${'x'.repeat(5000)}TAIL`, true),
    ]);
    expect(transcript).toContain('TOOL[read_file#a] 失败:');
    expect(transcript).toContain('HEAD');
    expect(transcript).toContain('TAIL');
    expect(transcript).toContain('…[省略');
    expect(transcript.length).toBeLessThan(2000);
  });

  it('findCompactCut 只在安全的用户轮次或工具边界上切开', () => {
    expect(findCompactCut(Array.from({ length: 7 }, () => user('x')))).toBe(0);
    expect(findCompactCut(boundarySample())).toBe(7);

    const pending = [call(['a']), ...Array.from({ length: 6 }, () => user('pending')), result('a')];
    expect(findCompactCut(pending)).toBe(0);

    const chain: Message[] = [
      user('goal'),
      assistant('ok'),
      call(['a']),
      result('a'),
      assistant('m1'),
      call(['b']),
      result('b'),
      assistant('m2'),
      call(['c']),
      result('c'),
      assistant('done'),
    ];
    const cut = findCompactCut(chain);
    expect(cut).toBeGreaterThanOrEqual(3);
    expect(chain[cut]?.role === 'user' && typeof chain[cut]?.content !== 'string').toBe(false);
    const spansStart = new Map<string, number>();
    chain.forEach((message, index) => {
      if (typeof message.content === 'string') return;
      for (const block of message.content) {
        if (block.type === 'tool_use') spansStart.set(block.id, index);
        if (block.type === 'tool_result') {
          const start = spansStart.get(block.toolUseId);
          expect(start === undefined || start >= cut || index < cut).toBe(true);
        }
      }
    });
  });

  it('保留段以 assistant 开头时不插入确认', async () => {
    const messages: Message[] = [
      user('goal'),
      assistant('ok'),
      call(['a']),
      result('a'),
      assistant('m1'),
      call(['b']),
      result('b'),
      assistant('m2'),
      call(['c']),
      result('c'),
      assistant('done'),
    ];
    const provider = new FakeProvider([textResponse('summary')]);
    const compacted = await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, signal(), 'fake');
    expect(compacted[0]?.role).toBe('user');
    expect(compacted[1]?.role).toBe('assistant');
    expect(JSON.stringify(compacted[1]?.content)).not.toContain('收到，我会基于上面的摘要继续当前任务。');
    expect(JSON.stringify(compacted)).not.toContain('收到，我会基于上面的摘要继续当前任务。');
  });

  it('摘要失败时仍保留早期用户原话', async () => {
    const messages = [
      user('目标一：保持接口'),
      assistant('ok'),
      user('约束二：不要改签名'),
      assistant('ok'),
      user('继续三'),
      assistant('ok'),
      user('继续四'),
      assistant('ok'),
      user('最后留下'),
    ];
    const provider = new FakeProvider([() => { throw new Error('boom'); }]);
    const compacted = await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, signal(), 'fake');
    const cut = findCompactCut(messages);
    const head = String(compacted[0]?.content);
    expect(head).toContain('摘要生成失败');
    expect(head).toContain('## 早期用户原话（节选）');
    for (const quote of collectUserQuotes(messages.slice(0, cut))) expect(head).toContain(quote);
    const recent = messages.slice(cut);
    expect(compacted).toHaveLength(recent.length + (recent[0]?.role === 'user' ? 2 : 1));
  });

  it('再次压缩时把上一次摘要标成 SUMMARY，不当成用户发言', () => {
    const previous = user(`${SUMMARY_MARKER}\n旧摘要正文UNIQUE`);
    expect(renderTranscript([previous])).toContain('SUMMARY:');
    expect(renderTranscript([previous])).not.toContain('USER:');
    expect(collectUserQuotes([previous, user('real ask')])).toEqual(['real ask']);
  });

  it('没有可切分的工具交换时保留历史，不调用摘要模型', async () => {
    const messages: Message[] = [call(['a']), ...Array.from({ length: 6 }, () => user('pending')), result('a')];
    const provider = new FakeProvider([textResponse('unused')]);
    const compacted = await new ContextManager({ compactThreshold: 1 }).compact(messages, provider, signal(), 'fake');
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
