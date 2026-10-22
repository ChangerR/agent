import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../src/core/loop.js';
import { ContextManager } from '../src/core/context/coordinator.js';
import { estimateRequestTokens } from '../src/core/context/tokens.js';
import { ToolRegistry } from '../src/core/registry.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { SummaryCompactor } from '../src/builtin/compaction-summary/implementation.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import type { ChatRequest } from '../src/core/provider.js';

function fixture({ system = 'stable', schema = {}, output = 500, toolResult = '' } = {}) {
  const tools = new ToolRegistry();
  tools.register({
    name: 'large',
    description: 'fixture',
    inputSchema: { type: 'object', ...schema },
    risk: 'read',
    execute: async () => ({ content: toolResult }),
  });
  const provider = new FakeProvider(
    toolResult
      ? [toolUseResponse([{ id: 'read', name: 'large', input: {} }]), textResponse('unreachable')]
      : [textResponse('ok')],
  );
  const loop = new AgentLoop({
    provider,
    model: 'small',
    modelInfo: () => ({ contextWindow: 3000, maxOutputTokens: output }),
    tools,
    context: new ContextManager({ compactThreshold: 100000, compactor: new SummaryCompactor() }),
    hooks: new HookRunner(),
    events: new EventBus(),
    systemPrompt: system,
    maxTurns: 3,
    cwd: process.cwd(),
    policy: {
      decide: () => ({ kind: 'allow', source: 'config', reason: 'fixture authorization' }),
    },
  });
  return { loop, provider };
}

describe('完整请求预算', () => {
  it.each([
    { system: '文'.repeat(2000) },
    { schema: { description: 'tool schema '.repeat(1000) } },
    { output: 2900 },
  ])('少量消息也不能忽略 system、schema 或输出预留 %j', async (options) => {
    const { loop, provider } = fixture(options);
    const result = await loop.run('short input');
    expect(result.reason).toBe('error');
    expect(result.error).toContain('context_budget_exceeded');
    expect(provider.requests).toHaveLength(0);
    await loop.dispose();
  });

  it('大工具结果后的下一次模型请求被预算门拦截，不发送超窗请求', async () => {
    const { loop, provider } = fixture({ toolResult: 'x'.repeat(20000) });
    const result = await loop.run('read');
    expect(result.reason).toBe('error');
    expect(result.error).toContain('context_budget_exceeded');
    expect(provider.requests).toHaveLength(1);
    expect(estimateRequestTokens(provider.requests[0]).totalTokens).toBeLessThanOrEqual(3000);
    expect(JSON.stringify(loop.getMessages())).toContain('tool_result');
    await loop.dispose();
  });

  it('预算足够的普通主循环正常完成', async () => {
    const { loop, provider } = fixture();
    expect((await loop.run('hello')).reason).toBe('completed');
    expect(provider.requests).toHaveLength(1);
    await loop.dispose();
  });

  it('适配器预算使用最终协议，包含 Anthropic thinking 扩展输出', () => {
    const req: ChatRequest = {
      model: 'fixture',
      system: 'stable',
      tools: [],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '中'.repeat(2000) },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
      maxTokens: 1000,
      thinking: 'high',
    };
    const anthropic = new AnthropicProvider({ apiKey: 'offline' });
    expect(anthropic.estimateRequest(req).outputTokens).toBe(32768 + 4096);
    const generic = new OpenAIProvider({ baseURL: 'https://generic.invalid' });
    const deepseek = new OpenAIProvider({ baseURL: 'https://api.deepseek.com' });
    const withTools = { ...req, tools: [{ name: 't', description: '', inputSchema: {} }] };
    expect(deepseek.estimateRequest(withTools).inputTokens).toBeGreaterThan(
      generic.estimateRequest(withTools).inputTokens + 3000,
    );
  });
});
