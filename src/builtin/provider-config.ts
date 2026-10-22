/** 按具体模型覆盖 adapter 能力，不从代理模型名推断实际厂商。 */
import { z } from 'zod';
export const ModelCapabilitiesSchema = z.object({
  api: z.enum(['chat-completions', 'messages', 'generic']),
  thinkingLevels: z.array(z.enum(['off', 'low', 'medium', 'high'])).optional(),
  rawToolArguments: z.boolean().optional(),
  prefixCompaction: z.boolean().optional(),
  outputParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  thinkingMode: z.enum(['budget', 'adaptive']).optional(),
  offEffort: z.literal('none').optional(),
});
export const ProviderModelsSchema = z.record(ModelCapabilitiesSchema).default({});
