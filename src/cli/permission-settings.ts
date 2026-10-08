/** TUI 权限中心：会话操作即时生效；项目草稿只有显式 Save 才落盘。 */
import { GLOBAL_CONFIG, type PermissionMode } from '../core/config.js';
import { copyPermissionDraft, PermissionConfigError, readPermissionConfig, readProjectPermissionConfig, saveProjectPermissionConfig, validatePermissionRule,
  type PermissionConfigDraft, type PermissionConfigSnapshot } from '../core/permission-config.js';
import { parseRule, type DecisionKind, type SessionRules } from '../core/permission/engine.js';
import type { Agent } from '../index.js';
import type { PanelItem } from './interaction-panel.js';
import type { SettingsInputRequest } from './settings-input.js';

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
  /** 测试使用独立的临时全局配置；实际应用使用 GLOBAL_CONFIG。 */
  globalConfigPath?: string;
}

const kinds = ['allow', 'ask', 'deny'] as const;
const modes = ['ask', 'auto', 'yolo'] as const;
const kindLabels = { allow: '允许', ask: '询问', deny: '拒绝' };
const safeText = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const rulesCount = (rules: SessionRules) => kinds.reduce((sum, kind) => sum + rules[kind].length, 0);
const sameRules = (left: SessionRules, right: SessionRules) => kinds.every(kind => JSON.stringify(left[kind]) === JSON.stringify(right[kind]));
const modeLabel = (mode?: PermissionMode) => mode ?? '继承全局 / 内置 ask';
const judgeLabel = (model?: string) => model === undefined ? '继承全局' : model === '' ? '关闭' : safeText(model);
const restartNotice = '重启后新会话生效；当前会话的模式、规则和审批模型不变。恢复旧会话时可能还原它保存的模式与会话规则。';

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
  const globalPath = options.globalConfigPath ?? GLOBAL_CONFIG;
  const guard = () => agent.config.dangerForceAsk
    ? 'deny 规则最高优先；危险操作仍强制询问；allow 与 ask 规则继续生效。'
    : 'deny 规则最高优先；当前启动配置已关闭危险操作强制询问；allow 与 ask 规则继续生效。';
  const modeDescription = (mode: PermissionMode): string => ({
    ask: '未命中规则的操作均询问。',
    auto: agent.config.judgeModel
      ? `未命中规则的普通只读操作放行；写入/执行由已加载的审批模型 ${safeText(agent.config.judgeModel)} 检查，只有明确安全才放行，否则询问。`
      : '未命中规则的普通只读操作放行；写入/执行仍询问（当前未加载审批模型）。',
    yolo: '未命中规则的普通操作自动放行，包括写入与执行。仅建议在隔离沙箱中使用。',
  })[mode];
  const reportError = (error: unknown) => notify(error instanceof PermissionConfigError ? error.message : '权限设置操作失败，未保存更改。', true);
  const confirm = (title: string, body: string, label: string, apply: () => void, back: () => void) => showPicker({
    title, context: '先选择，再 Enter 确认；Esc 返回', body: () => body, requireSelection: true,
    items: [{ value: 'cancel', label: '取消', description: body }, { value: 'confirm', label, description: body }],
    onPick: value => value === 'confirm' ? apply() : back(), onCancel: back,
  });

  // 只有能逐项核对启动时的合并列表，才标注全局 / 项目来源。
  const sourceRows: string[] = [];
  try {
    const global = readPermissionConfig(globalPath);
    const project = readProjectPermissionConfig(cwd);
    for (const kind of kinds) {
      const merged = [...global.permissions[kind], ...project.permissions[kind]];
      const verified = JSON.stringify(merged) === JSON.stringify(agent.config.permissions[kind]);
      agent.config.permissions[kind].forEach((rule, index) => sourceRows.push(
        `[${kind}] ${safeText(rule)}\n  来源: ${verified ? index < global.permissions[kind].length ? '全局 ~/.agent/config.json' : '项目 agent.config.json' : '启动时合并配置（来源无法核验）'}\n  ${describePermissionRule(rule)}`,
      ));
    }
  } catch {
    for (const kind of kinds) for (const rule of agent.config.permissions[kind]) sourceRows.push(`[${kind}] ${safeText(rule)}\n  来源: 启动时合并配置（来源无法核验）\n  ${describePermissionRule(rule)}`);
  }

  let rootBack: () => void = () => {};
  let modeBack: () => void = () => {};
  function reopenRoot(): void {
    showPicker({
      title: '权限设置', context: `当前会话: ${agent.permission.mode} · 项目设置需 Save 后重启`,
      items: [
        { value: 'mode', label: `当前会话模式 · ${agent.permission.mode}`, description: `${modeDescription(agent.permission.mode)}\n${guard()}\n只改变后续权限检查；不会处理已弹出的审批。` },
        { value: 'session', label: `已记住的会话规则 · ${rulesCount(agent.permission.getSessionRules())} 条`, description: '查看准确匹配范围并逐条移除。规则可能随会话保存和恢复。' },
        { value: 'effective', label: '当前生效的配置规则 · 只读', description: '启动时已加载的全局与项目规则；在此查看来源与优先级。' },
        { value: 'project', label: '项目默认设置 · 编辑 / Save', description: `编辑默认模式、项目 allow / ask / deny 与审批模型。${restartNotice}` },
        { value: 'audit', label: '权限决策日志', description: '查看本进程中的实际判定、原因与来源。' },
      ],
      onPick: value => {
        const actions: Record<string, () => void> = { mode: () => { modeBack = reopenRoot; reopenModes(); }, session: openSessionRules, effective: openEffectiveRules, project: openProject, audit: openAudit };
        actions[value]?.();
      },
      onCancel: () => rootBack(),
    });
  }

  function reopenModes(): void {
    showPicker({ title: '当前会话权限模式', initialValue: agent.permission.mode,
      context: `当前: ${agent.permission.mode} · 选择后查看确认范围`,
      items: modes.map(mode => ({ value: mode, label: mode, current: mode === agent.permission.mode,
        description: `${modeDescription(mode)}\n${guard()}\n只改变当前会话后续权限检查，可能在本轮内；已弹出的审批仍需处理。模式可能随会话保存和恢复，不修改项目默认。` })),
      onPick: value => confirmMode(value as PermissionMode), onCancel: () => modeBack(),
    });
  }

  function confirmMode(mode: PermissionMode): void {
    if (!modes.includes(mode)) return;
    const sessionId = agent.session.id;
    confirm(`确认会话模式 → ${mode}`, `${agent.permission.mode} → ${mode}\n${modeDescription(mode)}\n${guard()}\n\n作用范围: 当前会话的后续权限检查，可能在本轮内生效。已弹出的审批不自动放行；已开始的工具不会被追溯取消。模式可能随会话保存和恢复，不修改项目配置。`, `确认切换为 ${mode}`, () => {
      if (agent.session.id !== sessionId) { notify('当前会话已变化，请重新选择模式。', true); reopenRoot(); return; }
      agent.permission.setMode(mode);
      options.onModeChange(mode);
      notify(`当前会话模式已切换为 ${mode}；后续权限检查生效，已有审批仍需处理。`);
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
    showDetails('当前生效的配置规则 · 只读', () => `${guard()}\n判定顺序: deny → 危险检测（启用时）→ allow → ask → 模式默认。\n同类中会话规则优先于配置；配置内部为全局规则后接项目规则。\n这里是启动时加载的快照，项目 Save 后要重启才能更新。\n\n${sourceRows.join('\n\n') || '(没有配置规则)'}`, reopenRoot);
  }

  function openAudit(): void {
    showDetails('权限决策日志', () => agent.permission.getAuditLog().map(entry =>
      `[${entry.decision.kind}] ${safeText(entry.summary)}\n${safeText(entry.decision.reason)} · 来源 ${entry.decision.source}`,
    ).join('\n\n') || '(暂无决策记录)', reopenRoot);
  }

  function openProject(): void {
    let snapshot: PermissionConfigSnapshot;
    let global: PermissionConfigSnapshot;
    try { snapshot = readProjectPermissionConfig(cwd); global = readPermissionConfig(globalPath); }
    catch (error) { reportError(error); reopenRoot(); return; }
    let draft = copyPermissionDraft(snapshot);
    let saveError = '';
    const dirty = () => JSON.stringify(draft) !== JSON.stringify(copyPermissionDraft(snapshot));
    const draftSummary = () => `文件: ${safeText(snapshot.path)}\n默认模式: ${modeLabel(draft.permissionMode)}\n审批模型: ${judgeLabel(draft.judgeModel)}\n${kinds.map(kind => `${kind}: ${draft.permissions[kind].length} 条`).join(' · ')}\n${restartNotice}`;
    const back = () => dirty()
      ? confirm('放弃未保存的项目草稿？', `项目草稿尚未保存。\n${draftSummary()}\n\n放弃后磁盘文件与当前会话不变。`, '放弃草稿并返回', reopenRoot, renderProject)
      : reopenRoot();
    const renderProject = () => showPicker({
      title: `项目默认设置${dirty() ? ' · 未保存' : ''}`, context: saveError || '只编辑草稿；Save 后重启生效', body: draftSummary,
      items: [
        { value: 'mode', label: `默认模式 · ${modeLabel(draft.permissionMode)}`, description: `全局默认: ${global.permissionMode ?? 'ask（内置）'}。${restartNotice}` },
        { value: 'rules', label: `项目规则 · ${rulesCount(draft.permissions)} 条`, description: '添加 / 编辑 / 删除项目 allow、ask、deny；全局规则另外合并，不能在此删除。' },
        { value: 'global', label: `全局继承规则 · ${rulesCount(global.permissions)} 条 · 只读`, description: '查看 ~/.agent/config.json 中的规则；项目规则不会删除全局规则。' },
        { value: 'judge', label: `审批模型 · ${judgeLabel(draft.judgeModel)}`, description: `全局: ${judgeLabel(global.judgeModel)}。模型复用主 provider 与 endpoint；输入名称需与其兼容。${restartNotice}` },
        { value: 'review', label: '查看完整草稿 / 更改', description: '核对模式、审批模型和各条规则。这里只显示权限设置，不展示配置中的其他字段。' },
        { value: 'save', label: 'Save · 保存项目草稿', description: `写入 ${safeText(snapshot.path)}。保留其他配置字段。${restartNotice}` },
        { value: 'back', label: '返回权限中心', description: dirty() ? '有未保存草稿，返回前会询问是否放弃。' : '没有未保存更改。' },
      ],
      onPick: value => {
        if (value === 'mode') showPicker({ title: '项目默认模式 · 草稿', initialValue: draft.permissionMode ?? 'inherit',
          items: [{ value: 'inherit', label: `继承全局 / 内置（${global.permissionMode ?? 'ask'}）`, description: restartNotice },
            ...modes.map(mode => ({ value: mode, label: mode, description: `${modeDescription(mode)}\n${guard()}\n以上审批模型/危险检测说明基于当前运行配置。${restartNotice}` }))],
          onPick: mode => { draft.permissionMode = mode === 'inherit' ? undefined : mode as PermissionMode; renderProject(); }, onCancel: renderProject,
        });
        else if (value === 'rules') ruleKinds();
        else if (value === 'global') showDetails('全局继承规则 · 磁盘快照 · 只读', () => kinds.flatMap(kind => global.permissions[kind].map(rule => `[${kind}] ${safeText(rule)}\n${describePermissionRule(rule)}`)).join('\n\n') || '(没有全局规则)', renderProject);
        else if (value === 'judge') editJudge();
        else if (value === 'review') showDetails('项目权限草稿 / 更改', reviewText, renderProject);
        else if (value === 'save') save();
        else if (value === 'back') back();
      }, onCancel: back,
    });
    const reviewText = () => `${draftSummary()}\n\n${kinds.map(kind => `${kind}:\n${draft.permissions[kind].map(rule => `  ${safeText(rule)}\n    ${describePermissionRule(rule)}`).join('\n') || '  (无)'}`).join('\n\n')}\n\n变更前模式: ${modeLabel(snapshot.permissionMode)}\n变更前审批模型: ${judgeLabel(snapshot.judgeModel)}\n${kinds.map(kind => `${kind} 原有: ${snapshot.permissions[kind].map(safeText).join('；') || '(无)'}`).join('\n')}\n\n全局规则保持只读并继续合并；deny 优先。dangerForceAsk 未在此编辑。`;
    const save = () => {
      if (!dirty()) { notify('没有需要保存的项目更改。'); renderProject(); return; }
      confirm('确认 Save 项目权限设置', reviewText(), 'Save · 确认写入项目配置', () => {
        try { snapshot = saveProjectPermissionConfig(snapshot, draft); draft = copyPermissionDraft(snapshot); saveError = ''; notify(`项目权限设置已保存。${restartNotice}`); }
        catch (error) { saveError = '保存失败 · 草稿保留'; reportError(error); }
        renderProject();
      }, renderProject);
    };
    const editJudge = () => showPicker({ title: '项目审批模型 · 草稿', items: [
      { value: 'name', label: '输入模型名称', description: '仅在 auto 模式使用；复用主 provider / endpoint。不会填写 API key。' },
      { value: 'inherit', label: `继承全局（${judgeLabel(global.judgeModel)}）` },
      { value: 'off', label: '关闭项目审批模型', description: '即使全局配置了审批模型，也明确关闭；auto 下写入/执行回落为询问。' },
    ], onPick: value => {
      if (value === 'name') showInput({ title: '审批模型名称 · 草稿', value: draft.judgeModel || '', description: restartNotice,
        validate: name => !name.trim() || /[\s\u0000-\u001f\u007f-\u009f]/u.test(name) ? '请输入不含空白或控制字符的模型名称。' : undefined,
        onSubmit: name => { draft.judgeModel = name; renderProject(); }, onCancel: editJudge });
      else { draft.judgeModel = value === 'inherit' ? undefined : ''; renderProject(); }
    }, onCancel: renderProject });
    const ruleKinds = () => showPicker({ title: '项目权限规则 · 草稿', items: kinds.map(kind => ({ value: kind, label: `${kind} · ${kindLabels[kind]} · ${draft.permissions[kind].length} 条`, description: '选择类型后添加或编辑。匹配顺序是 deny、危险检测、allow、ask、模式默认；仍需 Save 才保存。' })),
      onPick: kind => ruleList(kind as DecisionKind), onCancel: renderProject });
    const ruleList = (kind: DecisionKind): void => showPicker({ title: `项目 ${kind} 规则 · 草稿`,
      items: [{ value: 'add', label: '+ 添加规则', description: '规则示例：read_file、edit_file(src/**)、bash(="npm test")。工具名本身表示该工具的所有调用。' },
        ...draft.permissions[kind].map((raw, i) => ({ value: String(i), label: safeText(raw), description: describePermissionRule(raw) }))],
      onPick: value => {
        if (value === 'add') editRule(kind);
        else {
          const index = Number(value); const raw = draft.permissions[kind][index]; if (raw === undefined) return;
          showPicker({ title: `项目 ${kind} 规则 · 草稿`, body: () => `${safeText(raw)}\n${describePermissionRule(raw)}`,
            items: [{ value: 'edit', label: '编辑规则', description: `${safeText(raw)}\n${describePermissionRule(raw)}` }, { value: 'delete', label: '从草稿删除', description: '只删除项目草稿中的这一条，Save 后重启生效。全局和会话规则不变。' }],
            onPick: action => {
              if (action === 'edit') editRule(kind, index);
              else confirm('从项目草稿删除规则？', `[${kind}] ${safeText(raw)}\n${describePermissionRule(raw)}\n\n只更改草稿，仍需 Save 才写入配置。`, '确认从草稿删除', () => { draft.permissions[kind].splice(index, 1); ruleList(kind); }, () => ruleList(kind));
            }, onCancel: () => ruleList(kind) });
        }
      }, onCancel: ruleKinds });
    const editRule = (kind: DecisionKind, index?: number) => showInput({ title: `${index === undefined ? '添加' : '编辑'}项目 ${kind} 规则 · 草稿`, value: index === undefined ? '' : draft.permissions[kind][index],
      description: '示例 read_file、edit_file(src/**)、bash(="npm test")。匹配工具提供的目标，其他参数可能不同。Enter 更新草稿，Save 后重启生效。', validate: validatePermissionRule,
      onSubmit: value => { const rule = value.trim(); if (index === undefined) draft.permissions[kind].push(rule); else draft.permissions[kind][index] = rule; ruleList(kind); }, onCancel: () => ruleList(kind) });
    renderProject();
  }
  return {
    open: (onBack?: () => void) => { rootBack = onBack ?? (() => {}); reopenRoot(); },
    openModes: (onBack?: () => void) => { modeBack = onBack ?? (() => {}); reopenModes(); },
    requestMode: (mode: PermissionMode) => { modeBack = () => {}; confirmMode(mode); },
    openAudit,
  };
}
