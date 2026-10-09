/** 公共入口只选择默认 preset；实际装配与领域实现分别位于 runtime 和 builtin。 */
import { createRuntime, type CreateAgentOptions } from './runtime/create-agent.js';
import { defaultPreset } from './builtin/default-preset.js';
export type { Agent } from './runtime/agent.js';
export type { CreateAgentOptions } from './runtime/create-agent.js';
export { definePlugin } from './sdk/index.js';
export { PluginHost } from './runtime/plugin-host.js';
export async function createAgent(cwd: string, options?: CreateAgentOptions) { return createRuntime(cwd, defaultPreset, options); }

// 公共 API 导出（供测试与外部插件使用）
export * from './core/protocol/types.js';
export { EventBus, type AgentEvent, type LoopEndReason, type UserDecision, type PermissionRequest } from './core/events.js';
export { HookRunner } from './core/hooks.js';
export { AgentLoop, type AgentLoopOptions, type AgentRunResult, type SessionSnapshot } from './core/loop.js';
export { PermissionEngine, parseRule, matchRule, type Decision, type SessionRules } from './core/permission/engine.js';
export { AutoJudge, mergeJudgeDecision, type JudgeVerdict, type JudgeStatus, type JudgeMetadata, type JudgeReasonCode } from './core/permission/judge.js';
export { loadPlugins, type Plugin, type PluginContext, type PluginDisposer } from './core/plugin.js';
export { ProviderRegistry, ToolRegistry, type Tool, type ToolContext, type ToolRisk } from './core/registry.js';
export { complete, type ChatRequest, type Provider, type ThinkingLevel, type CachePolicy, type CacheTtl } from './core/provider.js';
export { ContextManager, estimateTokens } from './core/context/manager.js';
export { buildSystemPrompt } from './core/context/system-prompt.js';
export { loadConfig, loadConfigWithSources, MODEL_PRESETS, type AgentConfig, type ModelInfo, type PermissionMode } from './core/config.js';
export { AnthropicProvider, AnthropicStreamTranslator, toAnthropicMessages, toAnthropicTools, fromAnthropicEvent, buildAnthropicBody } from './providers/anthropic.js';
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

export { resolveAgentPaths, getGlobalConfigPath, type AgentPaths } from './core/paths.js';
