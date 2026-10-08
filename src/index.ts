/**
 * 装配入口：创建全部注册表，按顺序加载插件，返回可运行的 agent。
 *
 * 加载顺序即架构分层：
 *   providers → builtin tools → skills → MCP → 外部插件
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadModelsFile, MODEL_PRESETS, type AgentConfig, type ModelInfo } from './core/config.js';
import { ContextManager } from './core/context/manager.js';
import { buildSystemPrompt } from './core/context/system-prompt.js';
import { attachDebugLogger } from './core/debug-log.js';
import { EventBus } from './core/events.js';
import { HookRunner } from './core/hooks.js';
import { AgentLoop } from './core/loop.js';
import { PermissionEngine } from './core/permission/engine.js';
import { AutoJudge } from './core/permission/judge.js';
import { loadPlugins, type Plugin, type PluginContext } from './core/plugin.js';
import type { StreamEvent } from './core/protocol/types.js';
import { ProviderRegistry, ToolRegistry } from './core/registry.js';
import { mcpPlugin } from './mcp/plugin.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from './providers/fake.js';
import { OpenAIProvider } from './providers/openai.js';
import { SkillLoader } from './skills/loader.js';
import { skillPlugin } from './skills/plugin.js';
import { SessionManager } from './core/session/manager.js';
import { builtinTools } from './tools/index.js';

export interface Agent {
  loop: AgentLoop;
  events: EventBus;
  permission: PermissionEngine;
  session: SessionManager;
  config: AgentConfig;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  skillLoader: SkillLoader;
  /** 模型规格解析：models.json 覆盖内置 MODEL_PRESETS */
  modelInfo: (model: string) => ModelInfo | undefined;
  /** 已知模型清单（MODEL_PRESETS ∪ models.json ∪ 当前配置），/model 选择器用 */
  knownModels: Array<{ name: string; info?: ModelInfo }>;
  /** 本会话的调试日志文件（JSONL） */
  logPath: string;
  /** 中断并等待当前轮次结束，再释放插件资源；重复调用返回同一个清理任务。 */
  dispose(): Promise<void>;
}

/** provider 插件：两个参考实现 + 离线演示用 fake，走同一个 Plugin 接口 */
function providersPlugin(config: AgentConfig): Plugin {
  return {
    name: 'providers',
    register(ctx) {
      ctx.providers.register(
        new AnthropicProvider({
          apiKey: process.env[config.apiKeyEnv ?? 'ANTHROPIC_API_KEY'],
          baseURL: config.provider === 'anthropic' ? config.baseURL : undefined,
          cacheControl: config.cache.enabled,
        }),
      );
      ctx.providers.register(
        new OpenAIProvider({
          apiKey: process.env[config.apiKeyEnv ?? 'OPENAI_API_KEY'],
          baseURL: config.provider === 'openai' ? config.baseURL : undefined,
        }),
      );
      // 离线演示：agent.config.json 里 "provider": "fake" 即可在没有 API key 时体验完整 loop
      ctx.providers.register(new FakeProvider([demoScript()]));
    },
  };
}

/** fake provider 的演示剧本：用户提到文件名就调 read_file，否则文字回复 */
function demoScript(): ScriptedResponse {
  let called = false;
  return (req): StreamEvent[] => {
    const last = req.messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    if (!called) {
      const m = /[\w.-]+\.(txt|md|ts|js|json)/i.exec(text);
      if (m) {
        called = true;
        return toolUseResponse([{ id: 'demo-1', name: 'read_file', input: { path: m[0] } }]);
      }
    }
    called = false;
    return textResponse(
      '[fake provider] 我收到了你的消息。这是一个离线演示：在消息里提到一个真实文件名（如 README.md），我会演示一次 read_file 工具调用的完整链路。',
    );
  };
}

export async function createAgent(cwd: string, options?: { autoSaveSessions?: boolean }): Promise<Agent> {
  // 加载 <cwd>/.env 到环境变量（Node 20.12+ 原生支持，无需 dotenv）
  try {
    process.loadEnvFile(join(cwd, '.env'));
  } catch {
    // .env 不存在时忽略
  }
  const config = loadConfig(cwd);
  // 与 SDK 使用相同的端点优先级；在组装时冻结，避免首次请求前环境变量变化。
  const configuredEndpoint = config.baseURL ?? (config.provider === 'openai' ? process.env.OPENAI_BASE_URL : undefined);
  // OpenAI SDK 将空字符串回退到默认地址，但不会 trim 空白字符串。
  const endpointURL = config.provider === 'openai' ? configuredEndpoint || undefined : configuredEndpoint;
  const providerConfig = config.provider === 'openai'
    ? { ...config, baseURL: endpointURL ?? 'https://api.openai.com/v1' }
    : config;
  const providers = new ProviderRegistry();
  const tools = new ToolRegistry();
  const hookRunner = new HookRunner();
  const events = new EventBus();
  const logPath = attachDebugLogger(
    events,
    join(cwd, '.agentlab', 'logs', `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`),
  );

  const ctx: PluginContext = {
    providers,
    tools,
    hooks: { register: (point, handler) => hookRunner.register(point, handler) },
    config,
  };

  const skillLoader = new SkillLoader(cwd);
  skillLoader.load();

  // 内置 + 外部插件，同一个接口
  const plugins: Plugin[] = [
    providersPlugin(providerConfig),
    builtinTools,
    skillPlugin(skillLoader),
    mcpPlugin(resolve(cwd, config.mcpConfig)),
  ];
  for (const entry of config.plugins) {
    const mod = (await import(pathToFileURL(resolve(cwd, entry)).href)) as { default: Plugin };
    plugins.push(mod.default);
  }
  const disposePlugins = await loadPlugins(plugins, ctx);
  try {
    const permission = new PermissionEngine({
      mode: config.permissionMode,
      rules: config.permissions,
      dangerForceAsk: config.dangerForceAsk,
    });

    // auto 模式可选的 LLM 审批员（复用主 provider，换个便宜快速的模型）
    const autoJudge = config.judgeModel
      ? new AutoJudge(providers.get(config.provider), config.judgeModel)
      : undefined;

    const systemPrompt = buildSystemPrompt({
      cwd,
      tools,
      skills: skillLoader.list().map((s) => ({ name: s.name, description: s.description })),
    });

    // 模型规格：models.json 覆盖内置 MODEL_PRESETS
    const userModels = loadModelsFile(join(cwd, config.modelsFile));
    const modelInfo = (model: string): ModelInfo | undefined => userModels[model] ?? MODEL_PRESETS[model];
    const knownModels = [...new Set([...Object.keys(MODEL_PRESETS), ...Object.keys(userModels), config.model])].map(
      (name) => ({ name, info: modelInfo(name) }),
    );

    const loop = new AgentLoop({
      provider: providers.get(config.provider),
      model: config.model,
      tools,
      permission,
      hooks: hookRunner,
      events,
      context: new ContextManager({ compactThreshold: config.compactThreshold }),
      systemPrompt,
      maxTurns: config.maxTurns,
      cwd,
      modelInfo,
      autoJudge,
      thinking: config.thinking,
      cache: config.cache,
    });

    const session = new SessionManager({
      cwd,
      loop,
      permission,
      events,
      autoSave: options?.autoSaveSessions ?? true,
      endpointKey: endpointURL ? createHash('sha256').update(endpointURL).digest('hex') : 'default',
    });
    const detachSession = session.attach();

    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= (async () => {
      const errors: unknown[] = [];
      try { await loop.dispose(); } catch (error) { errors.push(error); }
      try { await session.finalize(); } catch (error) { errors.push(error); }
      detachSession();
      try { await disposePlugins(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Agent cleanup failed');
    })();
    return { loop, events, permission, config, tools, providers, skillLoader, modelInfo, knownModels, logPath, session, dispose };
  } catch (error) {
    try { await disposePlugins(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Agent initialization and cleanup failed'); }
    throw error;
  }
}

// 公共 API 导出（供测试与外部插件使用）
export * from './core/protocol/types.js';
export { EventBus, type AgentEvent, type LoopEndReason, type UserDecision, type PermissionRequest } from './core/events.js';
export { HookRunner } from './core/hooks.js';
export { AgentLoop, type AgentLoopOptions, type AgentRunResult, type SessionSnapshot } from './core/loop.js';
export { PermissionEngine, parseRule, matchRule, type Decision, type SessionRules } from './core/permission/engine.js';
export { AutoJudge, mergeJudgeDecision, type JudgeVerdict } from './core/permission/judge.js';
export { loadPlugins, type Plugin, type PluginContext, type PluginDisposer } from './core/plugin.js';
export { ProviderRegistry, ToolRegistry, type Tool, type ToolContext, type ToolRisk } from './core/registry.js';
export { complete, type ChatRequest, type Provider, type ThinkingLevel, type CachePolicy, type CacheTtl } from './core/provider.js';
export { ContextManager, estimateTokens } from './core/context/manager.js';
export { buildSystemPrompt } from './core/context/system-prompt.js';
export { loadConfig, MODEL_PRESETS, type AgentConfig, type ModelInfo, type PermissionMode } from './core/config.js';
export { AnthropicProvider, toAnthropicMessages, toAnthropicTools, fromAnthropicEvent, buildAnthropicBody } from './providers/anthropic.js';
export { OpenAIProvider, toOpenAIMessages, toOpenAITools, OpenAIStreamTranslator } from './providers/openai.js';
export { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from './providers/fake.js';
export { analyzeCommand } from './tools/bash.js';
export { builtinTools } from './tools/index.js';
export { SkillLoader, parseFrontmatter } from './skills/loader.js';
export { skillPlugin } from './skills/plugin.js';
export { McpClientManager, mcpPlugin } from './mcp/plugin.js';
export { loadMcpConfig } from './mcp/config.js';
export { SessionError, type SessionErrorCode } from './core/session/errors.js';
export {
  SESSION_SCHEMA_VERSION,
  type SessionFile,
  type SessionSummary,
  type SessionListing,
  type BrokenSession,
} from './core/session/types.js';
export {
  sessionsDir,
  sessionPath,
  newSessionId,
  isValidSessionId,
  saveSession,
  saveSessionVersioned,
  type SaveSessionOptions,
  loadSession,
  listSessions,
  deleteSession,
  deleteSessionVersioned,
  latestSessionId,
} from './core/session/store.js';
export {
  findUnpairedToolUse,
  findOrphanToolResults,
  trimToSafeTail,
  assertSafeHistory,
  makeTitle,
  type TrimResult,
} from './core/session/history.js';
export { writeFileAtomic, enqueueWrite, flushWrites } from './core/session/atomic.js';
export { SessionManager, type SessionManagerOptions, type SessionSaveResult } from './core/session/manager.js';
