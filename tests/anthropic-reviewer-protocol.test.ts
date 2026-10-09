import { expect, it } from 'vitest';
import { AnthropicStreamTranslator } from '../src/providers/anthropic.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/index.js';
import type { ReviewInput } from '../src/sdk/index.js';
it('Anthropic 文本/思考块结束不被误报为 tool_use_stop，严格 reviewer 可处理真实规范事件', async () => {
  const wire = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '{"decision":"allow","reasonCode":"verified","reason":"verified fixture"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ];
  const translator = new AnthropicStreamTranslator(); const events = wire.flatMap(event => translator.push(event as never));
  expect(events.some(event => event.type === 'tool_use_stop')).toBe(false);
  const reviewer = createModelReviewer({ provider: { name: 'anthropic-fixture', capabilities: { streaming: true, thinking: true }, async *stream() { yield* events; } }, model: 'fixture' });
  const input: ReviewInput = { cwd: '/fixture', tool: { name: 'test', description: 'test', risk: 'write', inputSchema: {} }, input: {}, userRequest: 'perform fixture', decision: { kind: 'review', source: 'mode', reason: 'fixture' } };
  expect(await reviewer.review(input, new AbortController().signal)).toMatchObject({ decision: 'allow' });
});
it('只有真正的工具块结束产生 tool_use_stop，并保留调用 ID', () => {
  const translator = new AnthropicStreamTranslator();
  translator.push({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-2', name: 'read_file', input: {} } } as never);
  expect(translator.push({ type: 'content_block_stop', index: 2 } as never)).toEqual([{ type: 'tool_use_stop', id: 'call-2' }]);
});

it('Anthropic wire index 将交错工具参数绑定到各自真实调用 ID', async () => {
  const { collectStreamAsync } = await import('../src/core/protocol/types.js');
  const translator = new AnthropicStreamTranslator();
  const wire = [
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'a', name: 'read_file', input: {} } },
    { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'b', name: 'read_file', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
    { type: 'content_block_stop', index: 2 },
  ];
  const events = wire.flatMap(event => translator.push(event as never));
  expect(events.filter(event => event.type === 'tool_use_delta').map(event => event.id)).toEqual(['a', 'b', 'a']);
  const result = await collectStreamAsync((async function* () { yield* events; })());
  expect(result.message.content).toEqual([
    { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } },
    { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b' } },
  ]);
});
it('Anthropic 缺少调用身份、未知 index 与非工具 JSON 增量均报错', () => {
  const translator = new AnthropicStreamTranslator();
  expect(() => translator.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'read_file', input: {} } } as never)).toThrow('requires an ID');
  expect(() => translator.push({ type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '{}' } } as never)).toThrow('Unknown Anthropic');
  expect(() => translator.push({ type: 'content_block_stop', index: 7 } as never)).toThrow('Unknown Anthropic');
  translator.push({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } as never);
  expect(() => translator.push({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } as never)).toThrow('non-tool');
});
