/** 确定性规则优先策略：只授权可验证的当前操作。 */
import type { AgentConfig, PermissionMode } from '../../core/config.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ParsedRule, SessionRules } from '../../core/permission/contracts.js';
import { definePlugin, type Policy, type PolicyDecision, type PolicyInput, type ToolAnalysis } from '../../sdk/index.js';
import { PermissionController, parseRule, matchRule } from './controller.js';
import { PluginConfigStore, type ConfigSnapshot } from '../../runtime/config-store.js';
import { resolveAgentPaths } from '../../core/paths.js';
import { ANALYZER_ID, ANALYZER_VERSION, createDeterministicAnalyzer, hash, operationKey, validateWriteRoots } from './analyzer.js';
export { createDeterministicAnalyzer, parseLiteralShell, validateWriteRoots, nativeFilesystemAnalysisSupported, ANALYZER_ID, ANALYZER_VERSION } from './analyzer.js';
export interface DeterministicPolicyOptions { cwd: string; mode: PermissionMode; rules: SessionRules; pluginEntries?: readonly string[]; writeRoots?: readonly string[] }
export function createDeterministicPolicy(options: DeterministicPolicyOptions): Policy {
  const writeRoots = Object.freeze([...(options.writeRoots ?? [])]);
  const pluginEntries = Object.freeze([...(options.pluginEntries ?? [])]);
  const controller = new PermissionController({ mode: options.mode, rules: options.rules });
  const analyzer = createDeterministicAnalyzer({ pluginEntries, writeRoots });
  return { id: 'deterministic', version: '2.0.0', controller, analyzer,
    get revision() { return `policy:${hash({ rules: controller.revision, writeRoots, pluginEntries })}`; },
    async decide(input, signal) {
      signal.throwIfAborted();
      const session = controller.getSessionRules();
      const target = ruleTarget(input);
      const matched = (kind: keyof SessionRules, targets: readonly string[] = [target], eligible: (rule: ParsedRule) => boolean = () => true) => {
        for (const [source, rules] of [['session', session[kind]], ['config', options.rules[kind]]] as const) {
          for (const raw of rules) { const rule = parseRule(raw); if (eligible(rule) && targets.some((candidate) => matchRule(rule, input.tool.name, candidate))) return { raw, rule, source }; }
        }
        return undefined;
      };
      const decision = (kind: PolicyDecision['kind'], reasonCode: string, reason: string, source: PolicyDecision['source'] = 'builtin', matchedRule?: string): PolicyDecision => {
        const value = { kind, reasonCode, reason, source, ...(matchedRule ? { matchedRule } : {}) };
        controller.recordDecision(input.tool, input.input, { ...value, kind: kind === 'review' ? 'ask' : kind });
        return value;
      };
      const denied = matched('deny');
      if (denied) return decision('deny', 'deny_rule', `命中 deny 规则 "${denied.raw}"`, denied.source, denied.raw);
      if (resolve(input.cwd) !== resolve(options.cwd)) return decision('ask', 'context_changed', '调用目录与本策略授权的项目目录不同，必须重新建立明确授权');
      let analysis: ToolAnalysis;
      try {
        analysis = input.analysis?.analyzerId === ANALYZER_ID && input.analysis.analyzerVersion === ANALYZER_VERSION
          && input.analysis.environment?.['$operation'] === operationKey(input)
          && input.analysis.environment?.['$policyOptions'] === hash({ writeRoots, pluginEntries }) ? input.analysis : await analyzer.analyze(input, signal);
      } catch {
        signal.throwIfAborted(); return decision('ask', 'analysis_error', '无法完整验证操作与环境，需人工确认');
      }
      signal.throwIfAborted();
      const targets = ['read_file', 'write_file', 'edit_file', 'glob', 'grep'].includes(input.tool.name)
        ? [...new Set([target, ...(analysis.targets ?? []).flatMap((path) => [path.replace(/\\/g, '/'), relative(input.cwd, path).replace(/\\/g, '/')])])] : [target];
      const canonicalDeny = matched('deny', targets);
      if (canonicalDeny) return decision('deny', 'deny_rule', `真实目标命中 deny 规则 "${canonicalDeny.raw}"`, canonicalDeny.source, canonicalDeny.raw);
      if (analysis.reasonCode === 'native_windows_unverified') return decision('ask', 'platform_unverified', '原生 Windows 的文件系统/解释器安全分析尚未验收，必须人工确认');
      if (analysis.effects.some((effect) => effect.scope === 'sensitive')) return decision('ask', 'sensitive_target', '目标涉及凭据、权限配置或插件入口，必须人工确认');
      if (analysis.effects.some((effect) => effect.scope === 'external')) return decision('ask', 'external_target', '目标超出已验证项目边界或属于未验证的平台路径，必须人工确认');
      if (analysis.reasonCode === 'special_file_target') return decision('ask', 'special_target', '目标不是普通文件，不能把设备、目录或进程通道当成常规读写');
      if (analysis.reasonCode === 'hardlink_alias_unverified') return decision('ask', 'aliased_target', '目标存在未验证的硬链接别名，必须人工确认');
      if (analysis.reasonCode === 'shell_dangerous') return decision('ask', 'danger_constraint', '危险操作属于 不可降级约束，必须人工确认', 'danger');
      const asked = matched('ask', targets);
      if (asked) return decision('ask', 'explicit_ask', `命中 ask 规则 "${asked.raw}"（中优先于 allow）`, asked.source, asked.raw);
      const complete = analysis.completeness === 'complete' && analysis.effects.length > 0
        && analysis.effects.every((effect) => effect.scope === 'project' && ['read', 'write'].includes(effect.kind));
      // 宽规则没有放行资格，也不能遮挡同来源或后续来源的精确目标授权。
      const literalSearch = analysis.environment?.['$searchLiteral'];
      const allowTargets = input.tool.name === 'glob' && literalSearch
        ? [literalSearch.replace(/\\/g, '/'), relative(input.cwd, literalSearch).replace(/\\/g, '/')] : targets;
      const allowed = input.tool.name === 'grep' || input.tool.name === 'glob' && !literalSearch ? undefined
        : matched('allow', allowTargets, (rule) => literalTarget(rule) !== undefined);
      if (allowed && complete) {
        return decision('allow', 'exact_allow', `命中精确目标 allow 规则 "${allowed.raw}"`, allowed.source, allowed.raw);
      }
      if (controller.mode === 'ask') return decision('ask', 'ask_mode', 'ask 模式默认询问；宽规则不能代替具体授权', 'mode');
      if (complete && writeRoots.length && ['write_file', 'edit_file'].includes(input.tool.name) && analysis.effects.every((effect) => effect.kind === 'write')) {
        const canonicalRoots: unknown = JSON.parse(analysis.environment?.['$writeRoots'] ?? '[]');
        if (Array.isArray(canonicalRoots) && canonicalRoots.every((root) => typeof root === 'string')
          && analysis.effects.every((effect) => effect.target && canonicalRoots.some((root) => contained(root, effect.target!)))) {
          return decision('allow', 'scoped_write', '命中显式 writeRoots 项目目录授权；最终实际路径与敏感约束已验证', 'config');
        }
      }
      if (complete && analysis.effects.every((effect) => effect.kind === 'read')) return decision('allow', 'safe_read', '已验证为项目内普通文件的完整只读操作');
      if (controller.mode === 'yolo') return complete
        ? decision('allow', 'yolo_complete', 'yolo 仅跳过已完整验证的项目内普通文件写入询问', 'mode')
        : decision('ask', 'unknown_ask', 'yolo 不跳过未知、动态 Shell 或不完整副作用，需人工确认', 'mode');
      return decision('review', 'review_uncertain', '确定性分析未给出授权，委托一次 reviewer 判断当前完整操作', 'mode');
    },
  };
}

function literalTarget(rule: ParsedRule): string | undefined {
  if (rule.exact !== undefined) return rule.exact;
  return rule.pattern !== undefined && !/[?*{}[\](!+@\\]/.test(rule.pattern) ? rule.pattern : undefined;
}
function ruleTarget(input: PolicyInput): string {
  const data = input.input;
  // 外部工具的精确会话 deny/ask 规则与审批面板使用同一目标；这不授予未知工具放行资格。
  if (!['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'].includes(input.tool.name)) {
    const declared = input.tool.analyzeInput?.(data).patternTarget;
    if (declared !== undefined) return declared;
  }
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
  const entries = config.pluginEntries.filter((entry) => typeof entry === 'string' || entry.enabled)
    .map((entry) => typeof entry === 'string' ? entry : entry.entry);
  return definePlugin({ manifest: { id: 'agentlab.policy', version: '2.0.0', apiVersion: 1 },
    config: { schema, defaults: { writeRoots: [] }, ownedFields: ['writeRoots'], scopes: ['project', 'session', 'cli'], applyMode: 'newSession' },
    async setup(ctx) {
      const value = schema.parse(ctx.config.value);
      await validateWriteRoots(cwd, value.writeRoots, entries);
      const policy = createDeterministicPolicy({ cwd, mode: config.permissionMode, rules: config.permissions, pluginEntries: entries, writeRoots: value.writeRoots });
      ctx.provide.analyzer('deterministic', policy.analyzer!, { version: ANALYZER_VERSION });
      ctx.provide.policy('deterministic', policy, { version: '2.0.0' });
      ctx.provide.settings('policy-deterministic', { title: '确定性策略', description: 'ask 优先于 allow；未知 Shell/MCP 不会因 risk 声明放行。选择后新会话生效。',
        schema: { type: 'object' }, applyMode: 'newSession', read: () => ({ selectedBy: 'capabilities.policy = deterministic', writeRoots: [...value.writeRoots] }) });
      const store = new PluginConfigStore(resolveAgentPaths(cwd).projectConfigPath); let base: ConfigSnapshot | undefined;
      const assertScope = (scope = 'project') => { if (scope !== 'project') throw new Error('writeRoots 只支持本项目授权，不能保存为全局。'); };
      const drafts = new WeakMap<object, ConfigSnapshot>();
      ctx.provide.settings('policy-deterministic-config', { title: '明确写入目录授权',
        description: 'writeRoots 仅限本项目，默认空。保存 src 等目录即明确授权下次 auto 会话自动写入其中普通文件；deny/ask、敏感文件、外部路径与未知工具仍不会放行。仅新会话生效。',
        schema: { type: 'object', properties: { writeRoots: { type: 'array', items: { type: 'string' } } } }, applyMode: 'newSession',
        scopeTargets: [{ scope: 'project', path: store.path }],
        read(signal, scope = 'project') { signal.throwIfAborted(); assertScope(scope); base = store.read('agentlab.policy'); return structuredClone(base.value); },
        async draft(raw, signal, scope = 'project') { signal.throwIfAborted(); assertScope(scope); if (!base) throw new Error('请先打开设置'); const snapshot = base; const draft = Object.freeze(schema.parse(raw));
          await validateWriteRoots(cwd, draft.writeRoots, entries, signal); signal.throwIfAborted(); drafts.set(draft, snapshot); return draft; },
        async commit(draft, signal, scope = 'project') { signal.throwIfAborted(); assertScope(scope); if (!draft || typeof draft !== 'object' || !drafts.has(draft)) throw new Error('无效授权目录草稿');
          const parsed = schema.parse(draft); await validateWriteRoots(cwd, parsed.writeRoots, entries, signal); signal.throwIfAborted();
          base = store.commit('agentlab.policy', drafts.get(draft)!, parsed, { schema, ownedFields: ['writeRoots'] }); drafts.delete(draft); },
      });
    },
  });
}

export { PermissionController, parseRule, matchRule } from './controller.js';
