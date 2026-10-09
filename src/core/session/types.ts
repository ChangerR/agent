/**
 * 落盘的会话文件形状。SessionRules 定义在权限引擎里，这里只再导出，避免循环依赖。
 */
import type { PermissionMode } from '../config.js';
import type { SessionRules } from '../permission/contracts.js';
import type { ThinkingLevel } from '../provider.js';
import type { Message, TokenUsage } from '../protocol/types.js';

export type { SessionRules };

/** 当前会话格式记录 runtime、policy 和插件状态，恢复前验证身份与版本。 */
export const SESSION_SCHEMA_VERSION = 2;
export interface SessionPolicyIdentity { id: string; version: string; stateSchemaVersion: number }
export interface SessionPluginState { schemaVersion: number; requiredForSafety?: boolean; data: unknown }
export interface SessionRuntimeState { schemaVersion: 1 }


export interface SessionFile {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  runtime: SessionRuntimeState;
  policy: SessionPolicyIdentity;
  pluginStates: Record<string, SessionPluginState>;
  id: string;
  title: string;
  /** 最后观察到的版本；新会话从 0 开始，每次保存/删除递增。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  /** 恢复时必须匹配的身份，不存 URL 或凭证。 */
  provider: string;
  endpointKey: string;
  thinking: ThinkingLevel;
  permissionMode: PermissionMode;
  sessionRules: SessionRules;
  usage: TokenUsage;
  stats: { messages: number; estimatedTokens: number; runs: number };
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  messageCount: number;
  path: string;
}

export interface BrokenSession {
  id: string;
  path: string;
  error: import('./errors.js').SessionError;
}

export interface SessionListing {
  sessions: SessionSummary[];
  broken: BrokenSession[];
}
