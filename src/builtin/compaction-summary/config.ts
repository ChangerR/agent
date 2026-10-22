/** 前缀摘要必须显式开启；默认沿用独立转写和厂商原有 thinking 默认。 */
import { z } from 'zod';
export const SummaryConfigSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(['off', 'low', 'medium', 'high']).optional(),
  strategy: z.enum(['isolated', 'prefix']).default('isolated'),
  maxOutputTokens: z.number().int().positive().default(2048),
  maxRequestBytes: z.number().int().positive().optional(),
});
