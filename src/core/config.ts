/**
 * 配置系统：`agent.config.json`（项目级）+ `~/.agent/config.json`（全局级）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const PermissionModeSchema = z.enum(['ask', 'auto', 'yolo']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** 单个模型的规格：上下文窗口与最大输出 token 数 */
export const ModelInfoSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().default(8192),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/**
 * 常见模型的内置规格（可在 agent.config.json 的 models 字段覆盖/补充）。
 * 数值以厂商文档为准，按需调整。
 */
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

export const AgentConfigSchema = z.object({
  provider: z.string().default('anthropic'),
  model: z.string().default('claude-sonnet-4-5'),
  /** OpenAI 兼容端点（provider=openai 时使用） */
  baseURL: z.string().optional(),
  /** API key 从哪个环境变量读，默认按 provider 推断 */
  apiKeyEnv: z.string().optional(),
  permissionMode: PermissionModeSchema.default('ask'),
  /** 危险命令即使 yolo 模式也强制询问 */
  dangerForceAsk: z.boolean().default(true),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], ask: [], deny: [] }),
  maxTurns: z.number().int().positive().default(50),
  /** 上下文压缩阈值（估算 token 数）；模型窗口的 80% 比这更小时，以模型窗口为准 */
  compactThreshold: z.number().int().positive().default(120_000),
  /** 模型规格文件路径（模型名 → { contextWindow, maxOutputTokens }），覆盖 MODEL_PRESETS */
  modelsFile: z.string().default('./models.json'),
  /**
   * auto 模式的 LLM 审批员模型（如 deepseek-flash / claude-haiku-4-5）。
   * auto 模式下写/执行操作先由它判断，明显安全才静默放行；失败或不确定则询问。
   * 项目未设置时继承全局；最终未设置或为空字符串时跟随当前主模型。
   * 项目空字符串可覆盖全局指定的审批模型；切换/恢复主模型时同步跟随。
   */
  judgeModel: z.string().optional(),
  /** 思考等级：off / low / medium / high（可用 /think 切换） */
  thinking: z.enum(['off', 'low', 'medium', 'high']).default('off'),
  /**
   * 提示缓存。enabled 只对认 cache_control 的 Anthropic 官方接口有写入效果；
   * DeepSeek 等兼容端点会拒掉这个字段，应设 enabled: false（provider 也会在 400 后自动降级）。
   * ttl 默认 5 分钟；escalateAfterMs > 0 且上一批工具超过这个时间时，下一轮改用 1 小时。
   */
  cache: z
    .object({
      enabled: z.boolean().default(true),
      ttl: z.enum(['5m', '1h']).default('5m'),
      escalateAfterMs: z.number().int().nonnegative().default(0),
    })
    .default({ enabled: true, ttl: '5m', escalateAfterMs: 0 }),
  mcpConfig: z.string().default('./mcp.json'),
  /** 外部插件入口（ESM 模块路径，默认导出 Plugin） */
  plugins: z.array(z.string()).default([]),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const ModelsFileSchema = z.record(ModelInfoSchema);

/** 加载 models.json（不存在则返回空表，全部由 MODEL_PRESETS 兜底） */
export function loadModelsFile(path: string): Record<string, ModelInfo> {
  if (!existsSync(path)) return {};
  return ModelsFileSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

export const PROJECT_CONFIG = 'agent.config.json';
export const GLOBAL_CONFIG = join(homedir(), '.agent', 'config.json');

function readJson(path: string): unknown {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** 项目级覆盖全局级，均覆盖默认值 */
export function loadConfig(cwd: string): AgentConfig {
  const globalCfg = readJson(GLOBAL_CONFIG) as Record<string, unknown>;
  const projectCfg = readJson(join(cwd, PROJECT_CONFIG)) as Record<string, unknown>;
  const merged = {
    ...globalCfg,
    ...projectCfg,
    permissions: {
      allow: [
        ...(((globalCfg.permissions as Record<string, string[]>)?.allow) ?? []),
        ...(((projectCfg.permissions as Record<string, string[]>)?.allow) ?? []),
      ],
      ask: [
        ...(((globalCfg.permissions as Record<string, string[]>)?.ask) ?? []),
        ...(((projectCfg.permissions as Record<string, string[]>)?.ask) ?? []),
      ],
      deny: [
        ...(((globalCfg.permissions as Record<string, string[]>)?.deny) ?? []),
        ...(((projectCfg.permissions as Record<string, string[]>)?.deny) ?? []),
      ],
    },
  };
  return AgentConfigSchema.parse(merged);
}
