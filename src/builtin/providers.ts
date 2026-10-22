/** 默认模型适配器；同一插件能力接口用于内置与外部实现。 */
import type { AgentConfig } from '../core/config.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import {
  FakeProvider,
  textResponse,
  toolUseResponse,
  type ScriptedResponse,
} from '../providers/fake.js';
import { definePlugin } from '../sdk/index.js';
import { z } from 'zod';
import type { ModelCapabilities } from '../core/provider.js';
import { ProviderModelsSchema } from './provider-config.js';

function demoScript(): ScriptedResponse {
  let called = false;
  let planCall = 0;
  return (req) => {
    if (req.system.startsWith('[agentlab planning:auto]')) {
      const input = req.messages.at(-1)?.content;
      // 离线演示只对明确文件读取展示计划；不冒充真实模型的语义判断。
      if (!/[\w.-]+\.(txt|md|ts|js|json)/i.test(String(input))) return textResponse('null');
      return textResponse(
        JSON.stringify({ goal: '离线规划演示：读取并核对文件', steps: ['读取文件', '核对结果'] }),
      );
    }
    if (req.system.startsWith('[agentlab planning]'))
      return textResponse(
        JSON.stringify({ goal: '离线规划演示：读取并核对文件', steps: ['读取文件', '核对结果'] }),
      );
    const state = [...req.messages]
      .reverse()
      .find((message) => message.role === 'user' && message.source === 'runtime');
    const plan = state
      ? (JSON.parse(state.content as string).plan as import('../core/plan.js').Plan | null)
      : null;
    const history = req.messages.filter(
      (message) => message.role !== 'user' || message.source !== 'runtime',
    );
    if (plan && req.tools.some((tool) => tool.name === 'plan_update')) {
      if (plan.mode === 'only')
        return textResponse('[fake provider] 只规划：请查看计划区；未执行文件操作。');
      const step =
        plan.steps.find((s) => s.status === 'running') ??
        plan.steps.find((s) => s.status === 'pending');
      if (!step) return textResponse('[fake provider] 计划演示已完成。');
      const id = 'demo-plan-' + ++planCall;
      const last = history.at(-1);
      if (
        Array.isArray(last?.content) &&
        last.content.some((b) => b.type === 'tool_result' && b.isError)
      )
        return textResponse('[fake provider] 操作未成功，保留阻塞状态。');
      if (step.status !== 'running')
        return toolUseResponse([
          {
            id,
            name: 'plan_update',
            input: { revision: plan.revision, stepId: step.id, status: 'running' },
          },
        ]);
      const previous = history.at(-2);
      const read =
        previous?.role === 'assistant' &&
        previous.content.some((b) => b.type === 'tool_use' && b.name === 'read_file');
      if (read)
        return toolUseResponse([
          {
            id,
            name: 'plan_update',
            input: {
              revision: plan.revision,
              stepId: step.id,
              status: 'completed',
              evidence: 'read_file 已返回文件内容；离线演示仅核对读取链路',
            },
          },
        ]);
      const source = req.messages.find(
        (m) => m.role === 'user' && typeof m.content === 'string',
      )?.content;
      const path = /[\w.-]+\.(txt|md|ts|js|json)/i.exec(String(source))?.[0] ?? 'README.md';
      return toolUseResponse([{ id, name: 'read_file', input: { path } }]);
    }
    const last = history.at(-1);
    const text =
      typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    if (!called) {
      const match = /[\w.-]+\.(txt|md|ts|js|json)/i.exec(text);
      if (match) {
        called = true;
        return toolUseResponse([{ id: 'demo-1', name: 'read_file', input: { path: match[0] } }]);
      }
    }
    called = false;
    return textResponse(
      '[fake provider] 我收到了你的消息。这是一个离线演示：在消息里提到一个真实文件名（如 README.md），我会演示一次 read_file 工具调用的完整链路。',
    );
  };
}
export function providerPlugins(config: AgentConfig) {
  return [
    definePlugin({
      manifest: { id: 'agentlab.provider-anthropic', version: '1.0.0', apiVersion: 1 },
      config: {
        schema: z.object({ models: ProviderModelsSchema }),
        ownedFields: ['models'],
        defaults: {},
        applyMode: 'newSession',
      },
      setup(ctx) {
        const apiKeyEnv = config.provider === 'anthropic' ? config.apiKeyEnv : undefined;
        ctx.provide.provider(
          'anthropic',
          new AnthropicProvider({
            models: ctx.config.value.models as Record<string, ModelCapabilities>,
            apiKeyEnv,
            apiKey: process.env[apiKeyEnv ?? 'ANTHROPIC_API_KEY'],
            baseURL: config.provider === 'anthropic' ? config.baseURL : undefined,
            cacheControl: config.cache.enabled,
          }),
        );
      },
    }),
    definePlugin({
      manifest: { id: 'agentlab.provider-openai', version: '1.0.0', apiVersion: 1 },
      config: {
        schema: z.object({
          dialect: z.enum(['auto', 'generic', 'deepseek']).default('auto'),
          models: ProviderModelsSchema,
        }),
        ownedFields: ['dialect', 'models'],
        defaults: {},
        applyMode: 'newSession',
      },
      setup(ctx) {
        const apiKeyEnv = config.provider === 'openai' ? config.apiKeyEnv : undefined;
        ctx.provide.provider(
          'openai',
          new OpenAIProvider({
            models: ctx.config.value.models as Record<string, ModelCapabilities>,
            dialect: ctx.config.value.dialect as 'auto' | 'generic' | 'deepseek',
            apiKeyEnv,
            apiKey: process.env[apiKeyEnv ?? 'OPENAI_API_KEY'],
            baseURL: config.provider === 'openai' ? config.baseURL : undefined,
          }),
        );
      },
    }),
    definePlugin({
      manifest: { id: 'agentlab.provider-fake', version: '1.0.0', apiVersion: 1 },
      setup(ctx) {
        ctx.provide.provider('fake', new FakeProvider([demoScript()]));
      },
    }),
  ];
}
