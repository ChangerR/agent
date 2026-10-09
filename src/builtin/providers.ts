/** 默认模型适配器；同一插件能力接口用于内置与外部实现。 */
import type { AgentConfig } from '../core/config.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../providers/fake.js';
import { definePlugin } from '../sdk/index.js';

function demoScript(): ScriptedResponse {
  let called = false;
  return req => {
    const last = req.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    if (!called) {
      const match = /[\w.-]+\.(txt|md|ts|js|json)/i.exec(text);
      if (match) { called = true; return toolUseResponse([{ id: 'demo-1', name: 'read_file', input: { path: match[0] } }]); }
    }
    called = false;
    return textResponse('[fake provider] 我收到了你的消息。这是一个离线演示：在消息里提到一个真实文件名（如 README.md），我会演示一次 read_file 工具调用的完整链路。');
  };
}
export function providerPlugins(config: AgentConfig) {
  return [
    definePlugin({ manifest: { id: 'agentlab.provider-anthropic', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      const apiKeyEnv = config.provider === 'anthropic' ? config.apiKeyEnv : undefined;
      ctx.provide.provider('anthropic', new AnthropicProvider({ apiKeyEnv, apiKey: process.env[apiKeyEnv ?? 'ANTHROPIC_API_KEY'], baseURL: config.provider === 'anthropic' ? config.baseURL : undefined, cacheControl: config.cache.enabled }));
    } }),
    definePlugin({ manifest: { id: 'agentlab.provider-openai', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      const apiKeyEnv = config.provider === 'openai' ? config.apiKeyEnv : undefined;
      ctx.provide.provider('openai', new OpenAIProvider({ apiKeyEnv, apiKey: process.env[apiKeyEnv ?? 'OPENAI_API_KEY'], baseURL: config.provider === 'openai' ? config.baseURL : undefined }));
    } }),
    definePlugin({ manifest: { id: 'agentlab.provider-fake', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.provider('fake', new FakeProvider([demoScript()]));
    } }),
  ];
}
