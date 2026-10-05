/**
 * Provider 协议翻译测试（离线，只测转换函数）。
 */
import { describe, expect, it } from 'vitest';
import { collectStreamAsync, type Message, type StreamEvent } from '../src/core/protocol/types.js';
import { fromAnthropicEvent, toAnthropicMessages } from '../src/providers/anthropic.js';
import { toOpenAIMessages, OpenAIStreamTranslator } from '../src/providers/openai.js';

describe('Anthropic 消息转换', () => {
  it('tool_use / tool_result 双向对齐', () => {
    const messages: Message[] = [
      { role: 'user', content: '读文件' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'data' }] },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[1].content).toEqual([
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
    ]);
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'data', is_error: undefined }]);
  });

  it('带签名的 thinking 原样回填，打码块只回 data', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看路径', signature: 'sig_abc' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: '好的' },
        ],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[0].content).toEqual([
      { type: 'thinking', thinking: '先看路径', signature: 'sig_abc' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '好的' },
    ]);
  });

  it('没有签名的 thinking 降级为文本', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: '推理过程' }] },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[0].content).toEqual([{ type: 'text', text: '<thinking>推理过程</thinking>' }]);
  });

  it('流式思考：thinking_delta 与 signature_delta 合成带签名的块', async () => {
    const wire = [
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先看' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '路径' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig_' } },
      { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'abc' } },
      { type: 'content_block_stop' },
      {
        type: 'content_block_start',
        content_block: { type: 'redacted_thinking', data: 'opaque' },
      },
      { type: 'content_block_stop' },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    ];
    const events: StreamEvent[] = wire.flatMap((ev) => fromAnthropicEvent(ev as never));
    const { message } = await collectStreamAsync(toAsync(events));
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '先看路径', signature: 'sig_abc' },
      { type: 'redacted_thinking', data: 'opaque' },
    ]);
  });
});

describe('OpenAI 消息转换', () => {
  it('两个工具的参数交错到达，各自保留完整 JSON 与开始顺序', async () => {
    const translator = new OpenAIStreamTranslator();
    const chunks = [
      { choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":' } },
        { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } },
      ] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '"b"}' } },
        { index: 0, function: { arguments: '"a"}' } },
      ] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const { message } = await collectStreamAsync(toAsync(chunks.flatMap((chunk) => translator.translate(chunk as never))));
    expect(message.content).toEqual([
      { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b' } },
    ]);
  });

  it('畸形工具参数不能作为正常输入交给执行层', async () => {
    await expect(collectStreamAsync(toAsync<StreamEvent>([
      { type: 'tool_use_start', id: 'bad', name: 'write_file' },
      { type: 'tool_use_delta', id: 'bad', input: '{"path":' },
      { type: 'tool_use_stop', id: 'bad' },
    ]))).rejects.toThrow('Invalid JSON');
  });

  it('tool_result 拆成独立 tool 消息', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok' }] },
    ];
    const out = toOpenAIMessages(messages);
    expect(out[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
    });
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('流式 chunk 翻译：分片的 tool_calls 正确聚合', async () => {
    const t = new OpenAIStreamTranslator();
    // 模拟 OpenAI 的典型分片：第一片带 id+name，后续只有 arguments 片段
    const chunks = [
      { choices: [{ delta: { content: '我先' }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const events = chunks.flatMap((c) => t.translate(c as never));
    const { message, stopReason } = await collectStreamAsync(toAsync(events));
    expect(stopReason).toBe('tool_use');
    expect(message.content).toEqual([
      { type: 'text', text: '我先' },
      { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } },
    ]);
  });

  it('思考模型：reasoning_content 映射为 thinking_delta', () => {
    const t = new OpenAIStreamTranslator();
    // DeepSeek 思考模式的典型 chunk：推理走 reasoning_content，正文走 content
    const chunks = [
      { choices: [{ delta: { reasoning_content: '让我想想' }, finish_reason: null }] },
      { choices: [{ delta: { content: '答案是42' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const events = chunks.flatMap((c) => t.translate(c as never));
    expect(events).toContainEqual({ type: 'thinking_delta', text: '让我想想' });
    expect(events).toContainEqual({ type: 'text_delta', text: '答案是42' });
    expect(events).toContainEqual({ type: 'message_stop', stopReason: 'end_turn' });
  });
});

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}
