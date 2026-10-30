/** 审批不缓存批准结果；thinking 默认关闭，显式配置仍可覆盖。 */
import { z } from 'zod';
export const ReviewerConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().optional(),
  thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  timeoutMs: z.number().int().min(1).max(300000).default(30000),
  maxRequestBytes: z.number().int().min(1).max(1048576).default(32768),
  maxResponseBytes: z.number().int().min(1).max(65536).default(65536),
  maxOutputTokens: z.number().int().min(1).max(8192).default(8192),
  prefixCache: z
    .object({ enabled: z.boolean().default(false), ttl: z.enum(['5m', '1h']).default('5m') })
    .default({ enabled: false, ttl: '5m' }),
});
