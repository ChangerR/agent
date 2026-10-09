import type { ModelInfo } from '../../core/config.js';
/** 内置模型规格；可由模型目录配置覆盖。 */
export const MODEL_PRESETS: Record<string, ModelInfo> = {
  'claude-sonnet-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 },
  'claude-opus-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 },
  'claude-haiku-4-5': { contextWindow: 200_000, maxOutputTokens: 64_000 },
  // DeepSeek API 官方模型名：deepseek-flash（即 V4.1-Flash）、deepseek-v4-pro
  'deepseek-flash': { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  'deepseek-v4-pro': { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
  'deepseek-chat': { contextWindow: 65_536, maxOutputTokens: 8192 },
  'deepseek-reasoner': { contextWindow: 65_536, maxOutputTokens: 8192 },
  'gpt-4o': { contextWindow: 128_000, maxOutputTokens: 16_384 },
  'kimi-k2': { contextWindow: 131_072, maxOutputTokens: 8192 },
};
