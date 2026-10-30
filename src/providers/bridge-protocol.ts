import { z } from 'zod';
import { ModelInfoSchema } from '../core/config.js';
import type { ChatRequest } from '../core/provider.js';
import type { StreamEvent } from '../core/protocol/types.js';
import type { ProviderDescription } from './semantics.js';

const caps = z
  .object({
    api: z.enum(['chat-completions', 'messages', 'generic']),
    thinkingLevels: z.array(z.enum(['off', 'low', 'medium', 'high'])).optional(),
    rawToolArguments: z.boolean().optional(),
    prefixCompaction: z.boolean().optional(),
    outputParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
    thinkingMode: z.enum(['budget', 'adaptive']).optional(),
    offEffort: z.literal('none').optional(),
  })
  .strict();
export const descriptionSchema: z.ZodType<ProviderDescription, z.ZodTypeDef, unknown> = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    name: z.string().min(1).max(64),
    handle: z.string().uuid(),
    kind: z.enum(['openai', 'anthropic', 'fake']),
    routeId: z.string().min(1).max(300),
    endpoint: z.string().max(1000),
    dialect: z.enum(['auto', 'generic', 'deepseek', 'kimi']).optional(),
    cacheControl: z.boolean().optional(),
    models: z.record(ModelInfoSchema),
    capabilities: z.record(caps),
  })
  .strict();
const text = z.object({ type: z.literal('text'), text: z.string() }).strict();
const result = z
  .object({
    type: z.literal('tool_result'),
    toolUseId: z.string(),
    content: z.string(),
    isError: z.boolean().optional(),
  })
  .strict();
const assistantBlock = z.discriminatedUnion('type', [
  text,
  z
    .object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() })
    .strict(),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool_use'),
      id: z.string(),
      name: z.string(),
      input: z.union([
        z.null(),
        z.boolean(),
        z.number(),
        z.string(),
        z.array(z.unknown()),
        z.record(z.unknown()),
      ]),
      replay: z
        .object({
          arguments: z.string(),
          inputHash: z.string(),
          routeId: z.string(),
          model: z.string(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export const chatSchema: z.ZodType<ChatRequest, z.ZodTypeDef, unknown> = z
  .object({
    model: z.string().min(1).max(200),
    system: z.string(),
    systemSegments: z
      .array(z.object({ text: z.string(), stable: z.boolean() }).strict())
      .optional(),
    messages: z
      .array(
        z.union([
          z
            .object({
              role: z.literal('user'),
              content: z.union([z.string(), z.array(z.union([text, result]))]),
              source: z.enum(['summary', 'delegation', 'subagent', 'tool', 'runtime']).optional(),
            })
            .strict(),
          z.object({ role: z.literal('assistant'), content: z.array(assistantBlock) }).strict(),
        ]),
      )
      .max(100000),
    tools: z
      .array(
        z
          .object({ name: z.string(), description: z.string(), inputSchema: z.record(z.unknown()) })
          .strict(),
      )
      .max(2000),
    toolChoice: z.enum(['auto', 'none']).optional(),
    maxTokens: z.number().int().positive().optional(),
    thinking: z.enum(['off', 'low', 'medium', 'high']).optional(),
    replayToolArguments: z.boolean().optional(),
    cache: z
      .object({
        system: z.boolean().optional(),
        tools: z.boolean().optional(),
        messageBreakpoints: z.array(z.number().int().nonnegative()).optional(),
        ttl: z.enum(['5m', '1h']).optional(),
        staticTtl: z.enum(['5m', '1h']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .transform((value) => value as ChatRequest);
export const streamSchema: z.ZodType<StreamEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message_start') }).strict(),
  z.object({ type: z.literal('text_delta'), text: z.string() }).strict(),
  z.object({ type: z.literal('thinking_delta'), text: z.string() }).strict(),
  z.object({ type: z.literal('signature_delta'), signature: z.string() }).strict(),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }).strict(),
  z
    .object({
      type: z.literal('tool_use_start'),
      id: z.string(),
      name: z.string(),
      source: z.object({ routeId: z.string(), model: z.string() }).strict().optional(),
    })
    .strict(),
  z.object({ type: z.literal('tool_use_delta'), id: z.string(), input: z.string() }).strict(),
  z.object({ type: z.literal('tool_use_stop'), id: z.string() }).strict(),
  z
    .object({
      type: z.literal('message_stop'),
      stopReason: z.enum(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence']),
    })
    .strict(),
  z
    .object({
      type: z.literal('usage'),
      inputTokens: z.number().nonnegative().optional(),
      outputTokens: z.number().nonnegative().optional(),
      cacheReadTokens: z.number().nonnegative().optional(),
      cacheWriteTokens: z.number().nonnegative().optional(),
      cacheWriteTokensByTtl: z
        .object({
          '5m': z.number().nonnegative().optional(),
          '1h': z.number().nonnegative().optional(),
          '30m': z.number().nonnegative().optional(),
          '12h': z.number().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
