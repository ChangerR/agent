/** 确定性规则优先策略：只授权可验证的当前操作。 */
import type { AgentConfig, PermissionMode } from '../../core/config.js';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ParsedRule, SessionRules } from '../../core/permission/contracts.js';
import {
  definePlugin,
  type Policy,
  type PolicyDecision,
  type PolicyInput,
  type ToolAnalysis,
} from '../../sdk/index.js';
import { PermissionController, parseRule, matchRule } from './controller.js';
import { isPlanControl } from '../planning/identity.js';
import { isSubagentControl } from '../subagents/identity.js';
import { PluginConfigStore, type ConfigSnapshot } from '../../runtime/config-store.js';
import { resolveAgentPaths } from '../../core/paths.js';
import {
  ANALYZER_ID,
  ANALYZER_VERSION,
  createDeterministicAnalyzer,
  hash,
  operationKey,
  validateWriteRoots,
} from './analyzer.js';
export {
  createDeterministicAnalyzer,
  validateWriteRoots,
  nativeFilesystemAnalysisSupported,
  windowsAmbiguousPath,
  ANALYZER_ID,
  ANALYZER_VERSION,
} from './analyzer.js';
export { windowsDedicatedFileCommand } from '../../tools/powershell.js';
export interface DeterministicPolicyOptions {
  cwd: string;
  mode: PermissionMode;
  rules: SessionRules;
  pluginEntries?: readonly string[];
  writeRoots?: readonly string[];
  /** 平台判断注入点，默认 process.platform。 */
  platform?: NodeJS.Platform;
}
export function createDeterministicPolicy(options: DeterministicPolicyOptions): Policy {
  const writeRoots = Object.freeze([...(options.writeRoots ?? [])]);
  const pluginEntries = Object.freeze([...(options.pluginEntries ?? [])]);
  const platform = options.platform ?? process.platform;
  const controller = new PermissionController({ mode: options.mode, rules: options.rules });
  const analyzer = createDeterministicAnalyzer({
    pluginEntries,
    writeRoots,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  return {
    id: 'deterministic',
    version: '2.0.0',
    controller,
    analyzer,
    get revision() {
      return `policy:${hash({ rules: controller.revision, writeRoots, pluginEntries })}`;
    },
    async decide(input, signal) {
      signal.throwIfAborted();
      const session = controller.getSessionRules();
      const target = ruleTarget(input);
      const windowsFile =
        platform === 'win32' &&
        input.tool.ownerPlugin === 'agentlab.local-tools' &&
        input.tool.version === '1.0.0' &&
        ['read_file', 'write_file', 'edit_file', 'glob', 'grep'].includes(input.tool.name);
      const windowsShell =
        platform === 'win32' &&
        input.tool.name === 'bash' &&
        input.tool.ownerPlugin === 'agentlab.local-tools' &&
        input.tool.version === '1.0.0';
      // grep 的原始 target 是搜索文本，只有分析返回的真实文件目标才采用 Windows 路径大小写语义。
      const rawTarget = { value: target, filePath: windowsFile && input.tool.name !== 'grep' };
      const matched = (
        kind: keyof SessionRules,
        targets = [rawTarget],
        eligible: (rule: ParsedRule) => boolean = () => true,
      ) => {
        for (const [source, rules] of [
          ['session', session[kind]],
          ['config', options.rules[kind]],
        ] as const) {
          for (const raw of rules) {
            const rule = parseRule(raw);
            // 仅拓宽 Windows 文件 deny/ask 的限制匹配；保留原匹配，避免否定字符类等规则缩窄。
            // allow、Shell 字面量与其他平台保持大小写敏感。
            if (
              eligible(rule) &&
              targets.some(
                (candidate) =>
                  matchRule(rule, input.tool.name, candidate.value) ||
                  (kind !== 'allow' &&
                    candidate.filePath &&
                    matchRule(rule, input.tool.name, candidate.value, { nocase: true })),
              )
            )
              return { raw, rule, source };
          }
        }
        return undefined;
      };
      const decision = (
        kind: PolicyDecision['kind'],
        reasonCode: string,
        reason: string,
        source: PolicyDecision['source'] = 'builtin',
        matchedRule?: string,
      ): PolicyDecision => {
        const value = { kind, reasonCode, reason, source, ...(matchedRule ? { matchedRule } : {}) };
        controller.recordDecision(input.tool, input.input, {
          ...value,
          kind: kind === 'review' ? 'ask' : kind,
        });
        return value;
      };
      const denied = matched('deny');
      if (denied)
        return decision(
          'deny',
          'deny_rule',
          `命中 deny 规则 "${denied.raw}"`,
          denied.source,
          denied.raw,
        );
      if (resolve(input.cwd) !== resolve(options.cwd))
        return decision(
          'ask',
          'context_changed',
          '调用目录与本策略授权的项目目录不同，必须重新建立明确授权',
        );
      let analysis: ToolAnalysis;
      try {
        analysis =
          input.analysis?.analyzerId === ANALYZER_ID &&
          input.analysis.analyzerVersion === ANALYZER_VERSION &&
          input.analysis.environment?.['$operation'] === operationKey(input) &&
          input.analysis.environment?.['$policyOptions'] === hash({ writeRoots, pluginEntries })
            ? input.analysis
            : await analyzer.analyze(input, signal);
      } catch {
        signal.throwIfAborted();
        return decision('ask', 'analysis_error', '无法完整验证操作与环境，需人工确认');
      }
      signal.throwIfAborted();
      const targets = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'].includes(
        input.tool.name,
      )
        ? [
            rawTarget,
            ...[
              ...new Set(
                (analysis.targets ?? []).flatMap((path) => [
                  path.replace(/\\/g, '/'),
                  relative(input.cwd, path).replace(/\\/g, '/'),
                ]),
              ),
            ].map((value) => ({ value, filePath: windowsFile || windowsShell })),
          ]
        : [rawTarget];
      const canonicalDeny = matched('deny', targets);
      if (canonicalDeny)
        return decision(
          'deny',
          'deny_rule',
          `真实目标命中 deny 规则 "${canonicalDeny.raw}"`,
          canonicalDeny.source,
          canonicalDeny.raw,
        );
      if (analysis.reasonCode === 'windows_shell_dedicated_tool')
        return decision(
          'deny',
          'use_dedicated_tool',
          '读文件用 read_file，列目录和按名字找文件用 glob，搜索内容用 grep。这条 PowerShell 没有执行，不需要人工确认。',
        );
      // 歧义路径与未解析的 PowerShell 是确定性人工约束，模型 allow 不能补全缺失语义。
      if (analysis.reasonCode === 'native_windows_unverified')
        return decision(
          'ask',
          'platform_unverified',
          '原生 Windows 的歧义路径尚未验收，必须人工确认',
        );
      if (analysis.effects.some((effect) => effect.scope === 'sensitive'))
        return decision(
          'ask',
          'sensitive_target',
          '目标涉及凭据、权限配置或插件入口，必须人工确认',
        );
      if (analysis.effects.some((effect) => effect.scope === 'external'))
        return decision(
          'ask',
          'external_target',
          '目标超出已验证项目边界或属于未验证的平台路径，必须人工确认',
        );
      if (analysis.reasonCode === 'special_file_target')
        return decision(
          'ask',
          'special_target',
          '目标不是普通文件，不能把设备、目录或进程通道当成常规读写',
        );
      if (analysis.reasonCode === 'hardlink_alias_unverified')
        return decision('ask', 'aliased_target', '目标存在未验证的硬链接别名，必须人工确认');
      if (analysis.reasonCode === 'shell_dangerous')
        return decision(
          'ask',
          'danger_constraint',
          '危险操作属于 不可降级约束，必须人工确认',
          'danger',
        );
      const asked = matched('ask', targets);
      if (asked)
        return decision(
          'ask',
          'explicit_ask',
          `命中 ask 规则 "${asked.raw}"（中优先于 allow）`,
          asked.source,
          asked.raw,
        );
      if (analysis.reasonCode === 'powershell_unresolved')
        return decision(
          'ask',
          'powershell_unknown',
          'PowerShell 的参数、路径或副作用未完整解析，必须人工确认',
        );
      if (isPlanControl(input.tool) && analysis.reasonCode === 'agent_control')
        return decision('allow', 'plan_control', '更新会话计划；真实工具另行审批');
      if (isSubagentControl(input.tool) && analysis.reasonCode === 'agent_control')
        return decision('allow', 'agent_control', '仅管理当前会话的子任务；真实工具另行审批');
      // 精确调用：只接受 ToolExecutor.remember() 生成的等于引号 JSON 规则。
      // 内置 bash，以及副作用未知的 MCP / 工具语义。字面量模式和通配规则没有资格。
      // 第三方同名文件工具（unverified_tool_implementation）不进入。
      const exactCallEligible =
        analysis.reasonCode !== 'unverified_tool_implementation' &&
        ((input.tool.name === 'bash' &&
          input.tool.ownerPlugin === 'agentlab.local-tools' &&
          input.tool.version === '1.0.0') ||
          analysis.reasonCode === 'mcp_effects_unknown' ||
          analysis.reasonCode === 'tool_semantics_unknown');
      if (exactCallEligible) {
        const exactCall = matched('allow', [rawTarget], (rule) => rule.exact !== undefined);
        if (exactCall)
          return decision(
            'allow',
            'exact_call_allow',
            `命中精确调用 allow 规则 "${exactCall.raw}"（危险、敏感、项目外与明确 ask 已先行检查）`,
            exactCall.source,
            exactCall.raw,
          );
      }
      // Windows 写入：只有用户亲自配置或记住的精确、无通配符规则能直接放行（与 Linux 精确规则语义一致）；
      // 通配符/工具级规则和 writeRoots 目录授权都不放行，auto/yolo 交给 reviewer，ask 模式照旧询问。
      // 敏感/写保护、项目外、特殊文件、硬链接与歧义路径在上方已人工，精确规则同样不能越过。
      const windowsShellWrite =
        windowsShell &&
        analysis.completeness === 'complete' &&
        analysis.effects.some((effect) => effect.kind === 'write') &&
        analysis.effects.every(
          (effect) => effect.scope === 'project' && ['read', 'write'].includes(effect.kind),
        );
      // PowerShell 的项目文件写入同样不因为 yolo 而跳过尚未实机验收的平台写入约束。
      if (analysis.reasonCode === 'native_windows_write_unverified' || windowsShellWrite) {
        const exact =
          analysis.completeness === 'complete'
            ? matched(
                'allow',
                windowsShellWrite ? [rawTarget] : targets,
                (rule) => literalTarget(rule) !== undefined,
              )
            : undefined;
        if (exact)
          return decision(
            'allow',
            'exact_allow',
            `命中精确目标 allow 规则 "${exact.raw}"（Windows 写入只接受精确目标规则）`,
            exact.source,
            exact.raw,
          );
        if (controller.mode === 'ask')
          return decision('ask', 'ask_mode', 'ask 模式默认询问；宽规则不能代替具体授权', 'mode');
        return decision(
          'review',
          windowsShellWrite ? 'powershell_write_review' : 'platform_write_review',
          'Windows 平台未做文件系统校验：项目内普通文件写入已完成通用分析并排除敏感/写保护/项目外目标，且未命中精确目标规则，委托 reviewer 判断当前完整操作',
          'mode',
        );
      }
      const complete =
        analysis.completeness === 'complete' &&
        analysis.effects.length > 0 &&
        analysis.effects.every(
          (effect) => effect.scope === 'project' && ['read', 'write'].includes(effect.kind),
        );
      // 宽规则没有放行资格，也不能遮挡同来源或后续来源的精确目标授权。
      const literalSearch = analysis.environment?.['$searchLiteral'];
      const allowTargets =
        input.tool.name === 'bash'
          ? [rawTarget]
          : input.tool.name === 'glob' && literalSearch
            ? [
                literalSearch.replace(/\\/g, '/'),
                relative(input.cwd, literalSearch).replace(/\\/g, '/'),
              ].map((value) => ({ value, filePath: windowsFile }))
            : targets;
      const allowed =
        input.tool.name === 'grep' || (input.tool.name === 'glob' && !literalSearch)
          ? undefined
          : matched('allow', allowTargets, (rule) => literalTarget(rule) !== undefined);
      if (allowed && complete) {
        return decision(
          'allow',
          'exact_allow',
          `命中精确目标 allow 规则 "${allowed.raw}"`,
          allowed.source,
          allowed.raw,
        );
      }
      if (complete && analysis.effects.every((effect) => effect.kind === 'read'))
        return decision('allow', 'safe_read', '已验证为项目边界内的完整只读操作');
      if (controller.mode === 'ask')
        return decision('ask', 'ask_mode', 'ask 模式默认询问；宽规则不能代替具体授权', 'mode');
      if (
        complete &&
        writeRoots.length &&
        ['write_file', 'edit_file'].includes(input.tool.name) &&
        analysis.effects.every((effect) => effect.kind === 'write')
      ) {
        const canonicalRoots: unknown = JSON.parse(analysis.environment?.['$writeRoots'] ?? '[]');
        if (
          Array.isArray(canonicalRoots) &&
          canonicalRoots.every((root) => typeof root === 'string') &&
          analysis.effects.every(
            (effect) =>
              effect.target && canonicalRoots.some((root) => contained(root, effect.target!)),
          )
        ) {
          return decision(
            'allow',
            'scoped_write',
            '命中显式 writeRoots 项目目录授权；最终实际路径与敏感约束已验证',
            'config',
          );
        }
      }
      if (controller.mode === 'yolo')
        return complete
          ? decision(
              'allow',
              'yolo_complete',
              'yolo 仅跳过已完整验证的项目内普通文件写入询问',
              'mode',
            )
          : decision(
              'ask',
              'unknown_ask',
              'yolo 不跳过未知、动态 Shell 或不完整副作用，需人工确认',
              'mode',
            );
      return decision(
        'review',
        'review_uncertain',
        '确定性分析未给出授权，委托一次 reviewer 判断当前完整操作',
        'mode',
      );
    },
  };
}

function literalTarget(rule: ParsedRule): string | undefined {
  if (rule.exact !== undefined) return rule.exact;
  return rule.pattern !== undefined && !/[?*{}[\](!+@\\]/.test(rule.pattern)
    ? rule.pattern
    : undefined;
}
function ruleTarget(input: PolicyInput): string {
  const data = input.input;
  // 外部工具的精确会话 deny/ask 规则与审批面板使用同一目标；这不授予未知工具放行资格。
  if (!['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep'].includes(input.tool.name)) {
    const declared = input.tool.analyzeInput?.(data).patternTarget;
    if (declared !== undefined) return declared;
  }
  const key = ['read_file', 'write_file', 'edit_file'].includes(input.tool.name)
    ? 'path'
    : input.tool.name === 'bash'
      ? 'command'
      : ['glob', 'grep'].includes(input.tool.name)
        ? 'pattern'
        : typeof data.path === 'string'
          ? 'path'
          : typeof data.command === 'string'
            ? 'command'
            : 'pattern';
  const value = typeof data[key] === 'string' ? (data[key] as string) : '';
  return key === 'path' || input.tool.name === 'glob' ? value.replace(/\\/g, '/') : value;
}
function contained(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

export function describeWriteRootsSettings(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? 'writeRoots 仅限本项目，默认空。Windows 上目录授权不能直接放行写入；通过安全检查的精确目标规则可以放行，否则 auto/yolo 交给模型审查，无法确定、出错或不可用时回到人工确认。deny/ask、敏感文件、外部路径与未知工具仍不会放行。仅新会话生效。'
    : 'writeRoots 仅限本项目，默认空。保存 src 等目录即明确授权下次 auto 会话自动写入其中普通文件；deny/ask、敏感文件、外部路径与未知工具仍不会放行。仅新会话生效。';
}

const schema = z.object({ writeRoots: z.array(z.string().min(1).max(4096)).max(32).default([]) });

export function createDeterministicPolicyPlugin({
  config,
  cwd,
}: {
  config: AgentConfig;
  cwd: string;
}) {
  const entries = config.pluginEntries
    .filter((entry) => typeof entry === 'string' || entry.enabled)
    .map((entry) => (typeof entry === 'string' ? entry : entry.entry));
  return definePlugin({
    manifest: { id: 'agentlab.policy', version: '2.0.0', apiVersion: 1 },
    config: {
      schema,
      defaults: { writeRoots: [] },
      ownedFields: ['writeRoots'],
      scopes: ['project', 'session', 'cli'],
      applyMode: 'newSession',
    },
    async setup(ctx) {
      const value = schema.parse(ctx.config.value);
      await validateWriteRoots(cwd, value.writeRoots, entries);
      const policy = createDeterministicPolicy({
        cwd,
        mode: config.permissionMode,
        rules: config.permissions,
        pluginEntries: entries,
        writeRoots: value.writeRoots,
      });
      ctx.provide.analyzer('deterministic', policy.analyzer!, { version: ANALYZER_VERSION });
      ctx.provide.policy('deterministic', policy, { version: '2.0.0' });
      ctx.provide.settings('policy-deterministic', {
        title: '确定性策略',
        description: 'ask 优先于 allow；未知 Shell/MCP 不会因 risk 声明放行。选择后新会话生效。',
        schema: { type: 'object' },
        applyMode: 'newSession',
        read: () => ({
          selectedBy: 'capabilities.policy = deterministic',
          writeRoots: [...value.writeRoots],
        }),
      });
      const store = new PluginConfigStore(resolveAgentPaths(cwd).projectConfigPath);
      let base: ConfigSnapshot | undefined;
      const assertScope = (scope = 'project') => {
        if (scope !== 'project') throw new Error('writeRoots 只支持本项目授权，不能保存为全局。');
      };
      const drafts = new WeakMap<object, ConfigSnapshot>();
      ctx.provide.settings('policy-deterministic-config', {
        title: '明确写入目录授权',
        description: describeWriteRootsSettings(),
        schema: {
          type: 'object',
          properties: { writeRoots: { type: 'array', items: { type: 'string' } } },
        },
        applyMode: 'newSession',
        scopeTargets: [{ scope: 'project', path: store.path }],
        read(signal, scope = 'project') {
          signal.throwIfAborted();
          assertScope(scope);
          base = store.read('agentlab.policy');
          return structuredClone(base.value);
        },
        async draft(raw, signal, scope = 'project') {
          signal.throwIfAborted();
          assertScope(scope);
          if (!base) throw new Error('请先打开设置');
          const snapshot = base;
          const draft = Object.freeze(schema.parse(raw));
          await validateWriteRoots(cwd, draft.writeRoots, entries, signal);
          signal.throwIfAborted();
          drafts.set(draft, snapshot);
          return draft;
        },
        async commit(draft, signal, scope = 'project') {
          signal.throwIfAborted();
          assertScope(scope);
          if (!draft || typeof draft !== 'object' || !drafts.has(draft))
            throw new Error('无效授权目录草稿');
          const parsed = schema.parse(draft);
          await validateWriteRoots(cwd, parsed.writeRoots, entries, signal);
          signal.throwIfAborted();
          base = store.commit('agentlab.policy', drafts.get(draft)!, parsed, {
            schema,
            ownedFields: ['writeRoots'],
          });
          drafts.delete(draft);
        },
      });
    },
  });
}

export { PermissionController, parseRule, matchRule } from './controller.js';
