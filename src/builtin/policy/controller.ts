import { minimatch } from 'minimatch';
import { createHash } from 'node:crypto';
import type { Tool } from '../../core/registry.js';
import type { PermissionMode } from '../../core/config.js';

import type { Decision, DecisionKind, ParsedRule, AuditEntry, SessionRules } from '../../core/permission/contracts.js';
export type { Decision, DecisionKind, ParsedRule, AuditEntry, SessionRules } from '../../core/permission/contracts.js';

export function parseRule(raw: string): ParsedRule {
  const m = /^([a-zA-Z0-9_:*-]+)(?:\((.*)\))?$/s.exec(raw.trim());
  if (!m) throw new Error(`Invalid permission rule: ${raw}`);
  if (m[2]?.startsWith('="')) {
    const exact: unknown = JSON.parse(m[2].slice(1));
    if (typeof exact !== 'string') throw new Error(`Invalid exact permission rule: ${raw}`);
    return { raw, tool: m[1], exact };
  }
  return { raw, tool: m[1], pattern: m[2] };
}

/** 规则是否命中某次调用。patternTarget 由工具自己提供（bash→命令，文件工具→路径）。 */
export function matchRule(rule: ParsedRule, toolName: string, patternTarget: string): boolean {
  if (rule.tool !== toolName) return false;
  if (rule.exact !== undefined) return patternTarget === rule.exact;
  if (rule.pattern === undefined) return true;
  return minimatch(patternTarget, rule.pattern, { dot: true, nocase: false });
}

export class PermissionController {
  private sessionRules: SessionRules = { allow: [], ask: [], deny: [] };
  private auditLog: AuditEntry[] = [];

  validateSessionRules(rules: Partial<SessionRules>): void {
    for (const rule of [...(rules.allow ?? []), ...(rules.ask ?? []), ...(rules.deny ?? [])]) parseRule(rule);
  }

  constructor(
    private options: {
      mode: PermissionMode;
      rules: SessionRules; // 项目级 + 全局级（已由 config 合并）
    },
  ) {}

  /** 每次执行批准绑定有效规则与模式；外部配置对象的变动也会失效。 */
  get revision(): string {
    return createHash('sha256').update(JSON.stringify({ ...this.options, sessionRules: this.sessionRules })).digest('hex');
  }

  get mode(): PermissionMode {
    return this.options.mode;
  }

  setMode(mode: PermissionMode): void {
    this.options.mode = mode;
  }

  /** 用户选择"本次会话始终允许/询问/拒绝"时调用 —— 会话级规则排在最前 */
  addSessionRule(kind: 'allow' | 'ask' | 'deny', rule: string): void {
    this.sessionRules[kind].push(rule);
  }

  /** 深拷贝。调用方改返回值不会影响引擎。 */
  getSessionRules(): SessionRules {
    return {
      allow: [...this.sessionRules.allow],
      ask: [...this.sessionRules.ask],
      deny: [...this.sessionRules.deny],
    };
  }

  clearSessionRules(): void {
    this.sessionRules = { allow: [], ask: [], deny: [] };
  }

  /**
   * 先解析全部规则，再清空并按 allow → ask → deny 重放。
   * 任何一条不合法都保持原样，一条都不写。
   */
  setSessionRules(rules: Partial<SessionRules>): void {
    const next: SessionRules = {
      allow: [...(rules.allow ?? [])],
      ask: [...(rules.ask ?? [])],
      deny: [...(rules.deny ?? [])],
    };
    for (const rule of [...next.allow, ...next.ask, ...next.deny]) parseRule(rule);
    this.sessionRules = { allow: [], ask: [], deny: [] };
    for (const rule of next.allow) this.sessionRules.allow.push(rule);
    for (const rule of next.ask) this.sessionRules.ask.push(rule);
    for (const rule of next.deny) this.sessionRules.deny.push(rule);
  }

  getAuditLog(): readonly AuditEntry[] {
    return this.auditLog;
  }

  /** 记录一次管线外部（如 LLM 审批员）做出的判定，保持审计完整 */
  recordDecision(tool: Omit<Tool, 'execute'>, input: Record<string, unknown>, decision: Decision): void {
    const summary = tool.name;
    this.auditLog.push({ toolName: tool.name, summary, decision, at: Date.now() });
  }

}
