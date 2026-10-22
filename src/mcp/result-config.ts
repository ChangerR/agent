/** MCP 结果配置；全局/项目/会话由插件配置系统合并，新会话生效。 */
import { z } from 'zod';
export const McpResultConfig = z.object({
  maxInlineChars: z.number().int().min(1024).max(1000000).default(24000),
  maxAgeDays: z.number().int().min(0).max(36500).default(30),
  maxStoredBytes: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(256 * 1024 * 1024),
  deduplicate: z.boolean().default(false),
  maxSearchChars: z.number().int().min(8192).max(10000000).default(1000000),
});
export type McpResultOptions = z.input<typeof McpResultConfig>;
