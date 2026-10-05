import { describe, expect, it } from 'vitest';
import { complete } from '../src/core/provider.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { EventBus } from '../src/core/events.js';

describe('模型请求记录与辅助用量', () => {
  it('快照与调用方、脚本的修改互相独立，非流式调用保留归一化用量', async () => {
    const request = { model: 'fake', system: 'test', messages: [{ role: 'user' as const, content: 'original' }], tools: [] };
    const events = new EventBus();
    const snapshots: unknown[] = [];
    const usage: unknown[] = [];
    events.on('model_request', (e) => snapshots.push(e.request));
    events.on('model_usage', (e) => usage.push(e));
    const provider = new FakeProvider([(req) => { req.messages[0].content = 'mutated'; return textResponse('ok'); }]);
    const result = await complete(provider, request, new AbortController().signal, { events, purpose: 'judge' });
    expect(result).toMatchObject({ text: 'ok', usage: { inputTokens: 10, outputTokens: 10 } });
    expect(provider.requests[0].messages[0].content).toBe('original');
    expect(snapshots).toMatchObject([{ messages: [{ content: 'original' }] }]);
    expect(usage).toMatchObject([{ purpose: 'judge', usage: { inputTokens: 10, outputTokens: 10 } }]);
  });
});
