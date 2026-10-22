/** 规划调用独立路由配置；省略可选字段时继承主模型，不向编辑层回填默认值。 */
import { z } from 'zod';
export const PlanningConfigSchema = z.object({
  mode: z.enum(['auto', 'only', 'off']).default('auto'),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(['off', 'low', 'medium', 'high']).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRequestBytes: z.number().int().positive().optional(),
});
