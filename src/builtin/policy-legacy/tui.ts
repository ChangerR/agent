/** TUI 权限中心：会话操作即时生效；项目/全局原始层草稿只有显式 Save 才落盘。 */
import type { PermissionMode } from '../../core/config.js';
import { resolveAgentPaths } from '../../core/paths.js';
import { copyPermissionDraft, PermissionConfigError, readGlobalPermissionConfig, readPermissionConfig, savePermissionConfig, validatePermissionRule,
  type PermissionConfigScope, type PermissionConfigSnapshot } from '../../core/permission-config.js';
import { parseRule, type DecisionKind, type SessionRules } from '../../core/permission/engine.js';
import type { Agent } from '../../runtime/agent.js';
import type { PanelItem } from '../../cli/interaction-panel.js';
import type { SettingsInputRequest } from '../../cli/settings-input.js';

export interface PermissionSettingsPicker {
  title: string;
  items: PanelItem[];
  onPick: (value: string) => void;
  initialValue?: string;
  context?: string;
  body?: () => string;
  requireSelection?: boolean;
  onCancel: () => void;
}

export interface PermissionSettingsOptions {
  agent: Agent;
  cwd?: string;
  showPicker: (request: PermissionSettingsPicker) => void;
  showDetails: (title: string, body: () => string, onBack: () => void) => void;
  showInput: (request: SettingsInputRequest) => void;
  notify: (text: string, error?: boolean) => void;
  onModeChange: (mode: PermissionMode) => void;
  /** 测试使用独立的临时全局配置；实际应用由统一路径解析器提供。 */
  globalConfigPath?: string;
}

const kinds = ['allow', 'ask', 'deny'] as const;
const modes = ['ask', 'auto', 'yolo'] as const;
const kindLabels = { allow: '允许', ask: '询问', deny: '拒绝' };
const safeText = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const rulesCount = (rules: SessionRules) => kinds.reduce((sum, kind) => sum + rules[kind].length, 0);
const sameRules = (left: SessionRules, right: SessionRules) => kinds.every(kind => JSON.stringify(left[kind]) === JSON.stringify(right[kind]));
const modeLabel = (mode?: PermissionMode, scope: PermissionConfigScope = 'project') => mode ?? (scope === 'global' ? '内置默认 ask' : '继承全局 / 内置 ask');
const judgeLabel = (model?: string, scope: PermissionConfigScope = 'project') => model === undefined ? scope === 'global' ? '内置默认：跟随当前模型' : '继承全局 / 默认跟随当前模型' : model.trim() === '' ? scope === 'global' ? '跟随当前模型' : '跟随当前模型（覆盖全局）' : safeText(model.trim());
const restartNotice = '启动默认在重启后新会话生效；Save 时可另行确认应用有效模式到当前会话。规则和审批模型仍需重启。恢复旧会话时可能还原它保存的模式与会话规则。';
const saveOnlyNotice = '仅保存启动默认；当前会话的模式、规则和审批模型不变。重启后新会话生效；恢复旧会话时可能还原它保存的模式与会话规则。';

/** 显示已装配的运行状态，不能从配置字段推断审批员是否存在。 */
export function describeJudgeStatus(status: ReturnType<Agent['loop']['getJudgeStatus']>): string {
  if (!status.loaded) return '未加载';
  const source = status.source === 'current' ? '跟随当前模型' : status.source === 'explicit' ? '显式指定' : '来源未知';
  return `已加载 ${status.provider ? `${safeText(status.provider)} / ` : ''}${safeText(status.model ?? '未知模型')}（${source}${status.providerSource ? `；provider ${status.providerSource === 'explicit' ? '独立指定' : '跟随当前'}` : ''}）`;
}

export function describePermissionRule(raw: string): string {
  try {
    const rule = parseRule(raw);
    const target = rule.exact !== undefined ? `精确目标 ${JSON.stringify(rule.exact)}` : rule.pattern !== undefined ? `glob 目标 ${JSON.stringify(rule.pattern)}` : '全部调用';
    return `${safeText(rule.tool)} · ${safeText(target)}。匹配工具提供的目标，其他参数可能不同。`;
  } catch { return '无效规则；请修复配置后重启。'; }
}

export function createPermissionSettings(options: PermissionSettingsOptions) {
  const { agent, showPicker, showDetails, showInput, notify } = options;
  const cwd = options.cwd ?? agent.cwd;
  const paths = options.cwd === undefined && agent.paths ? agent.paths : resolveAgentPaths(cwd);
  const globalPath = options.globalConfigPath ?? paths.globalConfigPath;
  const policyId = () => agent.plugins?.selected('policy')?.id ?? 'legacy-v1';
  const isV2 = () => policyId() === 'deterministic-v2';
  const isLegacy = () => ['legacy-v1', 'legacy-shadow'].includes(policyId());
  const guard = () => isV2() ? 'v2: deny 与明确 ask 优先；敏感、项目外、未知 Shell/MCP 不因 writeRoots 或 yolo 放行。'
    : !isLegacy() ? `当前策略: ${safeText(policyId())}；具体模式语义由该插件定义。`
    : agent.config.dangerForceAsk
    ? 'deny 规则最高优先；危险操作仍强制询问；allow 与 ask 规则继续生效。'
    : 'deny 规则最高优先；当前启动配置已关闭危险操作强制询问；allow 与 ask 规则继续生效。';
  const modeDescription = (mode: PermissionMode): string => {
    const judge = agent.loop.getJudgeStatus();
    if (isV2()) return {
      ask: 'v2 ask: 除精确 allow 外默认询问；明确 ask 优先于 allow，writeRoots 不自动放行。',
      auto: `v2 auto: 只放行已完整验证的项目内普通文件读取，以及显式 writeRoots 范围写入（${safeText(JSON.stringify(agent.config.pluginConfig['agentlab.policy-deterministic-v2']?.writeRoots ?? []))}）。剩余可审查操作才交 reviewer；原始 Shell 不作确定性放行。`,
      yolo: 'v2 yolo: 仅自动执行已完整验证的项目内普通文件读写；敏感目标、项目外路径、未知 Shell/MCP 仍必须询问。',
    }[mode];
    if (!isLegacy()) return `${safeText(policyId())} 的 ${mode} 模式；请查看该策略设置与说明，宿主不假定其放行规则。`;
    return {
      ask: '未命中规则的操作均询问。',
      auto: judge.loaded
        ? `未命中规则的普通只读操作放行；写入/执行由审批模型检查（${describeJudgeStatus(judge)}），只有明确安全才放行；不确定或审批失败时询问。`
        : '未命中规则的普通只读操作放行；写入/执行仍询问（当前未加载审批模型）。',
      yolo: '未命中规则的普通操作自动放行，包括写入与执行。仅建议在隔离沙箱中使用。',
    }[mode];
  };
  const reportError = (error: unknown) => notify(error instanceof PermissionConfigError ? error.message : '权限设置操作失败，未保存更改。', true);
  const confirm = (title: string, body: string, label: string, apply: () => void, back: () => void) => showPicker({
    title, context: '先选择，再 Enter 确认；Esc 返回', body: () => body, requireSelection: true,
    items: [{ value: 'cancel', label: '取消', description: body }, { value: 'confirm', label, description: body }],
    onPick: value => value === 'confirm' ? apply() : back(), onCancel: back,
  });

  // 只有能逐项核对启动时的合并列表，才标注全局 / 项目来源。
  const sourceRows: string[] = [];
  try {
    const global = readGlobalPermissionConfig(globalPath);
    const project = readPermissionConfig(paths.projectConfigPath, 'project');
    for (const kind of kinds) {
      const merged = [...global.permissions[kind], ...project.permissions[kind]];
      const verified = JSON.stringify(merged) === JSON.stringify(agent.config.permissions[kind]);
      agent.config.permissions[kind].forEach((rule, index) => sourceRows.push(
        `[${kind}] ${safeText(rule)}\n  来源: ${verified ? index < global.permissions[kind].length ? `全局配置 ${safeText(global.path)}` : `项目配置 ${safeText(project.path)}` : '启动时合并配置（来源无法核验）'}\n  ${describePermissionRule(rule)}`,
      ));
    }
  } catch {
    for (const kind of kinds) for (const rule of agent.config.permissions[kind]) sourceRows.push(`[${kind}] ${safeText(rule)}\n  来源: 启动时合并配置（来源无法核验）\n  ${describePermissionRule(rule)}`);
  }

  let rootBack: () => void = () => {};
  let modeBack: () => void = () => {};
  function reopenRoot(): void {
    showPicker({
      title: '权限设置', context: `本次会话: ${agent.permission.mode} · Save 可仅保存默认，或确认应用模式`,
      items: [
        { value: 'mode', label: `本次会话模式 · ${agent.permission.mode}`, description: `${modeDescription(agent.permission.mode)}\n${guard()}\n只改变后续权限检查；不会处理已弹出的审批。` },
        { value: 'judge', label: `auto 审批模型 · ${describeJudgeStatus(agent.loop.getJudgeStatus())}`, description: '查看实际加载的模型与来源。仅 auto 模式使用；跟随当前模型时会随 /model 和会话恢复更新。' },
        { value: 'session', label: `已记住的会话规则 · ${rulesCount(agent.permission.getSessionRules())} 条`, description: '查看准确匹配范围并逐条移除。规则可能随会话保存和恢复。' },
        { value: 'effective', label: '当前生效的配置规则 · 只读', description: '启动时已加载的全局与项目规则；在此查看来源与优先级。' },
        { value: 'project', label: '本项目默认设置 · 编辑 / Save', description: `作用范围: 本项目。文件: ${safeText(paths.projectConfigPath)}。编辑原始项目层默认模式、allow / ask / deny 与审批模型。${restartNotice}` },
        { value: 'global', label: '全局默认设置 · 编辑 / Save', description: `作用范围: 所有项目的新会话，项目覆盖仍优先。文件: ${safeText(globalPath)}。只编辑全局原始层，不带入项目规则或运行时默认值。${restartNotice}` },
        { value: 'audit', label: '权限决策日志', description: '查看本进程中的实际判定、原因与来源。' },
      ],
      onPick: value => {
        const actions: Record<string, () => void> = { mode: () => { modeBack = reopenRoot; reopenModes(); }, judge: openJudgeStatus, session: openSessionRules, effective: openEffectiveRules, project: () => openScope('project'), global: () => openScope('global'), audit: openAudit };
        actions[value]?.();
      },
      onCancel: () => rootBack(),
    });
  }

  function openJudgeStatus(): void {
    showDetails('当前 auto 审批模型 · 只读', () => `${describeJudgeStatus(agent.loop.getJudgeStatus())}\n\n${isV2() ? '仅 v2 策略返回 review 的操作交给审批员；明确 ask/deny 不会交模型降级。' : '仅 auto 模式下，未命中规则的写入/执行操作交给审批员；不确定、调用失败或未加载时询问。'}\n跟随当前模型: /model 切换和恢复会话时随主模型更新。\n显式指定: 保持指定模型；model-v2 可独立选择已注册 provider，实际来源以上方运行状态为准。\n\n${guard()}\n项目/全局草稿与磁盘配置不代表当前已加载的审批员。`, reopenRoot);
  }

  function reopenModes(): void {
    showPicker({ title: '当前会话权限模式', initialValue: agent.permission.mode,
      context: `当前: ${agent.permission.mode} · 选择后查看确认范围`,
      items: modes.map(mode => ({ value: mode, label: mode, current: mode === agent.permission.mode,
        description: `${modeDescription(mode)}\n${guard()}\n只改变当前会话后续权限检查，可能在本轮内；已弹出的审批仍需处理。模式可能随会话保存和恢复，不修改项目或全局默认。` })),
      onPick: value => confirmMode(value as PermissionMode), onCancel: () => modeBack(),
    });
  }

  function confirmMode(mode: PermissionMode): void {
    if (!modes.includes(mode)) return;
    const sessionId = agent.session.id;
    confirm(`确认会话模式 → ${mode}`, `${agent.permission.mode} → ${mode}\n${modeDescription(mode)}\n${guard()}\n\n作用范围: 当前会话的后续权限检查，可能在本轮内生效。已弹出的审批不自动放行；已开始的工具不会被追溯取消。模式可能随会话保存和恢复，不修改项目或全局配置。`, `确认切换为 ${mode}`, () => {
      if (agent.session.id !== sessionId) { notify('当前会话已变化，请重新选择模式。', true); reopenRoot(); return; }
      agent.permission.setMode(mode);
      options.onModeChange(mode);
      notify(`当前会话模式已切换为 ${mode}；后续权限检查生效，已有审批仍需处理。\n如需作为启动默认，请在 /permissions 的本项目或全局默认设置中 Save。`);
      modeBack();
    }, reopenModes);
  }

  function openSessionRules(): void {
    const snapshot = agent.permission.getSessionRules();
    const sessionId = agent.session.id;
    const entries = kinds.flatMap(kind => snapshot[kind].map((raw, index) => ({ kind, raw, index })));
    if (!entries.length) { showDetails('已记住的会话规则', () => '当前会话没有记住的规则。\n配置规则仍然生效；允许并记住操作产生的规则会显示在这里。', reopenRoot); return; }
    showPicker({ title: '已记住的会话规则 · 选择后移除', context: '立即作用于后续检查；已保存的会话文件要再次保存才更新',
      items: entries.map((entry, i) => ({ value: String(i), label: `[${entry.kind}] ${safeText(entry.raw)}`, description: `${describePermissionRule(entry.raw)}\n来源: 当前会话（含恢复的会话规则）。移除后会重新按其他规则及当前模式判定，并不等于拒绝。` })),
      onPick: value => {
        const entry = entries[Number(value)];
        if (!entry) return;
        confirm('确认移除会话规则', `[${entry.kind}] ${safeText(entry.raw)}\n${describePermissionRule(entry.raw)}\n\n立即移除这一条会话规则；其他规则、已弹出的审批和已开始的工具不变。之后重新按配置和模式判定，可能允许也可能询问或拒绝。磁盘中的旧会话要再次保存才更新。`, '确认移除此条规则', () => {
          if (agent.session.id !== sessionId || !sameRules(snapshot, agent.permission.getSessionRules())) { notify('会话规则已变化，请重新选择要移除的规则。', true); openSessionRules(); return; }
          const next = { allow: [...snapshot.allow], ask: [...snapshot.ask], deny: [...snapshot.deny] };
          next[entry.kind].splice(entry.index, 1);
          agent.permission.setSessionRules(next);
          notify('已移除一条会话规则，后续权限检查生效。'); openSessionRules();
        }, openSessionRules);
      }, onCancel: reopenRoot,
    });
  }

  function openEffectiveRules(): void {
    showDetails('当前生效的配置规则 · 只读', () => `${guard()}\n判定顺序: ${isV2() ? 'deny → 不可降级约束/明确 ask → 精确 allow/确定性范围 → review/人工回退。' : isLegacy() ? 'deny → 危险检测（启用时）→ allow → ask → 模式默认。' : '由当前策略插件定义。'}\n同类中会话规则优先于配置；配置内部为全局规则后接项目规则。\n这里是启动时加载的快照，项目或全局 Save 后要重启才能更新。\n\n${sourceRows.join('\n\n') || '(没有配置规则)'}`, reopenRoot);
  }

  function openAudit(): void {
    showDetails('权限决策日志', () => agent.permission.getAuditLog().map(entry =>
      `[${entry.decision.kind}] ${safeText(entry.summary)}\n${safeText(entry.decision.reason)} · 来源 ${entry.decision.source}`,
    ).join('\n\n') || '(暂无决策记录)', reopenRoot);
  }

  function openScope(scope: PermissionConfigScope): void {
    let snapshot: PermissionConfigSnapshot;
    const isGlobal = scope === 'global';
    const label = isGlobal ? '全局' : '项目';
    let global: PermissionConfigSnapshot;
    let project: PermissionConfigSnapshot;
    try { global = readGlobalPermissionConfig(globalPath); project = readPermissionConfig(paths.projectConfigPath, 'project'); snapshot = isGlobal ? global : project; }
    catch (error) { reportError(error); reopenRoot(); return; }
    let draft = copyPermissionDraft(snapshot);
    let saveError = '';
    let inheritedUnavailable = false;
    const dirty = () => JSON.stringify(draft) !== JSON.stringify(copyPermissionDraft(snapshot));
    // 两层读取器已处理同层 legacy / namespace 别名；只合并原始磁盘层，不能拿运行时或会话覆盖写回默认。
    const globalMode = () => (isGlobal ? draft : global).permissionMode ?? 'ask';
    const projectMode = () => (isGlobal ? project : draft).permissionMode;
    const effectiveMode = (): PermissionMode => projectMode() ?? globalMode();
    const modeSummary = () => `当前会话模式: ${agent.permission.mode}\n重启后本项目新会话模式: ${inheritedUnavailable ? '无法核验（继承配置读取失败）' : `${effectiveMode()}${dirty() ? '（草稿保存后）' : '（按配置快照）'}`}\n${inheritedUnavailable ? '请修复继承配置后重新 Save 核验。' : projectMode() === undefined ? `本项目继承全局 / 内置默认 ${globalMode()}` : `全局默认 ${globalMode()} 被本项目 ${projectMode()} 覆盖`}`;
    const refreshInherited = () => {
      try {
        if (isGlobal) project = readPermissionConfig(paths.projectConfigPath, 'project');
        else global = readGlobalPermissionConfig(globalPath);
        inheritedUnavailable = false;
      } catch (error) { inheritedUnavailable = true; throw error; }
    };
    const draftSummary = () => `${modeSummary()}\n作用范围: ${isGlobal ? '全局（所有项目的新会话；项目覆盖优先）' : '本项目'}\n文件: ${safeText(snapshot.path)}\n默认模式: ${modeLabel(draft.permissionMode, scope)}\n审批模型: ${judgeLabel(draft.judgeModel, scope)}\n${kinds.map(kind => `${kind}: ${draft.permissions[kind].length} 条`).join(' · ')}\n${restartNotice}`;
    const back = () => dirty()
      ? confirm(`放弃未保存的${label}草稿？`, `${label}草稿尚未保存。\n${draftSummary()}\n\n放弃后磁盘文件与当前会话不变。`, '放弃草稿并返回', reopenRoot, renderScope)
      : reopenRoot();
    const renderScope = () => showPicker({
      title: `${label}默认设置${dirty() ? ' · 未保存' : ''}`, context: `${saveError ? `${saveError} · ` : ''}当前 ${agent.permission.mode} · 重启 ${inheritedUnavailable ? '无法核验' : effectiveMode()}${dirty() ? '（未保存）' : ''} · Save 选择应用方式`, body: draftSummary,
      items: [
        { value: 'save', label: `Save · 保存${label}草稿 / 应用模式`, description: `${modeSummary()}\n选择仅保存启动默认，或保存后另行确认应用有效模式。写入 ${safeText(snapshot.path)}，保留其他配置字段。规则和审批模型仍需重启。` },
        { value: 'mode', label: `默认模式 · ${modeLabel(draft.permissionMode, scope)}`, description: `${isGlobal ? '内置默认: ask；项目可覆盖全局默认。' : `全局默认: ${global.permissionMode ?? 'ask（内置）'}。`}${restartNotice}` },
        { value: 'rules', label: `${label}规则 · ${rulesCount(draft.permissions)} 条`, description: isGlobal ? '添加 / 编辑 / 删除全局原始 allow、ask、deny；影响所有项目的新会话，不带入项目或会话规则。' : '添加 / 编辑 / 删除项目 allow、ask、deny；全局规则另外合并，不能在此删除。' },
        ...(!isGlobal ? [{ value: 'global', label: `全局继承规则 · ${rulesCount(global.permissions)} 条 · 只读`, description: `查看 ${safeText(global.path)} 中的规则；项目规则不会删除全局规则。` }] : []),
        { value: 'judge', label: `审批模型 · ${judgeLabel(draft.judgeModel, scope)}`, description: `${isGlobal ? '内置默认跟随当前模型；项目可覆盖。' : `全局: ${global.judgeModel ? safeText(global.judgeModel) : '跟随当前模型'}。`}模型复用主 provider 与 endpoint；输入名称需与其兼容。选择“跟随当前模型”会保存为空字符串。${restartNotice}` },
        { value: 'review', label: '查看完整草稿 / 更改', description: '核对模式、审批模型和各条规则。这里只显示权限设置，不展示配置中的其他字段。' },
        { value: 'back', label: '返回权限中心', description: dirty() ? '有未保存草稿，返回前会询问是否放弃。' : '没有未保存更改。' },
      ],
      onPick: value => {
        if (value === 'mode') showPicker({ title: `${label}默认模式 · 草稿`, initialValue: draft.permissionMode ?? 'inherit',
          items: [{ value: 'inherit', label: isGlobal ? '使用内置默认（ask）' : `继承全局 / 内置（${global.permissionMode ?? 'ask'}）`, description: restartNotice },
            ...modes.map(mode => ({ value: mode, label: mode, description: `${modeDescription(mode)}\n${guard()}\n以上审批模型/危险检测说明基于当前运行配置。${restartNotice}` }))],
          onPick: mode => { draft.permissionMode = mode === 'inherit' ? undefined : mode as PermissionMode; renderScope(); }, onCancel: renderScope,
        });
        else if (value === 'rules') ruleKinds();
        else if (value === 'global' && !isGlobal) showDetails('全局继承规则 · 磁盘快照 · 只读', () => `文件: ${safeText(global.path)}\n\n${kinds.flatMap(kind => global.permissions[kind].map(rule => `[${kind}] ${safeText(rule)}\n${describePermissionRule(rule)}`)).join('\n\n') || '(没有全局规则)'}`, renderScope);
        else if (value === 'judge') editJudge();
        else if (value === 'review') showDetails(`${label}权限草稿 / 更改`, reviewText, renderScope);
        else if (value === 'save') save();
        else if (value === 'back') back();
      }, onCancel: back,
    });
    const reviewText = () => `${draftSummary()}\n\n${kinds.map(kind => `${kind}:\n${draft.permissions[kind].map(rule => `  ${safeText(rule)}\n    ${describePermissionRule(rule)}`).join('\n') || '  (无)'}`).join('\n\n')}\n\n变更前模式: ${modeLabel(snapshot.permissionMode, scope)}\n变更前审批模型: ${judgeLabel(snapshot.judgeModel, scope)}\n${kinds.map(kind => `${kind} 原有: ${snapshot.permissions[kind].map(safeText).join('；') || '(无)'}`).join('\n')}\n\n${isGlobal ? '仅编辑全局原始配置；项目覆盖与项目/会话规则不写入全局。全局规则将在所有项目的新会话中合并。' : '全局规则保持只读并继续合并。'}deny 优先。dangerForceAsk 与 writeRoots 未在此编辑。`;
    const save = () => {
      try { refreshInherited(); }
      catch (error) { saveError = '无法核验有效模式 · 草稿保留'; reportError(error); renderScope(); return; }
      // 保留旧 confirm 值的仅保存语义；即时应用使用独立确认，不能因多按一次 Enter 而扩大授权。
      const body = reviewText();
      showPicker({ title: `确认 Save ${label}权限设置`, context: '先选择保存方式，再 Enter；Esc 返回草稿', body: () => body, requireSelection: true,
        items: [
          { value: 'cancel', label: '取消', description: body },
          { value: 'confirm', label: 'Save · 仅保存启动默认', description: `${saveOnlyNotice}\n\n${body}` },
          { value: 'apply', label: `Save · 保存并应用模式 → ${effectiveMode()}`, description: `另行确认当前会话 ${agent.permission.mode} → ${effectiveMode()}。仅在保存成功后应用模式；规则和审批模型仍需重启。\n\n${body}` },
        ], onPick: value => {
          if (value === 'apply') confirmSaveAndApply();
          else if (value === 'confirm') {
            const changed = dirty();
            if (persist()) {
              // 仅保存不需重确认另一层，但完成后的摘要必须刷新；读取失败不能倒置已成功写盘的事实。
              try {
                refreshInherited();
                notify(`${changed ? `${label}权限设置已保存。` : `没有需要保存的${label}更改。`}${saveOnlyNotice}`);
              } catch {
                saveError = '无法核验重启模式';
                notify(`${changed ? `${label}权限设置已保存` : `没有需要保存的${label}更改`}，但无法核验重启有效模式；请修复继承配置后重新打开设置。当前会话不变。`, true);
              }
            }
            renderScope();
          } else renderScope();
        }, onCancel: renderScope,
      });
    };
    const persist = (): boolean => {
      try {
        if (dirty()) { snapshot = savePermissionConfig(snapshot, draft); draft = copyPermissionDraft(snapshot); }
        else {
          // 已保存草稿也可单独应用；不制造无意义写入，同时拒绝陈旧的磁盘默认确认。
          const latest = readPermissionConfig(snapshot.path, scope);
          if (JSON.stringify(copyPermissionDraft(latest)) !== JSON.stringify(draft)) throw new PermissionConfigError('conflict', '配置已变化，请重新打开对应范围的设置；未应用当前会话模式。');
        }
        saveError = ''; return true;
      } catch (error) { saveError = '保存失败 · 草稿保留'; reportError(error); return false; }
    };
    const confirmSaveAndApply = () => {
      const sessionId = agent.session.id;
      const currentMode = agent.permission.mode;
      const mode = effectiveMode();
      const policy = policyId();
      let pending = true;
      const cancel = () => { pending = false; save(); };
      confirm(`确认保存并应用模式 → ${mode}`, `${currentMode} → ${mode}\n${modeSummary()}\n\n${modeDescription(mode)}\n${guard()}\n\n先保存${label}草稿，成功后仅将合并后的有效模式应用到当前会话的后续权限检查，可能在本轮内生效。已弹出的审批不自动放行；已开始的工具不会被追溯取消。规则和审批模型仍需重启，当前运行中的规则与审批员保持不变。模式可能随会话保存和恢复。\n\n${reviewText()}`, `确认保存并应用 ${currentMode} → ${mode}`, () => {
        if (!pending) return;
        pending = false;
        if (agent.session.id !== sessionId || agent.permission.mode !== currentMode || policyId() !== policy) {
          notify('当前会话已变化，请重新确认保存与应用模式。草稿已保留。', true); renderScope(); return;
        }
        try { refreshInherited(); }
        catch (error) { saveError = '无法核验有效模式 · 草稿保留'; reportError(error); renderScope(); return; }
        if (effectiveMode() !== mode) {
          notify('继承配置已变化，有效模式与确认时不同。请重新确认；草稿已保留，尚未保存或应用。', true); renderScope(); return;
        }
        const changed = dirty();
        if (persist()) {
          agent.permission.setMode(mode);
          options.onModeChange(mode);
          notify(`${label}${changed ? '权限设置已保存' : '启动默认未改写'}；当前会话模式已应用为 ${mode}。后续权限检查生效，已有审批仍需处理。规则和审批模型仍需重启。`);
        }
        renderScope();
      }, cancel);
    };
    const editJudge = () => showPicker({ title: `${label}审批模型 · 草稿`, items: [
      { value: 'name', label: '输入模型名称', description: '仅在 auto 模式使用；复用主 provider / endpoint。不会填写 API key。' },
      { value: 'inherit', label: isGlobal ? '使用内置默认（跟随当前模型）' : `继承全局（${global.judgeModel ? safeText(global.judgeModel) : '默认跟随当前模型'}）`, description: isGlobal ? '移除全局 judgeModel；未另行指定时跟随当前模型。' : '移除项目 judgeModel；全局未指定模型时跟随当前模型。' },
      { value: 'current', label: '跟随当前模型', description: `保存为空字符串${isGlobal ? '' : '，覆盖全局审批模型'}；/model 切换和恢复会话时随主模型更新。需要逐次询问时可选择 ask 模式。` },
    ], onPick: value => {
      if (value === 'name') showInput({ title: '审批模型名称 · 草稿', value: draft.judgeModel || '', description: restartNotice,
        validate: name => !name.trim() || /[\s\u0000-\u001f\u007f-\u009f]/u.test(name) ? '请输入不含空白或控制字符的模型名称。' : undefined,
        onSubmit: name => { draft.judgeModel = name; renderScope(); }, onCancel: editJudge });
      else { draft.judgeModel = value === 'inherit' ? undefined : ''; renderScope(); }
    }, onCancel: renderScope });
    const ruleKinds = () => showPicker({ title: `${label}权限规则 · 草稿`, items: kinds.map(kind => ({ value: kind, label: `${kind} · ${kindLabels[kind]} · ${draft.permissions[kind].length} 条`, description: '选择类型后添加或编辑。匹配顺序是 deny、危险检测、allow、ask、模式默认；仍需 Save 才保存。' })),
      onPick: kind => ruleList(kind as DecisionKind), onCancel: renderScope });
    const ruleList = (kind: DecisionKind): void => showPicker({ title: `${label} ${kind} 规则 · 草稿`,
      items: [{ value: 'add', label: '+ 添加规则', description: '规则示例：read_file、edit_file(src/**)、bash(="npm test")。工具名本身表示该工具的所有调用。' },
        ...draft.permissions[kind].map((raw, i) => ({ value: String(i), label: safeText(raw), description: describePermissionRule(raw) }))],
      onPick: value => {
        if (value === 'add') editRule(kind);
        else {
          const index = Number(value); const raw = draft.permissions[kind][index]; if (raw === undefined) return;
          showPicker({ title: `${label} ${kind} 规则 · 草稿`, body: () => `${safeText(raw)}\n${describePermissionRule(raw)}`,
            items: [{ value: 'edit', label: '编辑规则', description: `${safeText(raw)}\n${describePermissionRule(raw)}` }, { value: 'delete', label: '从草稿删除', description: `只删除${label}草稿中的这一条，Save 后重启生效。${isGlobal ? '项目' : '全局'}和会话规则不变。` }],
            onPick: action => {
              if (action === 'edit') editRule(kind, index);
              else confirm(`从${label}草稿删除规则？`, `[${kind}] ${safeText(raw)}\n${describePermissionRule(raw)}\n\n只更改草稿，仍需 Save 才写入配置。`, '确认从草稿删除', () => { draft.permissions[kind].splice(index, 1); ruleList(kind); }, () => ruleList(kind));
            }, onCancel: () => ruleList(kind) });
        }
      }, onCancel: ruleKinds });
    const editRule = (kind: DecisionKind, index?: number) => showInput({ title: `${index === undefined ? '添加' : '编辑'}${label} ${kind} 规则 · 草稿`, value: index === undefined ? '' : draft.permissions[kind][index],
      description: '示例 read_file、edit_file(src/**)、bash(="npm test")。匹配工具提供的目标，其他参数可能不同。Enter 更新草稿，Save 后重启生效。', validate: validatePermissionRule,
      onSubmit: value => { const rule = value.trim(); if (index === undefined) draft.permissions[kind].push(rule); else draft.permissions[kind][index] = rule; ruleList(kind); }, onCancel: () => ruleList(kind) });
    renderScope();
  }
  return {
    open: (onBack?: () => void) => { rootBack = onBack ?? (() => {}); reopenRoot(); },
    openModes: (onBack?: () => void) => { modeBack = onBack ?? (() => {}); reopenModes(); },
    requestMode: (mode: PermissionMode) => { modeBack = () => {}; confirmMode(mode); },
    openAudit,
  };
}
