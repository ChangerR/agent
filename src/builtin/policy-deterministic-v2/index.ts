/** 显式可选的 v2；不会改写或静默替代默认 legacy-v1。 */
import type { AgentConfig, PermissionMode } from '../../core/config.js';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Decision, ParsedRule, SessionRules } from '../../core/permission/contracts.js';
import { definePlugin, type ApprovalTool, type Policy, type PolicyDecision, type PolicyInput, type ToolAnalysis } from '../../sdk/index.js';
import { PermissionEngine, parseRule, matchRule } from '../policy-legacy/engine.js';
import { PluginConfigStore, type ConfigSnapshot } from '../../runtime/config-store.js';
import { ANALYZER_ID, ANALYZER_VERSION, createDeterministicAnalyzer, hash, operationKey, validateWriteRoots } from './analyzer.js';
export { createDeterministicAnalyzer, parseLiteralShell, validateWriteRoots, nativeFilesystemAnalysisSupported, ANALYZER_ID, ANALYZER_VERSION } from './analyzer.js';
export interface DeterministicPolicyOptions { cwd: string; mode: PermissionMode; rules: SessionRules; pluginEntries?: readonly string[]; writeRoots?: readonly string[] }
export interface RuleConflict { tool: string; allowRule: string; askRule: string; certainty: 'definite' | 'potential'; legacyWinner: 'allow'; v2Winner: 'ask' }

class DeterministicController extends PermissionEngine {
  override recordDecision(tool: ApprovalTool, input: Record<string, unknown>, decision: Decision): void {
    const { analyzeInput: _untrustedSummary, ...descriptor } = tool;
    super.recordDecision(descriptor, input, decision);
  }
}

/** 只读迁移预览。复杂 glob 的交集不可证明时明确标为 potential。 */
export function previewRuleConflicts(rules: SessionRules): RuleConflict[] {
  const conflicts: RuleConflict[] = [];
  for (const allowText of rules.allow) for (const askText of rules.ask) {
    const allow = parseRule(allowText); const ask = parseRule(askText);
    if (allow.tool !== ask.tool) continue;
    const left = literalTarget(allow); const right = literalTarget(ask);
    if (left !== undefined && right !== undefined && left !== right) continue;
    if (left !== undefined && !matchRule(ask, ask.tool, left) || right !== undefined && !matchRule(allow, allow.tool, right)) continue;
    conflicts.push({ tool: allow.tool, allowRule: allowText, askRule: askText,
      certainty: allow.pattern === undefined && allow.exact === undefined || ask.pattern === undefined && ask.exact === undefined || left !== undefined || right !== undefined || allow.raw === ask.raw ? 'definite' : 'potential',
      legacyWinner: 'allow', v2Winner: 'ask' });
  }
  return conflicts;
}

export function createDeterministicPolicy(options: DeterministicPolicyOptions): Policy {
  const writeRoots = Object.freeze([...(options.writeRoots ?? [])]);
  const pluginEntries = Object.freeze([...(options.pluginEntries ?? [])]);
  const controller = new DeterministicController({ mode: options.mode, rules: options.rules, dangerForceAsk: true });
  const analyzer = createDeterministicAnalyzer({ pluginEntries, writeRoots });
  return { id: 'deterministic-v2', version: '2.0.0', controller, analyzer,
    get revision() { return `v2:${hash({ rules: controller.revision, writeRoots, pluginEntries })}`; },
    async decide(input, signal) {
      signal.throwIfAborted();
      const session = controller.getSessionRules();
      const target = ruleTarget(input);
      const matched = (kind: keyof SessionRules, targets: readonly string[] = [target]) => {
        for (const [source, rules] of [['session', session[kind]], ['config', options.rules[kind]]] as const) {
          for (const raw of rules) { const rule = parseRule(raw); if (targets.some((candidate) => matchRule(rule, input.tool.name, candidate))) return { raw, rule, source }; }
        }
        return undefined;
      };
      const decision = (kind: PolicyDecision['kind'], reasonCode: string, reason: string, source: PolicyDecision['source'] = 'builtin', matchedRule?: string): PolicyDecision => {
        const value = { kind, reasonCode, reason, source, ...(matchedRule ? { matchedRule } : {}) };
        controller.recordDecision(input.tool, input.input, { ...value, kind: kind === 'review' ? 'ask' : kind });
        return value;
      };
      const denied = matched('deny');
      if (denied) return decision('deny', 'v2_deny_rule', `命中 deny 规则 "${denied.raw}"`, denied.source, denied.raw);
      if (resolve(input.cwd) !== resolve(options.cwd)) return decision('ask', 'v2_context_changed', '调用目录与本策略授权的项目目录不同，必须重新建立明确授权');
      let analysis: ToolAnalysis;
      try {
        analysis = input.analysis?.analyzerId === ANALYZER_ID && input.analysis.analyzerVersion === ANALYZER_VERSION
          && input.analysis.environment?.['$operation'] === operationKey(input)
          && input.analysis.environment?.['$policyOptions'] === hash({ writeRoots, pluginEntries }) ? input.analysis : await analyzer.analyze(input, signal);
      } catch {
        signal.throwIfAborted(); return decision('ask', 'v2_analysis_error', '无法完整验证操作与环境，需人工确认');
      }
      signal.throwIfAborted();
      const targets = ['read_file', 'write_file', 'edit_file', 'glob'].includes(input.tool.name)
        ? [...new Set([target, ...(analysis.targets ?? []).flatMap((path) => [path.replace(/\\/g, '/'), relative(input.cwd, path).replace(/\\/g, '/')])])] : [target];
      const canonicalDeny = matched('deny', targets);
      if (canonicalDeny) return decision('deny', 'v2_deny_rule', `真实目标命中 deny 规则 "${canonicalDeny.raw}"`, canonicalDeny.source, canonicalDeny.raw);
      if (analysis.reasonCode === 'native_windows_unverified') return decision('ask', 'v2_platform_unverified', '原生 Windows 的文件系统/解释器安全分析尚未验收，必须人工确认');
      if (analysis.effects.some((effect) => effect.scope === 'sensitive')) return decision('ask', 'v2_sensitive_target', '目标涉及凭据、权限配置或插件入口，必须人工确认');
      if (analysis.effects.some((effect) => effect.scope === 'external')) return decision('ask', 'v2_external_target', '目标超出已验证项目边界或属于未验证的平台路径，必须人工确认');
      if (analysis.reasonCode === 'special_file_target') return decision('ask', 'v2_special_target', '目标不是普通文件，不能把设备、目录或进程通道当成常规读写');
      if (analysis.reasonCode === 'hardlink_alias_unverified') return decision('ask', 'v2_aliased_target', '目标存在未验证的硬链接别名，必须人工确认');
      if (analysis.reasonCode === 'shell_dangerous') return decision('ask', 'v2_danger_constraint', '危险操作属于 v2 不可降级约束，必须人工确认', 'danger');
      const asked = matched('ask', targets);
      if (asked) return decision('ask', 'v2_explicit_ask', `命中 ask 规则 "${asked.raw}"（v2 中优先于 allow）`, asked.source, asked.raw);
      const complete = analysis.completeness === 'complete' && analysis.effects.length > 0
        && analysis.effects.every((effect) => effect.scope === 'project' && ['read', 'write'].includes(effect.kind));
      const allowed = matched('allow', targets);
      if (allowed && literalTarget(allowed.rule) !== undefined && complete) {
        return decision('allow', 'v2_exact_allow', `命中精确目标 allow 规则 "${allowed.raw}"`, allowed.source, allowed.raw);
      }
      if (controller.mode === 'ask') return decision('ask', 'v2_ask_mode', 'ask 模式默认询问；宽规则不能代替具体授权', 'mode');
      if (complete && writeRoots.length && ['write_file', 'edit_file'].includes(input.tool.name) && analysis.effects.every((effect) => effect.kind === 'write')) {
        const canonicalRoots: unknown = JSON.parse(analysis.environment?.['$writeRoots'] ?? '[]');
        if (Array.isArray(canonicalRoots) && canonicalRoots.every((root) => typeof root === 'string')
          && analysis.effects.every((effect) => effect.target && canonicalRoots.some((root) => contained(root, effect.target!)))) {
          return decision('allow', 'v2_scoped_write', '命中显式 writeRoots 项目目录授权；最终实际路径与敏感约束已验证', 'config');
        }
      }
      if (complete && analysis.effects.every((effect) => effect.kind === 'read')) return decision('allow', 'v2_safe_read', '已验证为项目内普通文件的完整只读操作');
      if (controller.mode === 'yolo') return complete
        ? decision('allow', 'v2_yolo_complete', 'v2 yolo 仅跳过已完整验证的项目内普通文件写入询问', 'mode')
        : decision('ask', 'v2_unknown_ask', 'v2 yolo 不跳过未知、动态 Shell 或不完整副作用，需人工确认', 'mode');
      return decision('review', 'v2_review_uncertain', '确定性分析未给出授权，委托一次 reviewer 判断当前完整操作', 'mode');
    },
  };
}

function literalTarget(rule: ParsedRule): string | undefined {
  if (rule.exact !== undefined) return rule.exact;
  return rule.pattern !== undefined && !/[?*{}[\](!+@\\]/.test(rule.pattern) ? rule.pattern : undefined;
}
function ruleTarget(input: PolicyInput): string {
  const data = input.input;
  const key = ['read_file', 'write_file', 'edit_file'].includes(input.tool.name) ? 'path'
    : input.tool.name === 'bash' ? 'command' : ['glob', 'grep'].includes(input.tool.name) ? 'pattern'
      : typeof data.path === 'string' ? 'path' : typeof data.command === 'string' ? 'command' : 'pattern';
  const value = typeof data[key] === 'string' ? data[key] as string : '';
  return key === 'path' || input.tool.name === 'glob' ? value.replace(/\\/g, '/') : value;
}
function contained(root: string, path: string): boolean {
  const rest = relative(root, path); return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

const schema = z.object({ writeRoots: z.array(z.string().min(1).max(4096)).max(32).default([]) });

export function createDeterministicPolicyPlugin({ config, cwd }: { config: AgentConfig; cwd: string }) {
  const entries = [...config.plugins, ...config.pluginEntries.filter((entry) => typeof entry === 'string' || entry.enabled)
    .map((entry) => typeof entry === 'string' ? entry : entry.entry)];
  return definePlugin({ manifest: { id: 'agentlab.policy-deterministic-v2', version: '2.0.0', apiVersion: 1, configVersion: 1 },
    config: { schema, defaults: { writeRoots: [] }, applyMode: 'new-session' },
    async setup(ctx) {
      const value = schema.parse(ctx.config.value);
      await validateWriteRoots(cwd, value.writeRoots, entries);
      const policy = createDeterministicPolicy({ cwd, mode: config.permissionMode, rules: config.permissions, pluginEntries: entries, writeRoots: value.writeRoots });
      ctx.provide.analyzer('deterministic-v2', policy.analyzer!, { version: '2.0.0' });
      ctx.provide.policy('deterministic-v2', policy, { version: '2.0.0' });
      ctx.provide.settings('policy-deterministic-v2', { title: '确定性策略 v2（可选）', description: 'ask 优先于 allow；未知 Shell/MCP 不会因 risk 声明放行。选择后新会话生效。',
        schema: { type: 'object' }, applyMode: 'new-session', read: () => ({ selectedBy: 'capabilities.policy = deterministic-v2', writeRoots: [...value.writeRoots], conflicts: previewRuleConflicts(config.permissions) }) });
      const store = new PluginConfigStore(join(cwd, 'agent.config.json')); let base: ConfigSnapshot | undefined;
      const drafts = new WeakMap<object, ConfigSnapshot>();
      ctx.provide.settings('policy-deterministic-v2-config', { title: 'v2 明确写入目录授权',
        description: 'writeRoots 默认空。保存 src 等目录即明确授权下次 v2 auto 会话自动写入其中普通文件；deny/ask、敏感文件、外部路径与未知工具仍不会放行。仅新会话生效。',
        schema: { type: 'object', properties: { writeRoots: { type: 'array', items: { type: 'string' } } } }, applyMode: 'new-session',
        read(signal) { signal.throwIfAborted(); base = store.read('agentlab.policy-deterministic-v2'); return structuredClone({ ...value, ...base.value }); },
        async draft(raw, signal) { signal.throwIfAborted(); if (!base) throw new Error('请先打开设置'); const draft = Object.freeze(schema.parse(raw));
          await validateWriteRoots(cwd, draft.writeRoots, entries, signal); drafts.set(draft, base); return draft; },
        async commit(draft, signal) { signal.throwIfAborted(); if (!draft || typeof draft !== 'object' || !drafts.has(draft)) throw new Error('无效授权目录草稿');
          const parsed = schema.parse(draft); await validateWriteRoots(cwd, parsed.writeRoots, entries, signal);
          base = store.commit('agentlab.policy-deterministic-v2', drafts.get(draft)!, parsed, { schema }); drafts.delete(draft); },
      });
    },
  });
}
