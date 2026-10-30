import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ModelBroker } from '../desktop/remote/broker.js';
import { BridgeProvider, type BridgeTransport } from '../src/providers/bridge.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import { collectStreamAsync } from '../src/core/protocol/types.js';
import type { Provider, ChatRequest } from '../src/core/provider.js';
import { providerSemantics, type ProviderDescription } from '../src/providers/semantics.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';

const req: ChatRequest = {
  model: 'test-model',
  system: 'test',
  messages: [],
  tools: [],
  maxTokens: 32,
};
function setup(provider: Provider) {
  const broker = new ModelBroker();
  const d = broker.add(provider, {
    name: 'main-route',
    kind: 'fake',
    routeId: 'fixture',
    endpoint: 'https://invalid.example',
    models: { 'test-model': { contextWindow: 10000, maxOutputTokens: 128 } },
    capabilities: { 'test-model': { api: 'generic' } },
  });
  broker.activate();
  const transport: BridgeTransport = {
    request: async <T>(m: string, p: unknown) => (await broker.handle(m, p)) as T,
  };
  return { broker, provider: new BridgeProvider(transport, d), d };
}
describe('本地 Broker 与规范化 Provider 代理', () => {
  it('文本、完整工具参数、来源和尾随 usage 经过代理保持原语义', async () => {
    const fake = new FakeProvider([
      toolUseResponse([{ id: 'tool-1', name: 'read_file', input: { path: '中文.md' } }]),
    ]);
    const s = setup(fake);
    try {
      const response = await collectStreamAsync(
        s.provider.stream(req, new AbortController().signal),
      );
      expect(response.stopped).toBe(true);
      expect(response.stopReason).toBe('tool_use');
      expect(response.message.content).toEqual([
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '中文.md' } },
      ]);
      expect(response.usage.outputTokens).toBe(10);
      expect(fake.requests).toHaveLength(1);
    } finally {
      s.broker.close();
    }
  });
  it('没有 message_stop 的 EOF 明确失败，不把半条响应当成功', async () => {
    const s = setup(
      new FakeProvider([[{ type: 'message_start' }, { type: 'text_delta', text: 'partial' }]]),
    );
    try {
      await expect(
        collectStreamAsync(s.provider.stream(req, new AbortController().signal)),
      ).rejects.toThrow('INCOMPLETE_MODEL_STREAM');
    } finally {
      s.broker.close();
    }
  });
  it('拒绝未批准的 route、模型和预算，不启动 Provider', async () => {
    const fake = new FakeProvider([textResponse('ok')]),
      s = setup(fake);
    try {
      await expect(
        s.broker.handle('model.open', { callId: randomUUID(), handle: randomUUID(), request: req }),
      ).rejects.toThrow('ROUTE_UNAVAILABLE');
      await expect(
        s.broker.handle('model.open', {
          callId: randomUUID(),
          handle: s.d.handle,
          request: { ...req, model: 'other' },
        }),
      ).rejects.toThrow('ROUTE_UNAVAILABLE');
      await expect(
        s.broker.handle('model.open', {
          callId: randomUUID(),
          handle: s.d.handle,
          request: { ...req, maxTokens: 999 },
        }),
      ).rejects.toThrow('REQUEST_LIMIT');
      expect(fake.requests).toHaveLength(0);
    } finally {
      s.broker.close();
    }
  });
  it('取消先于 open 也生效，旧 callId 不能复活', async () => {
    const s = setup(new FakeProvider([textResponse('should not run')])),
      callId = randomUUID();
    try {
      await s.broker.handle('model.cancel', { callId });
      await expect(
        s.broker.handle('model.open', { callId, handle: s.d.handle, request: req }),
      ).rejects.toThrow('ABORTED');
    } finally {
      s.broker.close();
    }
  });
  it('流中取消中止本地 Provider，等待的 next 不会卡到超时', async () => {
    let aborted = false;
    const fixture: Provider = {
      name: 'fixture',
      capabilities: { thinking: false, streaming: true },
      async *stream(_req, signal) {
        yield { type: 'message_start' };
        await new Promise<void>((r) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              r();
            },
            { once: true },
          ),
        );
        throw new Error('ABORTED');
      },
    };
    const s = setup(fixture),
      cancel = new AbortController();
    try {
      const collecting = collectStreamAsync(s.provider.stream(req, cancel.signal));
      setTimeout(() => cancel.abort(), 20);
      await expect(collecting).rejects.toThrow('ABORTED');
      expect(aborted).toBe(true);
    } finally {
      s.broker.close();
    }
  });
  it('完成的模型调用 ID 不能重放，不重复消费 Provider', async () => {
    const fake = new FakeProvider([textResponse('ok')]),
      s = setup(fake),
      callId = randomUUID();
    try {
      await s.broker.handle('model.open', { callId, handle: s.d.handle, request: req });
      let batch: { done: boolean };
      do {
        batch = (await s.broker.handle('model.next', { callId })) as { done: boolean };
      } while (!batch.done);
      await expect(
        s.broker.handle('model.open', { callId, handle: s.d.handle, request: req }),
      ).rejects.toThrow('CALL_CONFLICT');
      expect(fake.requests).toHaveLength(1);
    } finally {
      s.broker.close();
    }
  });
  it('路由版本不匹配在请求模型前失败', async () => {
    const fake = new FakeProvider([textResponse('no')]),
      s = setup(fake);
    try {
      await expect(
        s.broker.handle('model.open', {
          callId: randomUUID(),
          handle: s.d.handle,
          revision: 1,
          request: req,
        }),
      ).rejects.toThrow('ROUTE_STALE');
      expect(fake.requests).toHaveLength(0);
    } finally {
      s.broker.close();
    }
  });
  it.each(['openai', 'anthropic'] as const)(
    '%s 的同步能力与 wire 字节估算复用原 adapter',
    (kind) => {
      const endpoint = kind === 'openai' ? 'https://api.deepseek.com' : 'https://api.anthropic.com';
      const original =
        kind === 'openai'
          ? new OpenAIProvider({ baseURL: endpoint })
          : new AnthropicProvider({ baseURL: endpoint });
      const d: ProviderDescription = {
        name: kind,
        handle: randomUUID(),
        routeId: original.routeId,
        kind,
        endpoint,
        models: { 'test-model': { contextWindow: 10000, maxOutputTokens: 128 } },
        capabilities: { 'test-model': original.modelCapabilities('test-model') },
      };
      const semantics = providerSemantics(d);
      expect(semantics.normalizeRequest?.(req)).toEqual(original.normalizeRequest(req));
      expect(semantics.requestBytes?.(req)).toBe(original.requestBytes(req));
      expect(semantics.estimateRequest?.(req)).toEqual(original.estimateRequest(req));
    },
  );
});
