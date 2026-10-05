/**
 * 会话 JSON 的 zod 校验。
 *
 * safeParse 只用来判断结构是否可接受。调用方必须返回 JSON.parse 的原对象，
 * 不能返回 zod 的 data：默认值、剥离未知字段都会丢掉 signature、打码 data 和 tool input。
 */
import { z, type ZodError } from 'zod';

const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).passthrough();

const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
}).passthrough();

const RedactedThinkingBlockSchema = z.object({
  type: z.literal('redacted_thinking'),
  data: z.string(),
}).passthrough();

const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
}).passthrough();

const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string().min(1),
  content: z.string(),
  isError: z.boolean().optional(),
}).passthrough();

const AssistantBlockSchema = z.union([
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
]);

const UserBlockSchema = z.union([TextBlockSchema, ToolResultBlockSchema]);

export const MessageSchema = z.union([
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(UserBlockSchema)]),
  }).passthrough(),
  z.object({
    role: z.literal('assistant'),
    content: z.array(AssistantBlockSchema),
  }).passthrough(),
]);

export const SessionRulesSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
}).passthrough();

const nonnegativeInt = z.number().int().nonnegative();

export const UsageSchema = z.object({
  inputTokens: nonnegativeInt,
  outputTokens: nonnegativeInt,
  cacheReadTokens: nonnegativeInt,
  cacheWriteTokens: nonnegativeInt,
}).passthrough();

/** 列表只看元数据，不要求消息体合法。schemaVersion 只要是正整数。 */
export const SessionMetaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cwd: z.string(),
  model: z.string(),
}).passthrough();

export const SessionFileSchema = SessionMetaSchema.extend({
  schemaVersion: z.literal(1),
  thinking: z.enum(['off', 'low', 'medium', 'high']),
  permissionMode: z.enum(['ask', 'auto', 'yolo']),
  sessionRules: SessionRulesSchema,
  usage: UsageSchema,
  stats: z.object({
    messages: nonnegativeInt,
    estimatedTokens: nonnegativeInt,
    runs: nonnegativeInt,
  }).passthrough(),
  messages: z.array(MessageSchema).min(1),
}).passthrough();

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
