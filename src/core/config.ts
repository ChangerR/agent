/**
 * 配置系统：`agent.config.json`（项目级）+ `~/.agent/config.json`（全局级）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { resolveAgentPaths, type AgentPaths } from './paths.js';
export { PROJECT_CONFIG, getGlobalConfigPath } from './paths.js';
import { z } from 'zod';
import { SINGLETON_CAPABILITY_KINDS } from '../sdk/capabilities.js';

export const PermissionModeSchema = z.enum(['ask', 'auto', 'yolo']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/** 单个模型的规格：上下文窗口与最大输出 token 数 */
export const ModelInfoSchema = z.object({
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().default(8192),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const AgentConfigSchema = z.object({
  provider: z.string().default('anthropic'),
  model: z.string().default('claude-sonnet-4-5'),
  /** OpenAI 兼容端点（provider=openai 时使用） */
  baseURL: z.string().optional(),
  /** API key 从哪个环境变量读，默认按 provider 推断 */
  apiKeyEnv: z.string().optional(),
  permissionMode: PermissionModeSchema.default('ask'),
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
   * 仅当规则优先策略返回 review 时调用；失败或不确定则询问。
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
  /** 外部插件入口；默认导出 SDK Plugin，enabled=false 在重启后生效。 */
  pluginEntries: z.array(z.union([z.string(), z.object({ entry: z.string(), enabled: z.boolean().default(true) })])).default([]),
  /** 显式选定单例能力；false 禁用可选能力，不隐式选下一个实现。 */
  capabilities: z.record(z.enum(SINGLETON_CAPABILITY_KINDS), z.union([z.string(), z.literal(false)])).default({}),
  pluginConfig: z.record(z.record(z.unknown())).default({}),
  disabledPlugins: z.array(z.string()).default([]),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const ModelsFileSchema = z.record(ModelInfoSchema);

/** 加载 models.json（不存在则返回空表，全部由 MODEL_PRESETS 兜底） */
export function loadModelsFile(path: string): Record<string, ModelInfo> {
  if (!existsSync(path)) return {};
  return ModelsFileSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

export type ConfigScope = 'default' | 'global' | 'project' | 'session';
export interface ConfigValueSource {
  readonly scope: ConfigScope;
  readonly path?: string;
  readonly directory: string;
  /** permissions / capabilities / pluginConfig 可由多个层共同贡献。 */
  readonly contributors?: readonly ConfigValueSource[];
}
export type ConfigSources = Readonly<Record<keyof AgentConfig, ConfigValueSource>>;
export interface LoadedConfig {
  config: AgentConfig;
  paths: AgentPaths;
  sources: ConfigSources;
  /** 文件原始层用于插件配置校验和逐字段来源；绝不改写输入文件。 */
  layers: { global: Record<string, unknown>; project: Record<string, unknown>; session: Partial<AgentConfig> };
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`配置必须是 JSON 对象: ${path}`);
  return value as Record<string, unknown>;
}

/** 项目级覆盖全局级，均覆盖默认值；路径依据声明它的配置层解析。 */
export function loadConfig(cwd: string): AgentConfig {
  return loadConfigWithSources(cwd).config;
}

export function loadConfigWithSources(cwd: string, overrides: Partial<AgentConfig> = {}): LoadedConfig {
  const paths = resolveAgentPaths(cwd);
  const globalRaw = readJson(paths.globalConfigPath);
  const projectRaw = readJson(paths.projectConfigPath);
  const globalCfg = globalRaw;
  const projectCfg = projectRaw;
  const sessionCfg = overrides;
  const merged = {
    ...globalCfg,
    ...projectCfg,
    permissions: Object.fromEntries(['allow', 'ask', 'deny'].map(kind => [kind, [
      ...(((globalCfg.permissions as Record<string, string[]>)?.[kind]) ?? []),
      ...(((projectCfg.permissions as Record<string, string[]>)?.[kind]) ?? []),
    ]])),
    ...sessionCfg,
    capabilities: { ...((globalCfg.capabilities as object) ?? {}), ...((projectCfg.capabilities as object) ?? {}), ...((sessionCfg.capabilities as object) ?? {}) },
    pluginConfig: mergePluginConfig(mergePluginConfig(globalCfg.pluginConfig, projectCfg.pluginConfig), sessionCfg.pluginConfig),
  };
  const config = AgentConfigSchema.parse(merged);
  const scopeSources = {
    default: { scope: 'default', directory: paths.agentHome },
    global: { scope: 'global', path: paths.globalConfigPath, directory: paths.agentHome },
    project: { scope: 'project', path: paths.projectConfigPath, directory: paths.projectRoot },
    session: { scope: 'session', directory: paths.projectRoot },
  } as const;
  const sources = Object.fromEntries(Object.keys(AgentConfigSchema.shape).map(key => {
    const scopes = (['global', 'project', 'session'] as const).filter(scope => Object.hasOwn({ global: globalCfg, project: projectCfg, session: sessionCfg }[scope], key));
    const source: ConfigValueSource = scopeSources[scopes.at(-1) ?? 'default'];
    const contributors = ['capabilities', 'pluginConfig'].includes(key) || key === 'permissions' && !Object.hasOwn(sessionCfg, key)
      ? scopes.map(scope => scopeSources[scope]) : undefined;
    return [key, Object.freeze({ ...source, ...(contributors?.length ? { contributors: Object.freeze(contributors) } : {}) })];
  })) as Record<keyof AgentConfig, ConfigValueSource>;
  const fromSource = (value: string, key: keyof AgentConfig) => isAbsolute(value) ? value : resolve(sources[key].directory, value);
  config.modelsFile = fromSource(config.modelsFile, 'modelsFile');
  config.mcpConfig = fromSource(config.mcpConfig, 'mcpConfig');
  config.pluginEntries = config.pluginEntries.map(entry => typeof entry === 'string'
    ? fromSource(entry, 'pluginEntries') : { ...entry, entry: fromSource(entry.entry, 'pluginEntries') });
  return { config, paths, sources: Object.freeze(sources), layers: { global: globalRaw, project: projectRaw, session: overrides } };
}

/** 命名空间逐字段合并；数组默认替换。领域特殊合并由插件 schema 显式处理。 */
function mergePluginConfig(global: unknown, project: unknown): Record<string, unknown> {
  const g = global && typeof global === 'object' && !Array.isArray(global) ? global as Record<string, unknown> : {};
  const p = project && typeof project === 'object' && !Array.isArray(project) ? project as Record<string, unknown> : {};
  return Object.fromEntries([...new Set([...Object.keys(g), ...Object.keys(p)])].map(id => [id,
    { ...(g[id] as object ?? {}), ...(p[id] as object ?? {}) }]));
}
