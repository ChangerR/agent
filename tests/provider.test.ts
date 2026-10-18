import { describe, expect, it } from 'vitest';
import { complete } from '../src/core/provider.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { EventBus } from '../src/core/events.js';
import type { ChatRequest } from '../src/core/provider.js';
import { buildAnthropicBody } from '../src/providers/anthropic.js';
import { toOpenAIParams } from '../src/providers/openai.js';

describe('汇报请求禁用工具的协议转换', () => {
  const request: ChatRequest = {
    model: 'fake-model',
    system: 'test',
    thinking: 'low',
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }],
    messages: [
      { role: 'user', content: '读取文件' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'read-1', content: 'verified' }],
      },
      { role: 'user', source: 'tool', content: '仅汇报已有结果' },
    ],
    cache: { system: true, tools: true, messageBreakpoints: [2] },
  };
  it.each([undefined, 'auto', 'none'] as const)(
    'Anthropic toolChoice=%s 保留工具定义、历史、思考与缓存断点',
    (toolChoice) => {
      const baseline = buildAnthropicBody(request);
      const actual = buildAnthropicBody({ ...request, toolChoice });
      expect(actual).toEqual({
        ...baseline,
        body: { ...baseline.body, ...(toolChoice ? { tool_choice: { type: toolChoice } } : {}) },
      });
    },
  );
  it.each([undefined, 'auto', 'none'] as const)(
    'OpenAI toolChoice=%s 保留工具定义与成对历史',
    (toolChoice) => {
      const baseline = toOpenAIParams(request);
      expect(toOpenAIParams({ ...request, toolChoice })).toEqual({
        ...baseline,
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      });
    },
  );
});

describe('模型请求记录与辅助用量', () => {
  it('快照与调用方、脚本的修改互相独立，非流式调用保留归一化用量', async () => {
    const request = {
      model: 'fake',
      system: 'test',
      messages: [{ role: 'user' as const, content: 'original' }],
      tools: [],
    };
    const events = new EventBus();
    const snapshots: unknown[] = [];
    const usage: unknown[] = [];
    events.on('model_request', (e) => snapshots.push(e.request));
    events.on('model_usage', (e) => usage.push(e));
    const provider = new FakeProvider([
      (req) => {
        req.messages[0].content = 'mutated';
        return textResponse('ok');
      },
    ]);
    const result = await complete(provider, request, new AbortController().signal, {
      events,
      purpose: 'judge',
    });
    expect(result).toMatchObject({ text: 'ok', usage: { inputTokens: 10, outputTokens: 10 } });
    expect(provider.requests[0].messages[0].content).toBe('original');
    expect(snapshots).toMatchObject([{ messages: [{ content: 'original' }] }]);
    expect(usage).toMatchObject([
      { purpose: 'judge', usage: { inputTokens: 10, outputTokens: 10 } },
    ]);
  });
});
