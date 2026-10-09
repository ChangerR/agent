import { expect, it } from 'vitest';
import { AnthropicStreamTranslator } from '../src/providers/anthropic.js';
import { createStrictModelReviewer } from '../src/builtin/reviewer-model/index.js';
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
  const reviewer = createStrictModelReviewer({ provider: { name: 'anthropic-fixture', capabilities: { streaming: true, thinking: true }, async *stream() { yield* events; } }, model: 'fixture' });
  const input: ReviewInput = { cwd: '/fixture', tool: { name: 'test', description: 'test', risk: 'write', inputSchema: {} }, input: {}, userRequest: 'perform fixture', decision: { kind: 'review', source: 'mode', reason: 'fixture' } };
  expect(await reviewer.review(input, new AbortController().signal)).toMatchObject({ decision: 'allow' });
});
it('只有真正的工具块结束产生 tool_use_stop，并保留调用 ID', () => {
  const translator = new AnthropicStreamTranslator();
  translator.push({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-2', name: 'read_file', input: {} } } as never);
  expect(translator.push({ type: 'content_block_stop', index: 2 } as never)).toEqual([{ type: 'tool_use_stop', id: 'call-2' }]);
});
