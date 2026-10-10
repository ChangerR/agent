/** TUI 权限设置：字段提交即原子保存；模式即时应用，规则与审批模型重启生效。 */
import type { PermissionMode } from '../../core/config.js';
import { resolveAgentPaths } from '../../core/paths.js';
import { assertPermissionConfigUnchanged, copyPermissionDraft, PermissionConfigError, readGlobalPermissionConfig, readPermissionConfig, savePermissionConfig, validatePermissionRule,
  type PermissionConfigDraft, type PermissionConfigScope, type PermissionConfigSnapshot } from './config.js';
import { parseRule, type DecisionKind, type SessionRules } from './controller.js';
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
const restartNotice = '选择或 Enter 后自动保存。规则和审批模型重启后生效；模式立即应用到后续检查，已有审批仍需处理。恢复已保存会话时可能还原它保存的模式与会话规则。';

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
  const { agent, notify } = options;
  const cwd = options.cwd ?? agent.cwd;
  const paths = options.cwd === undefined && agent.paths ? agent.paths : resolveAgentPaths(cwd);
  const globalPath = options.globalConfigPath ?? paths.globalConfigPath;
  const policyId = () => agent.plugins?.selected('policy')?.id ?? 'deterministic';
  const isDeterministic = () => policyId() === 'deterministic';
  const guard = () => isDeterministic()
    ? 'deny 与明确 ask 优先；敏感、项目外、未知 Shell/MCP 不因 writeRoots 或 yolo 放行。'
    : `当前策略: ${safeText(policyId())}；具体模式语义由该插件定义。`;
  const modeDescription = (mode: PermissionMode): string => {
    if (!isDeterministic()) return `${safeText(policyId())} 的 ${mode} 模式；请查看该策略设置与说明，宿主不假定其放行规则。`;
    return {
      ask: '除精确 allow 外默认询问；明确 ask 优先于 allow，writeRoots 不自动放行。',
      auto: `只放行已完整验证的项目内普通文件读取，以及显式 writeRoots 范围写入（${safeText(JSON.stringify(agent.config.pluginConfig['agentlab.policy']?.writeRoots ?? []))}）。经 AST 与执行环境验证的只读 Bash 组合直接放行；其余未知操作才交审批模型。`,
      yolo: '仅自动执行已完整验证的项目内普通文件读写；敏感目标、项目外路径、未知 Shell/MCP 仍必须询问。',
    }[mode];
  };
  const reportError = (error: unknown) => notify(error instanceof PermissionConfigError ? error.message : '权限设置操作失败，未保存更改。', true);
  // 每个可见面板只有一次提交机会；旧面板、Esc、重复 Enter 和会话切换均不能重放写入。
  let generation = 0;
  const callbacks = () => {
    const screen = ++generation;
    const sessionId = agent.session.id;
    const mode = agent.permission.mode;
    const policy = policyId();
    let pending = true;
    return (run: () => void) => {
      if (!pending || screen !== generation) return;
      pending = false;
      if (sessionId !== agent.session.id || mode !== agent.permission.mode || policy !== policyId()) {
        notify('当前会话已变化，请重新选择设置；未保存更改。', true); reopenRoot(); return;
      }
      run();
    };
  };
  const showPicker = (request: PermissionSettingsPicker) => {
    const run = callbacks();
    options.showPicker({ ...request,
      onPick: value => { if (request.items.some(item => item.value === value)) run(() => request.onPick(value)); },
      onCancel: () => run(request.onCancel),
    });
  };
  const showInput = (request: SettingsInputRequest) => {
    const run = callbacks();
    options.showInput({ ...request, onSubmit: value => {
      const error = request.validate?.(value);
      if (error) { notify(error, true); return; }
      run(() => request.onSubmit(value));
    }, onCancel: () => run(request.onCancel) });
  };
  const showDetails = (title: string, body: () => string, onBack: () => void) => {
    const run = callbacks(); options.showDetails(title, body, () => run(onBack));
  };

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
  const reopenRoot = () => openScope('project');
  const modeSaved = (scope: PermissionConfigScope, mode: PermissionMode) => {
    try { agent.permission.setMode(mode); }
    catch { notify(`权限配置已保存，但当前策略应用失败；当前模式为 ${agent.permission.mode}。请重新选择或重启后核对。`, true); return; }
    options.onModeChange(mode);
    notify(`${scope === 'project' ? '本项目' : '全局'}权限模式已保存；当前会话模式为 ${mode}。后续权限检查生效，已有审批仍需处理。${!isDeterministic() ? '通用 permissionMode 默认已保存，插件重启时是否采用由该插件决定。' : ''}`);
  };

  function reopenModes(): void {
    let snapshot: PermissionConfigSnapshot;
    try { snapshot = readPermissionConfig(paths.projectConfigPath, 'project'); }
    catch (error) { reportError(error); modeBack(); return; }
    showPicker({ title: '本项目权限模式', initialValue: agent.permission.mode,
      context: `当前: ${agent.permission.mode} · 选择即保存并应用`,
      items: modes.map(mode => ({ value: mode, label: mode, current: mode === agent.permission.mode,
        description: `${modeDescription(mode)}\n${guard()}\n自动保存到本项目，并应用到后续权限检查；已有审批仍需处理。` })),
      onPick: value => { persistProjectMode(snapshot, value as PermissionMode); modeBack(); }, onCancel: () => modeBack(),
    });
  }

  function persistProjectMode(snapshot: PermissionConfigSnapshot, mode: PermissionMode): void {
    if (!modes.includes(mode)) return;
    const draft = copyPermissionDraft(snapshot); draft.permissionMode = mode;
    try {
      agent.permission.validateMode?.(mode);
      if (snapshot.permissionMode === mode) assertPermissionConfigUnchanged(snapshot);
      else savePermissionConfig(snapshot, draft);
    } catch (error) { reportError(error); return; }
    modeSaved('project', mode);
  }

  function openJudgeStatus(back = reopenRoot): void {
    showDetails('当前 auto 审批模型 · 只读', () => `${describeJudgeStatus(agent.loop.getJudgeStatus())}\n\n${isDeterministic() ? '仅策略返回 review 的操作交给审批员；明确 ask/deny 不会交模型降级。' : '仅 auto 模式下，未命中规则的写入/执行操作交给审批员；不确定、调用失败或未加载时询问。'}\n跟随当前模型: /model 切换和恢复会话时随主模型更新。\n显式指定: 保持指定模型；审批模型可独立选择已注册 provider，实际来源以上方运行状态为准。\n\n${guard()}\n已保存的审批模型配置重启后生效；不代表当前已加载的审批员。`, back);
  }

  function openSessionRules(back = reopenRoot): void {
    const snapshot = agent.permission.getSessionRules();
    const entries = kinds.flatMap(kind => snapshot[kind].map((raw, index) => ({ kind, raw, index })));
    if (!entries.length) { showDetails('已记住的会话规则', () => '当前会话没有记住的规则。\n配置规则仍然生效；允许并记住操作产生的规则会显示在这里。', back); return; }
    showPicker({ title: '已记住的会话规则 · 选择即移除', context: '立即作用于后续检查；已保存的会话文件要再次保存才更新',
      items: entries.map((entry, i) => ({ value: String(i), label: `[${entry.kind}] ${safeText(entry.raw)}`, description: `${describePermissionRule(entry.raw)}\n移除后重新按其他规则及当前模式判定，并不等于拒绝。已弹出的审批不变。` })),
      onPick: value => {
        const entry = entries[Number(value)]; if (!entry) return;
        if (!sameRules(snapshot, agent.permission.getSessionRules())) { notify('会话规则已变化，请重新选择要移除的规则。', true); openSessionRules(back); return; }
        const next = { allow: [...snapshot.allow], ask: [...snapshot.ask], deny: [...snapshot.deny] };
        next[entry.kind].splice(entry.index, 1); agent.permission.setSessionRules(next);
        notify('已移除一条会话规则，后续权限检查生效。'); openSessionRules(back);
      }, onCancel: back,
    });
  }

  function openEffectiveRules(back = reopenRoot): void {
    showDetails('当前生效的配置规则 · 只读', () => `${guard()}\n判定顺序: ${isDeterministic() ? 'deny → 不可降级约束/明确 ask → 精确 allow/确定性范围 → review/人工回退。' : '由当前策略插件定义。'}\n同类中会话规则优先于配置；配置内部为全局规则后接项目规则。\n这里是启动时加载的快照，配置规则自动保存后仍需重启才能更新。\n\n${sourceRows.join('\n\n') || '(没有配置规则)'}`, back);
  }

  function openAudit(back = reopenRoot): void {
    showDetails('权限决策日志', () => agent.permission.getAuditLog().map(entry =>
      `[${entry.decision.kind}] ${safeText(entry.summary)}\n${safeText(entry.decision.reason)} · 来源 ${entry.decision.source}`,
    ).join('\n\n') || '(暂无决策记录)', back);
  }

  function openScope(scope: PermissionConfigScope): void {
    const isGlobal = scope === 'global';
    const label = isGlobal ? '全局' : '项目';
    const title = isGlobal ? '全局' : '本项目';
    let global: PermissionConfigSnapshot;
    let project: PermissionConfigSnapshot;
    try { global = readGlobalPermissionConfig(globalPath); project = readPermissionConfig(paths.projectConfigPath, 'project'); }
    catch (error) { reportError(error); rootBack(); return; }
    let snapshot = isGlobal ? global : project;
    let errorText = '';
    const effectiveMode = () => project.permissionMode ?? global.permissionMode ?? 'ask';
    const modeSummary = () => `当前会话模式: ${agent.permission.mode}\n${!isDeterministic() ? '通用启动默认（是否采用由插件决定）' : '本项目启动模式'}: ${effectiveMode()}\n${project.permissionMode === undefined ? `本项目继承全局 / 内置默认 ${global.permissionMode ?? 'ask'}` : `全局默认 ${global.permissionMode ?? 'ask'} 被本项目 ${project.permissionMode} 覆盖`}`;
    const summary = () => `${modeSummary()}\n作用范围: ${isGlobal ? '全局（所有项目，项目覆盖优先）' : '本项目'}\n文件: ${safeText(snapshot.path)}\n审批模型: ${judgeLabel(snapshot.judgeModel, scope)}\n${restartNotice}`;
    const back = () => isGlobal ? reopenRoot() : rootBack();
    const commit = (next: PermissionConfigDraft, applyMode = false): boolean => {
      try {
        // 模式应用依赖两层。选择期间继承层变化时，不把旧显示下的选择应用到新目标。
        if (applyMode) {
          assertPermissionConfigUnchanged(isGlobal ? project : global);
          const mode = isGlobal ? project.permissionMode ?? next.permissionMode ?? 'ask' : next.permissionMode ?? global.permissionMode ?? 'ask';
          agent.permission.validateMode?.(mode);
        }
        if (JSON.stringify(next) === JSON.stringify(copyPermissionDraft(snapshot))) assertPermissionConfigUnchanged(snapshot);
        else snapshot = savePermissionConfig(snapshot, next);
        if (isGlobal) global = snapshot; else project = snapshot;
      } catch (error) { errorText = '未保存，请重新打开设置后重试'; reportError(error); return false; }
      errorText = '';
      if (applyMode) modeSaved(scope, effectiveMode());
      else notify(`${label}权限设置已保存，重启后生效。当前运行中的规则和审批模型不变。`);
      return true;
    };
    const renderScope = () => showPicker({ title: `${title}权限设置`, context: `${errorText || '自动保存'} · 当前 ${agent.permission.mode} · 启动 ${effectiveMode()}`, body: summary,
      items: [
        { value: 'mode', label: `模式 · ${modeLabel(snapshot.permissionMode, scope)}`, description: `${modeSummary()}\n选择即自动保存，并应用本项目合并后的有效模式。已有审批仍需处理。` },
        { value: 'rules', label: `${label}规则 · ${rulesCount(snapshot.permissions)} 条`, description: '添加 / 编辑 / 删除 allow、ask、deny；提交即自动保存，重启后生效。只编辑当前范围，保留其他范围和会话规则。' },
        { value: 'judge', label: `审批模型 · ${judgeLabel(snapshot.judgeModel, scope)}`, description: '选择或 Enter 自动保存，重启后生效。模型名称需与主 provider / endpoint 兼容；独立 provider 请使用审批插件配置。' },
        ...(!isGlobal ? [{ value: 'global', label: '全局设置（可选，影响其他项目）', description: `编辑 ${safeText(globalPath)}；本项目覆盖仍优先。选择即自动保存。` },
          { value: 'inherited', label: `全局继承规则 · ${rulesCount(global.permissions)} 条 · 只读`, description: '全局规则另外合并，不能在本项目删除。' }] : []),
        { value: 'judgeStatus', label: `当前 auto 审批模型 · ${describeJudgeStatus(agent.loop.getJudgeStatus())}`, description: '只读运行状态，已保存的配置在重启前可能不同。' },
        { value: 'session', label: `已记住的会话规则 · ${rulesCount(agent.permission.getSessionRules())} 条`, description: '选择即移除一条会话规则，后续检查生效。' },
        { value: 'effective', label: '当前生效的配置规则 · 只读', description: '查看启动时加载的规则及来源。' },
        { value: 'audit', label: '权限决策日志', description: '查看本进程中的实际判定、原因与来源。' },
        { value: 'back', label: isGlobal ? '返回本项目设置' : '返回设置', description: '返回上一页。' },
      ], onPick: value => {
        if (value === 'mode') showPicker({ title: `${title}权限模式`, initialValue: snapshot.permissionMode ?? 'inherit', context: '选择即保存并应用',
          items: [{ value: 'inherit', label: isGlobal ? '使用内置默认（ask）' : `继承全局 / 内置（${global.permissionMode ?? 'ask'}）`, description: '移除本层覆盖，应用合并后的有效模式。' },
            ...modes.map(mode => ({ value: mode, label: mode, description: `${modeDescription(mode)}\n${guard()}\n自动保存并应用模式；已有审批仍需处理。` }))],
          onPick: mode => { const next = copyPermissionDraft(snapshot); next.permissionMode = mode === 'inherit' ? undefined : mode as PermissionMode; commit(next, true); renderScope(); }, onCancel: renderScope,
        });
        else if (value === 'rules') ruleKinds();
        else if (value === 'judge') editJudge();
        else if (value === 'global') openScope('global');
        else if (value === 'inherited') showDetails('全局继承规则 · 磁盘快照 · 只读', () => `文件: ${safeText(global.path)}\n\n${kinds.flatMap(kind => global.permissions[kind].map(rule => `[${kind}] ${safeText(rule)}\n${describePermissionRule(rule)}`)).join('\n\n') || '(没有全局规则)'}`, renderScope);
        else if (value === 'judgeStatus') openJudgeStatus(renderScope);
        else if (value === 'session') openSessionRules(renderScope);
        else if (value === 'effective') openEffectiveRules(renderScope);
        else if (value === 'audit') openAudit(renderScope);
        else if (value === 'back') back();
      }, onCancel: back,
    });
    const editJudge = () => showPicker({ title: `${label}审批模型`, context: '选择或 Enter 自动保存 · 重启后生效', items: [
      { value: 'name', label: '输入模型名称', description: '仅 auto 使用；复用主 provider / endpoint。输入模型名称，不能输入 API key。' },
      { value: 'inherit', label: isGlobal ? '使用内置默认（跟随当前模型）' : `继承全局（${global.judgeModel ? safeText(global.judgeModel) : '默认跟随当前模型'}）`, description: '移除本层覆盖，重启后生效。' },
      { value: 'current', label: '跟随当前模型', description: `保存为空字符串${isGlobal ? '' : '，覆盖全局审批模型'}。重启后生效，此后随 /model 和恢复会话更新。` },
    ], onPick: value => {
      if (value === 'name') {
        const input = (value = snapshot.judgeModel || '') => showInput({ title: `${label}审批模型名称`, value, description: 'Enter 自动保存，重启后生效；Esc 取消未提交输入。',
          validate: name => !name.trim() || /[\s\u0000-\u001f\u007f-\u009f]/u.test(name) ? '请输入不含空白或控制字符的模型名称。' : undefined,
          onSubmit: name => { const next = copyPermissionDraft(snapshot); next.judgeModel = name; if (commit(next)) renderScope(); else input(name); }, onCancel: editJudge });
        input();
      } else { const next = copyPermissionDraft(snapshot); next.judgeModel = value === 'inherit' ? undefined : ''; commit(next); renderScope(); }
    }, onCancel: renderScope });
    const ruleKinds = () => showPicker({ title: `${label}权限规则`, context: '自动保存 · 重启后生效', items: kinds.map(kind => ({ value: kind, label: `${kind} · ${kindLabels[kind]} · ${snapshot.permissions[kind].length} 条`, description: '选择类型后添加或编辑。deny 优先；提交即自动保存，重启后生效。' })),
      onPick: kind => ruleList(kind as DecisionKind), onCancel: renderScope });
    const ruleList = (kind: DecisionKind): void => showPicker({ title: `${label} ${kind} 规则`, context: `${errorText || '自动保存'} · 重启后生效`,
      items: [{ value: 'add', label: '+ 添加规则', description: '规则示例：read_file、edit_file(src/**)、bash(="npm test")。工具名本身表示该工具的所有调用。' },
        ...snapshot.permissions[kind].map((raw, i) => ({ value: String(i), label: safeText(raw), description: describePermissionRule(raw) }))],
      onPick: value => {
        if (value === 'add') editRule(kind);
        else {
          const index = Number(value); const raw = snapshot.permissions[kind][index]; if (raw === undefined) return;
          showPicker({ title: `${label} ${kind} 规则`, body: () => `${safeText(raw)}\n${describePermissionRule(raw)}`, items: [
            { value: 'edit', label: '编辑规则', description: 'Enter 自动保存，重启后生效。' },
            { value: 'delete', label: '删除规则', description: `选择即从${label}配置删除这一条；重启后生效，其他范围和会话规则不变。` },
          ], onPick: action => {
            if (action === 'edit') editRule(kind, index);
            else { const next = copyPermissionDraft(snapshot); next.permissions[kind].splice(index, 1); commit(next); ruleList(kind); }
          }, onCancel: () => ruleList(kind) });
        }
      }, onCancel: ruleKinds });
    const editRule = (kind: DecisionKind, index?: number, value = index === undefined ? '' : snapshot.permissions[kind][index]) => showInput({ title: `${index === undefined ? '添加' : '编辑'}${label} ${kind} 规则`, value,
      description: '示例 read_file、edit_file(src/**)、bash(="npm test")。Enter 自动保存，重启后生效；Esc 取消未提交输入。', validate: validatePermissionRule,
      onSubmit: value => { const next = copyPermissionDraft(snapshot); const rule = value.trim(); if (index === undefined) next.permissions[kind].push(rule); else next.permissions[kind][index] = rule;
        if (commit(next)) ruleList(kind); else editRule(kind, index, value);
      }, onCancel: () => ruleList(kind) });
    renderScope();
  }
  return {
    open: (onBack?: () => void) => { rootBack = onBack ?? (() => {}); reopenRoot(); },
    openModes: (onBack?: () => void) => { modeBack = onBack ?? (() => {}); reopenModes(); },
    requestMode: (mode: PermissionMode) => {
      ++generation;
      try { persistProjectMode(readPermissionConfig(paths.projectConfigPath, 'project'), mode); } catch (error) { reportError(error); }
    },
    openAudit: () => openAudit(),
  };
}
