/**
 * 会话 JSON 的 zod 校验。
 *
 * safeParse 只用来判断结构是否可接受。调用方必须返回 JSON.parse 的原对象，
 * 不能返回 zod 的 data：默认值、剥离未知字段都会丢掉 signature、打码 data 和 tool input。
 */
import { PlanSchema } from '../plan.js';
import { z, type ZodError } from 'zod';

const TextBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const ThinkingBlockSchema = z
  .object({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string().optional(),
  })
  .passthrough();

const RedactedThinkingBlockSchema = z
  .object({
    type: z.literal('redacted_thinking'),
    data: z.string(),
  })
  .passthrough();

const ToolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
    replay: z
      .object({
        arguments: z.string().max(2000000),
        inputHash: z.string().regex(/^[a-f0-9]{64}$/),
        routeId: z.string().min(1),
        model: z.string().min(1),
      })
      .optional(),
  })
  .passthrough();

const ToolResultBlockSchema = z
  .object({
    type: z.literal('tool_result'),
    toolUseId: z.string().min(1),
    content: z.string(),
    isError: z.boolean().optional(),
  })
  .passthrough();

const AssistantBlockSchema = z.union([
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
]);

const UserBlockSchema = z.union([TextBlockSchema, ToolResultBlockSchema]);

export const MessageSchema = z.union([
  z
    .object({
      role: z.literal('user'),
      source: z.enum(['summary', 'delegation', 'subagent', 'tool', 'runtime']).optional(),
      content: z.union([z.string(), z.array(UserBlockSchema)]),
    })
    .passthrough(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.array(AssistantBlockSchema),
    })
    .passthrough(),
]);

export const SessionRulesSchema = z
  .object({
    allow: z.array(z.string()),
    ask: z.array(z.string()),
    deny: z.array(z.string()),
  })
  .passthrough();

const nonnegativeInt = z.number().int().nonnegative();

export const UsageSchema = z
  .object({
    inputTokens: nonnegativeInt,
    outputTokens: nonnegativeInt,
    cacheReadTokens: nonnegativeInt,
    cacheWriteTokens: nonnegativeInt,
    cacheWriteTokensByTtl: z.record(z.enum(['5m', '1h', '30m', '12h']), nonnegativeInt).optional(),
  })
  .passthrough();

/** 列表只看元数据，不要求消息体合法。schemaVersion 只要是正整数。 */
export const SessionMetaSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    cwd: z.string(),
    model: z.string(),
  })
  .passthrough();

const SessionBodySchema = SessionMetaSchema.extend({
  revision: nonnegativeInt.safe(),
  provider: z.string().min(1),
  endpointKey: z.string().min(1),
  thinking: z.enum(['off', 'low', 'medium', 'high']),
  permissionMode: z.enum(['ask', 'auto', 'yolo']),
  sessionRules: SessionRulesSchema,
  usage: UsageSchema,
  stats: z
    .object({
      messages: nonnegativeInt,
      estimatedTokens: nonnegativeInt,
      runs: nonnegativeInt,
    })
    .passthrough(),
  messages: z.array(MessageSchema),
}).passthrough();

export const SessionFileSchema = SessionBodySchema.extend({
  plan: PlanSchema.optional(),
  schemaVersion: z.literal(2),
  runtime: z.object({ schemaVersion: z.literal(1) }).passthrough(),
  policy: z
    .object({
      id: z.string().min(1),
      version: z.string().min(1),
      stateSchemaVersion: z.number().int().positive(),
    })
    .passthrough(),
  pluginStates: z.record(
    z
      .object({
        schemaVersion: z.number().int().positive(),
        requiredForSafety: z.boolean().optional(),
        data: z.unknown(),
      })
      .passthrough(),
  ),
  agents: z
    .object({
      owner: z
        .object({ rootSessionId: z.string(), parentAgentId: z.string(), agentId: z.string() })
        .optional(),
      children: z
        .array(z.lazy(() => SubagentRecordSchema))
        .max(64)
        .optional(),
      agent: z.lazy(() => SubagentRecordSchema).optional(),
    })
    .optional(),
}).refine((file) => file.messages.length > 0 || Boolean(file.agents?.owner && file.agents.agent), {
  path: ['messages'],
  message: '只有带完整 ownership 的子会话可以保存空历史',
});

const SubagentRecordSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  rootSessionId: z.string().min(1),
  parentAgentId: z.string().min(1),
  name: z.string().max(80),
  depth: z.number().int().positive(),
  context: z.enum(['fresh', 'snapshot']),
  readOnly: z.boolean(),
  allowedTools: z.array(z.string()).optional(),
  runs: z
    .array(
      z.object({
        runId: z.string().min(1),
        task: z.string().max(16384),
        status: z.enum([
          'queued',
          'running',
          'cancelling',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
          'limited',
        ]),
        activity: z.string(),
        output: z.string().max(1048576),
        truncated: z.boolean(),
        usage: UsageSchema,
        turns: z.number().int().nonnegative(),
        error: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .max(64),
});

/** 最多展示 3 条 issue，其余用「…还有 N 处」收束。 */
export function formatInvalidSchema(path: string, error: ZodError): string {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const loc = issue.path.length > 0 ? issue.path.join('.') : 'root';
    return `${loc}: ${issue.message}`;
  });
  const rest = error.issues.length - shown.length;
  const tail = rest > 0 ? ` …还有 ${rest} 处` : '';
  const body = shown.length > 0 ? ` ${shown.join('；')}` : '';
  return `会话文件结构不合法: ${path}${body}${tail}`;
}
