/**
 * 权限引擎（教学重点模块）
 *
 * 决策管线（命中即返回）：
 *   1. deny 规则        —— 最高优先级，任何模式都不可逾越
 *   2. 危险命令检测      —— 工具 analyzeInput 标 dangerous → 强制 ask（可配置关闭）
 *   3. allow 规则       —— 命中即静默放行（"自动审批"的主力）
 *   4. ask 规则         —— 命中即询问
 *   5. 模式默认值        —— yolo→allow / auto→只读放行 / ask→全部询问
 *
 * 规则语法：
 *   read_file                  —— 整个工具
 *   bash(npm run test:*)       —— 工具 + glob 参数模式
 *   edit_file(src/**)          —— 按路径模式限定
 *
 * 规则来源（就近覆盖就远）：会话级 > 项目级 > 全局级（调用方合并后传入，
 * 会话级规则通过 addSessionRule 动态追加，排在最前）。
 */
import { minimatch } from 'minimatch';
import type { Tool } from '../registry.js';
import type { PermissionMode } from '../config.js';

export type DecisionKind = 'allow' | 'ask' | 'deny';

export interface Decision {
  /** 本次实际审批模型及结构化结果，不记录底层错误或凭据。 */
  judge?: import('./judge.js').JudgeMetadata;
  kind: DecisionKind;
  /** 人类可读的判定理由（展示与审计用） */
  reason: string;
  /** 命中的规则原文，未命中为 undefined */
  matchedRule?: string;
  /** user 表示最终人工确认，与规则放行和模型判断区分。 */
  source: 'session' | 'config' | 'builtin' | 'mode' | 'danger' | 'judge' | 'user';
}

export interface ParsedRule {
  raw: string;
  tool: string;
  pattern?: string;
  exact?: string;
}

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

export interface AuditEntry {
  toolName: string;
  summary: string;
  decision: Decision;
  at: number;
}

export interface SessionRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

export class PermissionEngine {
  private sessionRules: SessionRules = { allow: [], ask: [], deny: [] };
  private auditLog: AuditEntry[] = [];

  constructor(
    private options: {
      mode: PermissionMode;
      rules: SessionRules; // 项目级 + 全局级（已由 config 合并）
      dangerForceAsk?: boolean;
    },
  ) {}

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
  recordDecision(tool: Tool, input: Record<string, unknown>, decision: Decision): void {
    const summary = tool.analyzeInput?.(input).summary ?? tool.name;
    this.auditLog.push({ toolName: tool.name, summary, decision, at: Date.now() });
  }

  private firstMatch(
    lists: string[][],
    toolName: string,
    target: string,
  ): ParsedRule | undefined {
    for (const rules of lists) {
      for (const raw of rules) {
        const rule = parseRule(raw);
        if (matchRule(rule, toolName, target)) return rule;
      }
    }
    return undefined;
  }

  check(tool: Tool, input: Record<string, unknown>): Decision {
    const analysis = tool.analyzeInput?.(input) ?? {
      patternTarget: '',
      summary: `${tool.name}(${JSON.stringify(input).slice(0, 120)})`,
    };
    const target = analysis.patternTarget;

    const decide = (kind: DecisionKind, reason: string, matchedRule: string | undefined, source: Decision['source']): Decision => {
      const decision = { kind, reason, matchedRule, source };
      this.auditLog.push({ toolName: tool.name, summary: analysis.summary, decision, at: Date.now() });
      return decision;
    };

    // 1. deny 规则（会话级优先于配置级）
    const denyHit = this.firstMatch([this.sessionRules.deny, this.options.rules.deny], tool.name, target);
    if (denyHit) {
      return decide('deny', `命中 deny 规则 "${denyHit.raw}"`, denyHit.raw, this.sourceOf(denyHit, this.sessionRules.deny));
    }

    // 2. 危险命令检测：即使 yolo 也强制 ask（除非配置关闭）
    if (analysis.dangerous && (this.options.dangerForceAsk ?? true)) {
      return decide('ask', '检测到危险操作，强制确认', undefined, 'danger');
    }

    // 3. allow 规则
    const allowHit = this.firstMatch([this.sessionRules.allow, this.options.rules.allow], tool.name, target);
    if (allowHit) return decide('allow', `命中 allow 规则 "${allowHit.raw}"`, allowHit.raw, this.sourceOf(allowHit, this.sessionRules.allow));

    // 4. ask 规则
    const askHit = this.firstMatch([this.sessionRules.ask, this.options.rules.ask], tool.name, target);
    if (askHit) return decide('ask', `命中 ask 规则 "${askHit.raw}"`, askHit.raw, this.sourceOf(askHit, this.sessionRules.ask));

    // 5. 模式默认值
    switch (this.options.mode) {
      case 'yolo':
        return decide('allow', 'yolo 模式默认放行', undefined, 'mode');
      case 'auto':
        return tool.risk === 'read'
          ? decide('allow', 'auto 模式放行只读工具', undefined, 'mode')
          : decide('ask', `auto 模式下 ${tool.risk} 级工具需确认`, undefined, 'mode');
      case 'ask':
        return decide('ask', 'ask 模式默认询问', undefined, 'mode');
    }
  }

  private sourceOf(rule: ParsedRule, sessionRules: string[]): 'session' | 'config' {
    return sessionRules.includes(rule.raw) ? 'session' : 'config';
  }
}
