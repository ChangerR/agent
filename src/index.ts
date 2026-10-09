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
export { createDeterministicPolicy, PermissionController, parseRule, matchRule } from './builtin/policy/index.js';
export { createModelReviewer } from './builtin/reviewer-model/index.js';
export type { JudgeStatus, JudgeMetadata, JudgeReasonCode, Decision, SessionRules } from './core/permission/contracts.js';
export type { Plugin, PluginSetupContext } from './sdk/index.js';
export { ProviderRegistry, ToolRegistry, type Tool, type ToolContext, type ToolRisk } from './core/registry.js';
export { complete, type ChatRequest, type Provider, type ThinkingLevel, type CachePolicy, type CacheTtl } from './core/provider.js';
export { ContextManager } from './core/context/coordinator.js';
export { estimateTokens } from './core/context/tokens.js';
export { buildSystemPrompt } from './builtin/context-default/implementation.js';
export { loadConfig, loadConfigWithSources, type AgentConfig, type ModelInfo, type PermissionMode } from './core/config.js';
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
} from './builtin/session-file/implementation.js';
export {
  findUnpairedToolUse,
  findOrphanToolResults,
  trimToSafeTail,
  assertSafeHistory,
  makeTitle,
  type TrimResult,
} from './core/session/history.js';
export { writeFileAtomic, enqueueWrite, flushWrites } from './core/session/atomic.js';
export { SessionManager, type SessionManagerOptions, type SessionSaveResult } from './core/session/coordinator.js';

export { resolveAgentPaths, getGlobalConfigPath, type AgentPaths } from './core/paths.js';

export { MODEL_PRESETS } from './builtin/model-catalog/presets.js';
