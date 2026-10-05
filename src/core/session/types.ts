/**
 * 落盘的会话文件形状。SessionRules 定义在权限引擎里，这里只再导出，避免循环依赖。
 */
import type { PermissionMode } from '../config.js';
import type { SessionRules } from '../permission/engine.js';
import type { ThinkingLevel } from '../provider.js';
import type { Message, TokenUsage } from '../protocol/types.js';

export type { SessionRules };

export const SESSION_SCHEMA_VERSION = 1;

export interface SessionFile {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  title: string;
  /** 最后观察到的版本；旧 v1 缺省为 0，每次保存/删除递增。 */
  revision?: number;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  model: string;
  /** 旧 v1 文件缺省；恢复须显式确认迁移。仅存身份，不存 URL 或凭证。 */
  provider?: string;
  endpointKey?: string;
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
