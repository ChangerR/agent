/**
 * thinking 等级的 provider 参数映射测试（离线，只测纯函数）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatRequest } from '../src/core/provider.js';
import { THINKING_BUDGETS, toAnthropicParams } from '../src/providers/anthropic.js';
import { toOpenAIParams } from '../src/providers/openai.js';

const baseReq: ChatRequest = {
  model: 'test-model',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxTokens: 8192,
};

describe('Anthropic thinking 映射', () => {
  it('off / 不传：无 thinking 参数', () => {
    expect(toAnthropicParams(baseReq)).not.toHaveProperty('thinking');
    expect(toAnthropicParams({ ...baseReq, thinking: 'off' })).not.toHaveProperty('thinking');
  });

  it('low/medium/high：budget_tokens 映射且 max_tokens 一定大于 budget', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      const params = toAnthropicParams({ ...baseReq, thinking: level });
      expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: THINKING_BUDGETS[level] });
      expect(params.max_tokens).toBeGreaterThan(THINKING_BUDGETS[level]);
    }
  });

  it('maxTokens 已经很大时不被强行抬高', () => {
    const params = toAnthropicParams({ ...baseReq, thinking: 'low', maxTokens: 64_000 });
    expect(params.max_tokens).toBe(64_000);
  });
});

describe('OpenAI thinking 映射', () => {
  it('off / 不传：无 reasoning_effort', () => {
    expect(toOpenAIParams(baseReq)).not.toHaveProperty('reasoning_effort');
    expect(toOpenAIParams({ ...baseReq, thinking: 'off' })).not.toHaveProperty('reasoning_effort');
  });

  it('low/medium/high：映射为 reasoning_effort', () => {
    const params = toOpenAIParams({ ...baseReq, thinking: 'high' });
    expect((params as unknown as Record<string, unknown>).reasoning_effort).toBe('high');
  });
});
