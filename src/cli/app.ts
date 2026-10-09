/**
 * TUI（pi-tui 版）。
 *
 * 架构原则：这一层只订阅 EventBus、把用户输入交给 loop.run()，不含 agent 逻辑。
 * pi-tui 是命令式组件模型（组件 render(width) → 行数组，TUI 差分渲染）。
 *
 * 可靠性设计：
 * - 流式渲染按 ~60ms 节流（Markdown 解析有成本，不逐 token 重排）
 * - 运行中输入进入队列并给出可见反馈
 * - Esc 中断当前轮；Ctrl+C 先中断、空闲时退出
 * - /model /mode /think 与权限审批共用底部交互区，不遮挡对话
 */
import {
  CombinedAutocompleteProvider,
  Container,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  type Component,
  type TUI,
  type Terminal,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { basename } from 'node:path';
import { Composer } from './composer.js';
import { markdownTheme, selectTheme, ui, thinkingBorder, safeTerminalText } from './theme.js';
import type { PermissionRequest, UserDecision } from '../core/events.js';
import type { ThinkingLevel } from '../core/provider.js';
import { emptyUsage, type TokenUsage } from '../core/protocol/types.js';
import type { Agent } from '../index.js';
import { DetailRegistry, PermissionMessage, renderHistory, StreamMessages, ToolMessage, UserMessage } from './messages.js';
import { PluginToolMessage } from './plugin-renderers.js';
import { observationSnapshot } from '../runtime/plugin-host.js';
import { InteractionPanel, type PanelItem } from './interaction-panel.js';
import { TurnQueue } from './turn-queue.js';
import { describeJudgeStatus } from './permission-settings.js';
import { createTuiAdapter } from '../builtin/tui-command-adapter.js';
import type { TuiAdapter, TuiEntry, TuiPluginContext, BuiltinTuiContext } from './tui-plugins.js';
import type { CommandResult, InteractionRequest, SettingsScope, SettingsScopeTarget } from '../sdk/index.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { SettingsInputPanel } from './settings-input.js';

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

const HELP_FOOTER = `其他输入直接作为对话发送。Ctrl+O 展开/收起详情，Esc 中断当前轮并清空排队，Ctrl+C 中断/退出。
选择器：↑↓ 选择，Enter 确认，Esc 返回。审批需先明确选择；Tab 查看完整参数。
AGENTLAB_SCREEN=main 使用终端原生滚动历史；AGENTLAB_FULL_REDRAW=1 关闭差分渲染。
调试日志默认脱敏，完整正文日志需要显式开启。`;

function summarizeToolCall(tools: Agent['tools'], name: string, input: unknown): string {
  const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return tools.get(name)?.analyzeInput?.(record).summary ?? name;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 命中率 = 缓存读取 / (缓存读取 + 未命中输入)。分母为 0 时没有可比较的输入 */
function cacheHitRate(usage: TokenUsage): string {
  const denom = usage.cacheReadTokens + usage.inputTokens;
  if (denom === 0) return '-';
  return `${Math.round((usage.cacheReadTokens / denom) * 100)}%`;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function startTui(
  agent: Agent,
  options: { terminal?: Terminal; onExit?: () => void; resume?: string; allowLegacySession?: boolean } = {},
): { stop: () => void } | undefined {
  if (!options.terminal && !process.stdin.isTTY) {
    // 非 TTY 环境（管道/CI）：打印装配信息后退出，便于 smoke 测试
    console.log('AgentLab（非 TTY 环境，仅展示装配信息）');
    console.log(`providers: ${agent.providers.list().map((p) => p.name).join(', ')}`);
    console.log(`tools: ${agent.tools.list().map((t) => t.name).join(', ')}`);
    console.log(`log: ${agent.logPath}`);
    return;
  }

  const terminal = options.terminal ?? new ProcessTerminal();
  const tui: TUI = process.env.AGENTLAB_SCREEN === 'main'
    ? new TuiMainScreen(terminal)
    : new TuiAltScreen(terminal, true, undefined, { scrollToEndIndicator: () => ' 回到底部 ' });

  // 保守渲染模式：把 TUI 的 requestRender 本身包一层（编辑器内部的按键/补全渲染
  // 也会走这里），全部强制为全量重绘。差分渲染在某些终端（如 Termius）里
  // 光标序列执行不正常导致残影时，用 AGENTLAB_FULL_REDRAW=1 兜底。
  const fullRedraw = process.env.AGENTLAB_FULL_REDRAW === '1';
  if (fullRedraw) {
    const original = tui.requestRender.bind(tui);
    tui.requestRender = (_force?: boolean) => original(true);
  }

  let model = agent.config.model;
  let mode: string = agent.config.permissionMode;
  let thinking: ThinkingLevel = agent.config.thinking;
  let usage: TokenUsage = emptyUsage();
  let phase = '就绪';
  let expanded = false;
  let startedAt = 0;
  let stopped = false;
  let suppressEnterUntil = 0;
  let picker: Component | undefined;
  let approvalPanel: InteractionPanel | undefined;
  const activePanel = () => approvalPanel ?? picker;
  const details = new DetailRegistry();
  const toolMessages = new Map<string, ToolMessage>();
  const adapters: TuiAdapter[] = [];
  const failedStatuses = new Set<string>();
  const unsubscribe: Array<() => void> = [];
  const transcript = new Container();
  const header = new Text(ui.accent(chalk.bold('AgentLab')) + ui.dim('  coding agent') + '\n' + ui.muted('/model 切换模型 · /settings 设置 · /help 帮助'), 1, 1);
  const scroll = new ScrollView(transcript, { follow: 'end', primary: true });

  // --- 消息区拥有独立视口，状态与输入不参与历史滚动 ---
  let statusText = '';
  const status: Component = {
    invalidate() {},
    render: (width) => [
      truncateToWidth(ui.dim(` ${mode} · 思考 ${thinking}${mode === 'auto' ? ` · 审批 ${describeJudgeStatus(agent.loop.getJudgeStatus())}` : width >= 60 ? ` · ${safeTerminalText(basename(agent.cwd))}` : ''}`), width),
      truncateToWidth(ui.muted(` ↑${fmtTokens(usage.inputTokens)} ↓${fmtTokens(usage.outputTokens)} · cache ${cacheHitRate(usage)} · ${safeTerminalText(model)}`), width),
      ...renderPluginStatus(width),
    ],
  };
  function renderPluginStatus(width: number): string[] {
    const values: string[] = [];
    for (const adapter of adapters) for (const [id, read] of Object.entries(adapter.statusItems ?? {})) {
      if (failedStatuses.has(id)) continue;
      try { const value = read(); if (typeof value !== 'string') throw new Error('状态项必须返回文本'); values.push(safeTerminalText(value)); }
      catch (error) { failedStatuses.add(id); console.error(`可选状态项 ${id} 失败:`, error); }
    }
    return values.length ? [truncateToWidth(ui.dim(` ${values.join(' · ')}`), width)] : [];
  }
  const editor = new Composer(tui, { borderColor: ui.border, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 6 });
  editor.status = () => statusText;
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      agent.commands.list().map(command => ({ name: command.id, description: command.description })),
      agent.cwd,
    ),
  );

  // 注意：fullRedraw 模式下 requestRender 已被包装为强制全量，这里无需判断
  const render = () => { if (!stopped) tui.requestRender(); };

  const updateStatus = () => {
    const elapsed = turns.running ? ` · ${Math.floor((Date.now() - startedAt) / 1000)}s` : '';
    const current = approvalPanel ? '等待你确认权限' : picker ? '选择 / 查看详情' : turns.running ? phase : '就绪';
    statusText = ` ${approvalPanel ? chalk.bold.yellow(`? ${current}`) : turns.running ? chalk.cyan(`● ${current}`) : chalk.dim(current)}${elapsed}${turns.size ? ` · 排队 ${turns.size}` : ''}`;
    editor.borderColor = thinkingBorder(thinking);
    render();
  };
  const setPhase = (next: string) => {
    if (phase === next) return;
    phase = next;
    updateStatus();
  };

  const addMessage = (comp: Component) => {
    transcript.addChild(comp);
    render();
  };

  const say = (text: string) => addMessage(new Text(chalk.yellow(text), 1, 0));
  const err = (text: string) => addMessage(new Text(chalk.red(text), 1, 0));
  const streams = new StreamMessages(markdownTheme, () => expanded, addMessage, render, details);
  const turns = new TurnQueue(async (text) => {
    startedAt = Date.now();
    phase = '等待模型响应';
    addMessage(new Spacer(1));
    addMessage(new UserMessage(text));
    scroll.scrollToEnd();
    updateStatus();
    await agent.loop.run(text);
  }, updateStatus, (error) => err(error instanceof Error ? error.message : String(error)));
  const statusTimer = setInterval(() => { if (turns.running) updateStatus(); }, 1000);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    turns.clear();
    agent.loop.abort_current();
    streams.finish();
    clearInterval(statusTimer);
    unsubscribe.forEach((off) => off());
    tui.stop();
  };
  const exit = () => {
    stop();
    void agent.dispose().then(() => {
      if (options.onExit) options.onExit();
      else process.exit(0);
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  const interrupt = () => {
    const count = turns.clear();
    phase = '正在中断';
    agent.loop.abort_current();
    if (count) say(`已取消 ${count} 条排队消息`);
    updateStatus();
  };

  const focusInteraction = () => {
    tui.setFocus(activePanel() ? interaction : editor);
    updateStatus();
    // 编辑器与面板占用同一个底部位置；切换时清掉旧边框与光标残影。
    if (!stopped) tui.requestRender(true);
  };
  const interaction: Component = {
    invalidate() { activePanel()?.invalidate(); },
    render: (width) => activePanel()?.render(width) ?? [],
    handleInput: (data) => activePanel()?.handleInput?.(data),
    handleMouse: (event) => activePanel()?.handleMouse?.(event),
  };
  const toggleDetails = () => {
    expanded = !expanded;
    transcript.invalidate();
    render();
  };

  // --- 底部选择器（审批优先；关闭后恢复尚未完成的选择） ---
  function showPicker(
    title: string,
    items: PanelItem[],
    onPick: (value: string) => void,
    initialValue?: string,
    filterable = false,
    onCancel?: () => void,
    framed = false,
  ): void {
    const close = () => {
      picker = undefined;
      focusInteraction();
    };
    picker = new InteractionPanel({
      title, kind: 'picker', framed, items: items.map(item => ({ ...item, current: item.value === initialValue })), initialValue, filterable,
      context: initialValue ? () => `当前: ${initialValue} · Enter 应用 · Esc 不更改` : undefined,
      rows: () => terminal.rows, changed: render, cancel: () => { close(); onCancel?.(); },
      select: (value) => { close(); onPick(value); },
    });
    focusInteraction();
  }

  // --- 固定底部审批：完整参数可滚动，选项不会被长正文挤掉 ---
  function showPermissionPanel(request: PermissionRequest, resolve: (d: UserDecision) => void, signal: AbortSignal, next: () => void): void {
    const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {};
    const target = agent.tools.get(request.toolName)?.analyzeInput?.(input).patternTarget;
    const origin = request.decisionSource ? ({ mode: '权限模式', danger: '危险检测', config: '配置规则', session: '会话规则', judge: '自动审批员', builtin: '内置检查', user: '用户' }[request.decisionSource]) : '权限检查';
    const dangerNotice = agent.config.dangerForceAsk ? '拒绝规则与危险检测仍优先' : '拒绝规则仍优先；当前已关闭危险操作强制询问';
    const rememberedScope = target === undefined ? `${request.toolName} 的所有调用` : `${request.toolName} 的相同匹配目标: ${JSON.stringify(target)}`;
    const options: Array<{ label: string; description: string; decision: UserDecision }> = [
      { label: '允许一次', description: '只允许这一次调用，不新增规则。', decision: { allow: true } },
      { label: '允许并记住此规则', description: `允许 ${rememberedScope}。其他参数可能不同。规则随会话保存和恢复；${dangerNotice}。`, decision: { allow: true, remember: 'session' } },
      { label: '拒绝', description: '拒绝这一次调用，Agent 会收到拒绝结果。', decision: { allow: false } },
    ];
    let settled = false;
    const done = (decision: UserDecision, confirmedByEnter = false) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      approvalPanel = undefined;
      // 防止确认键的重复输入落到恢复的草稿或设置面板上。
      if (confirmedByEnter) suppressEnterUntil = Date.now() + 500;
      resolve(decision);
      next();
      focusInteraction();
    };
    const cancel = () => done({ allow: false });
    signal.addEventListener('abort', cancel, { once: true });
    approvalPanel = new InteractionPanel({
      title: 'Agent 正在请求权限 · 需要你确认', compactTitle: 'Agent 请求权限', kind: 'permission',
      items: options.map((o, i) => ({ value: String(i), label: o.label, description: o.description })),
      requireSelection: true,
      body: () => `来源: Agent 执行工具调用${request.toolUseId ? ` #${request.toolUseId}` : ''}\n工具: ${request.toolName}\n触发: ${origin}${request.matchedRule ? ` · ${request.matchedRule}` : ''}\n${request.cwd ? `目录: ${request.cwd}\n` : ''}理由: ${request.reason}\n操作摘要: ${request.summary}\n\n完整参数:\n${JSON.stringify(request.input, null, 2)}`,
      context: () => `${request.toolName} · ${request.summary.replace(/\s+/g, ' ')}`,
      previewBody: () => `触发: ${origin} · ${request.reason}`,
      rows: () => terminal.rows, changed: render, cancel: () => done({ allow: false }),
      select: (value) => done(options[Number(value)].decision, true),
    });
    if (signal.aborted) cancel();
    else focusInteraction();
  }

  // --- 事件订阅 ---
  unsubscribe.push(agent.events.on('text_delta', (e) => {
    setPhase('正在回复');
    streams.append('text', e.text);
  }));
  unsubscribe.push(agent.events.on('thinking_delta', (e) => {
    setPhase('正在思考');
    streams.append('thinking', e.text);
  }));
  unsubscribe.push(agent.events.on('assistant_message', (e) => streams.finish(e.message)));
  unsubscribe.push(agent.events.on('tool_call', (e) => {
    streams.finish();
    const summary = summarizeToolCall(agent.tools, e.toolUse.name, e.toolUse.input);
    const comp = new PluginToolMessage(summary, () => expanded, { name: e.toolUse.name, input: e.toolUse.input },
      () => adapters.map(adapter => adapter.toolRenderers?.[e.toolUse.name]).find(Boolean),
      message => { setTimeout(() => { if (!stopped) err(message); }, 0); });
    comp.detailId = details.add(`工具 · ${e.toolUse.name}`, () => comp.details());
    toolMessages.set(e.toolUse.id, comp);
    phase = `执行工具 · ${e.toolUse.name}`;
    addMessage(comp);
    updateStatus();
  }));
  unsubscribe.push(agent.events.on('tool_result', (e) => {
    let comp = toolMessages.get(e.toolUseId);
    if (!comp) {
      comp = new ToolMessage(e.name, () => expanded);
      addMessage(comp);
    }
    comp.finish(e.result);
    toolMessages.delete(e.toolUseId);
    phase = toolMessages.size ? `执行工具 · ${toolMessages.size} 个任务` : '等待模型响应';
    updateStatus();
  }));
  unsubscribe.push(agent.events.on('notice', (e) => say(e.text)));
  // 后台审核只更新状态栏，自动放行的理由可在 /permissions 与日志里查看。
  unsubscribe.push(agent.events.on('model_request', (e) => {
    if (e.purpose === 'judge') setPhase('自动审核工具权限');
  }));
  unsubscribe.push(agent.events.on('compacted', (e) => say(`上下文已压缩：${e.beforeMessages} → ${e.afterMessages} 条消息`)));
  unsubscribe.push(agent.events.on('error', (e) => err(e.error.message)));
  unsubscribe.push(agent.events.on('model_usage', (e) => {
    usage = {
      inputTokens: usage.inputTokens + e.usage.inputTokens,
      outputTokens: usage.outputTokens + e.usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + e.usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens + e.usage.cacheWriteTokens,
    };
    updateStatus();
  }));
  unsubscribe.push(agent.events.on('loop_end', (e) => {
    streams.finish();
    if (e.reason === 'aborted') say('本轮已中断');
    if (e.reason === 'max_turns') say('已达到轮次上限，可继续输入');
    if (e.reason === 'max_tokens') say('回复达到输出上限，内容可能不完整');
    addMessage(new Spacer(1));
    toolMessages.clear();
  }));
  unsubscribe.push(agent.events.on('session_saved', (e) => {
    if (e.trimmed > 0) say(`尾部 ${e.trimmed} 条未完成的工具调用未写入`);
  }));
  // 并行工具可能同时询问；审批逐个显示，避免争抢底部交互区。
  type Approval = Extract<import('../core/events.js').AgentEvent, { type: 'permission_request' }>;
  const approvals: Approval[] = [];
  let approving = false;
  const nextApproval = () => {
    approving = false;
    if (stopped) return;
    while (approvals.length) {
      const approval = approvals.shift()!;
      if (approval.signal.aborted) continue;
      approving = true;
      phase = '等待你确认权限';
      updateStatus();
      showPermissionPanel(approval.request, approval.resolve, approval.signal, nextApproval);
      return;
    }
    phase = '等待执行工具';
    updateStatus();
  };
  unsubscribe.push(agent.events.on('permission_request', (e) => {
    const comp = new PermissionMessage(e.request);
    comp.detailId = details.add(`权限 · ${e.request.toolName}`, () => comp.details());
    addMessage(comp);
    const cancelRecord = () => { comp.finish('已中断'); render(); };
    e.signal.addEventListener('abort', cancelRecord, { once: true });
    approvals.push({ ...e, resolve: (decision) => {
      e.signal.removeEventListener('abort', cancelRecord);
      comp.finish(e.signal.aborted ? '已中断' : decision.allow ? decision.remember ? '已允许并记住' : '已允许一次' : '已拒绝');
      e.resolve(decision);
      render();
    } });
    if (!approving) nextApproval();
  }));
  unsubscribe.push(agent.events.on('session_restored', (e) => {
    streams.finish();
    toolMessages.clear();
    approvals.length = 0;
    approving = false;
    picker = undefined;
    approvalPanel = undefined;
    transcript.clear();
    details.clear();
    transcript.addChild(header);
    for (const comp of renderHistory(e.messages, {
      theme: markdownTheme,
      expanded: () => expanded,
      summarize: (name, input) => summarizeToolCall(agent.tools, name, input),
      details,
    })) {
      transcript.addChild(comp);
    }
    transcript.addChild(new Spacer(1));
    model = e.model;
    thinking = e.thinking;
    mode = agent.permission.mode;
    usage = {
      inputTokens: e.usage.inputTokens,
      outputTokens: e.usage.outputTokens,
      cacheReadTokens: e.usage.cacheReadTokens,
      cacheWriteTokens: e.usage.cacheWriteTokens,
    };
    say(`已恢复会话 ${e.id}（${e.title}）`);
    transcript.invalidate();
    scroll.scrollToEnd();
    focusInteraction();
  }));

  // --- 全局按键：Esc 中断当前轮；Ctrl+C 中断/退出 ---
  unsubscribe.push(tui.addInputListener((data) => {
    if (matchesKey(data, Key.enter) && Date.now() < suppressEnterUntil) {
      return { consume: true };
    }
    if (!matchesKey(data, Key.enter)) suppressEnterUntil = 0;
    if (matchesKey(data, Key.escape) && turns.running && !activePanel() && !tui.hasOverlay()) {
      interrupt();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (activePanel() && (!turns.running || !approvalPanel)) {
        activePanel()?.handleInput?.('\x1b');
        return { consume: true };
      }
      if (turns.running) {
        interrupt();
      } else {
        exit();
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('o')) && !activePanel()) {
      toggleDetails();
      return { consume: true };
    }
    return undefined;
  }));

  // --- 命令：注册表负责发现与调用，插件的可选 entry 负责专用终端交互。 ---
  const refreshStatus = () => {
    model = agent.loop.model; thinking = agent.loop.thinking; mode = agent.permission.mode; updateStatus();
  };
  const showDetails = (title: string, body: () => string, onBack?: () => void, framed = false) => {
    picker = new InteractionPanel({ title, kind: 'details', framed, body, rows: () => terminal.rows, changed: render,
      cancel: () => { picker = undefined; onBack?.(); focusInteraction(); } }); focusInteraction();
  };
  const showInput: TuiPluginContext['showInput'] = request => {
    picker = new SettingsInputPanel({ ...request, rows: () => terminal.rows, changed: render,
      onSubmit: value => { picker = undefined; request.onSubmit(value); focusInteraction(); },
      onCancel: () => { picker = undefined; request.onCancel(); focusInteraction(); } }); focusInteraction();
  };
  const adapterContext: BuiltinTuiContext = {
    agent, cwd: agent.cwd, dispatchCommand: agent.dispatchCommand, invokeTool: agent.invokeTool,
    inspect: () => observationSnapshot({ commands: agent.commands.list(),
      settings: agent.settings.map(({ id, ownerPlugin, section }) => ({ id, ownerPlugin, title: section.title, description: section.description, applyMode: section.applyMode })),
      plugins: agent.plugins.manifests.map(({ id, version }) => ({ id, version })), tools: agent.tools.list().map(({ name, risk }) => ({ name, risk })),
    }), say, error: err, showPicker, showDetails, showInput, updateStatus: refreshStatus,
    exit, redraw: () => tui.requestRender(true), toggleDetails, detail: id => details.get(id), usage: () => usage,
    queue: { size: () => turns.size, clear: () => turns.clear() },
    showPermissionPicker: request => {
      picker = new InteractionPanel({ title: request.title, kind: 'picker', framed: true,
        items: request.items.map(item => ({ ...item, current: item.value === request.initialValue })),
        initialValue: request.initialValue, context: request.context ? () => request.context! : undefined,
        body: request.body, requireSelection: request.requireSelection, rows: () => terminal.rows, changed: render,
        select: value => { picker = undefined; if (request.requireSelection) suppressEnterUntil = Date.now() + 500; request.onPick(value); focusInteraction(); },
        cancel: () => { picker = undefined; request.onCancel?.(); focusInteraction(); },
      }); focusInteraction();
    },
  };
  const { agent: _privateAgent, ...publicContext } = adapterContext;
  Object.freeze(publicContext);
  const installAdapter = (adapter: TuiAdapter) => {
    for (const key of ['commands', 'settings', 'toolRenderers', 'statusItems'] as const) {
      for (const [id, handler] of Object.entries(adapter[key] ?? {})) {
        if (typeof handler !== 'function') throw new Error(`无效 TUI ${key}: ${id}`);
        if (adapters.some(existing => existing[key]?.[id])) throw new Error(`重复 TUI ${key}: ${id}`);
      }
    }
    adapters.push(adapter);
    render();
  };
  const pendingAdapters: Promise<void>[] = [];
  for (const { implementation: descriptor } of agent.plugins.tui) {
    // 内置入口随 CLI 同步加载，保留首个按键和连续输入的原有时序。
    if (descriptor.entry === 'agentlab:builtin-ui') { installAdapter(createTuiAdapter(adapterContext)); continue; }
    const entry = descriptor.entry.startsWith('.') || descriptor.entry.startsWith('/')
      ? pathToFileURL(resolve(agent.cwd, descriptor.entry)).href : descriptor.entry;
    pendingAdapters.push(import(entry).then(async (module: TuiEntry) => {
      if (typeof module.createTuiAdapter !== 'function') throw new Error(`TUI entry 缺少 createTuiAdapter: ${descriptor.entry}`);
      const adapter = await module.createTuiAdapter(publicContext);
      if (stopped) { await adapter.dispose?.(); return; }
      installAdapter(adapter);
    }).catch(error => err(`可选界面加载失败: ${error instanceof Error ? error.message : String(error)}`)));
  }
  unsubscribe.push(() => { for (const adapter of adapters) void Promise.resolve(adapter.dispose?.()).catch(error => console.error(error)); });
  const commandController = new AbortController();
  unsubscribe.push(() => commandController.abort());
  const interact = (request: InteractionRequest): Promise<string | undefined> => new Promise(resolve => {
    if (stopped) { resolve(undefined); return; }
    let settled = false;
    const done = (value?: string) => { if (settled) return; settled = true; commandController.signal.removeEventListener('abort', cancel); resolve(value); };
    const cancel = () => done(); commandController.signal.addEventListener('abort', cancel, { once: true });
    if (request.kind === 'input') { showInput({ title: request.prompt, value: request.initialValue ?? '', description: request.body ?? '', onSubmit: done, onCancel: cancel }); return; }
    if (request.kind === 'details' || !request.choices?.length) { showDetails(request.prompt, () => request.body ?? '', cancel); return; }
    adapterContext.showPermissionPicker({ title: request.prompt,
      items: request.choices.map(choice => ({ value: choice.id, label: choice.label, description: choice.description })),
      initialValue: request.initialValue, body: request.body ? () => request.body! : undefined, requireSelection: request.requireSelection,
      onPick: done, onCancel: cancel,
    });
  });
  const showResult = async (result: CommandResult): Promise<void> => {
    if (!result) return;
    if (result.type === 'text') say(result.text);
    else if (result.type === 'data') say(result.text ?? JSON.stringify(result.data, null, 2));
    else await interact(result);
    refreshStatus();
  };
  const scopeLabel = (scope: SettingsScope): string => ({ session: '本次会话', project: '本项目', global: '全局' })[scope];
  const targetDescription = (target: SettingsScopeTarget): string => target.scope === 'session'
    ? '本次会话；不写配置文件。'
    : `作用域: ${scopeLabel(target.scope)}\n保存路径: ${target.path}${target.scope === 'global' ? '\n影响所有继承此全局配置的项目；项目覆盖仍优先。' : ''}`;
  let settingsGeneration = 0;
  const openSetting = (id: string, selectedScope?: SettingsScope) => {
    const generation = ++settingsGeneration;
    const record = agent.settings.find(setting => setting.id === id); if (!record) return;
    const specialized = adapters.map(adapter => adapter.settings?.[id]).find(Boolean);
    if (specialized) { specialized(openSettings); return; }
    const section = record.section;
    const targets: readonly SettingsScopeTarget[] = section.scopeTargets ?? [];
    if (!selectedScope && targets.length > 1) {
      showPicker(`${section.title} · 选择作用域`, targets.map(target => ({ value: target.scope, label: scopeLabel(target.scope), description: targetDescription(target) })),
        value => openSetting(id, value as SettingsScope), undefined, false, openSettings, true);
      return;
    }
    const target = targets.find(target => target.scope === (selectedScope ?? targets[0]?.scope));
    if (selectedScope && !target) { err('此设置不支持所选作用域。'); return; }
    const scope = target?.scope;
    const readonly = !section.draft || !section.commit;
    const label = scope ? scopeLabel(scope) : readonly ? '当前运行' : '插件定义';
    const title = `${section.title} · ${label}`;
    const destination = target ? targetDescription(target) : readonly ? '当前运行的只读状态。' : '插件未声明保存目标；保存位置与作用域由插件定义。';
    const back = () => targets.length > 1 ? openSetting(id) : openSettings();
    showDetails(title, () => `${destination}\n正在读取设置…`, back, true);
    void (async () => {
      const value = await section.read?.(commandController.signal, scope);
      if (stopped || generation !== settingsGeneration) return;
      const body = `${destination}\n拥有者: ${record.ownerPlugin}\n生效时机: ${section.applyMode}\n${section.description ?? ''}\n运行配置来源: ${JSON.stringify(record.sources ?? {})}\n实现: ${(record.implementations ?? []).join(', ')}\n${section.draft && section.commit ? '所选层原始值' : '只读状态'}:\n${JSON.stringify(value ?? null, null, 2)}`;
      if (!section.draft || !section.commit) { showDetails(`${title} · 只读`, () => body, back); return; }
      showPicker(title, [{ value: 'view', label: '查看当前值', description: body }, { value: 'edit', label: '编辑草稿', description: `${destination}\n编辑 JSON；只有明确 Save 才提交。` }], action => {
        if (action === 'view') { showDetails(title, () => body, () => openSetting(id, scope)); return; }
        showInput({ title: `${title} · 草稿`, value: JSON.stringify(value ?? null), description: `${destination}\n输入 JSON；Enter 创建草稿，尚未保存。`,
          validate: text => { try { JSON.parse(text); return undefined; } catch { return '请输入合法 JSON'; } },
          onCancel: () => openSetting(id, scope), onSubmit: text => {
            showDetails(title, () => `${destination}\n正在验证草稿…`, () => openSetting(id, scope), true);
            void (async () => {
              const draft = await section.draft!(JSON.parse(text), commandController.signal, scope);
              if (stopped || generation !== settingsGeneration) return;
              const choice = await interact({ type: 'interaction', id: `settings:${id}:${scope ?? 'plugin'}:save`, kind: 'confirm', prompt: `确认 Save · ${title}`, body: `${destination}\n生效时机: ${section.applyMode}\n${JSON.stringify(draft, null, 2)}`, requireSelection: true, choices: [{ id: 'cancel', label: '取消' }, { id: 'save', label: `Save · ${label}` }] });
              if (stopped || generation !== settingsGeneration) return;
              if (choice === 'save') { await section.commit!(draft, commandController.signal, scope); say(`已保存 ${title}；${target ? target.scope === 'session' ? '不写配置文件' : `保存路径: ${target.path}` : '保存目标由插件定义'}；生效时机: ${section.applyMode}`); }
              if (!stopped && generation === settingsGeneration) openSetting(id, scope);
            })().catch(error => {
              if (stopped || generation !== settingsGeneration) return;
              const message = error instanceof Error ? error.message : String(error);
              showDetails(`${title} · 设置失败`, () => `${destination}\n${message}\n本次输入（返回后重新读取最新配置）:\n${text}`, () => openSetting(id, scope), true);
            });
          },
        });
      }, undefined, false, back, true);
    })().catch(error => {
      if (stopped || generation !== settingsGeneration) return;
      showDetails(`${title} · 读取失败`, () => `${destination}\n${error instanceof Error ? error.message : String(error)}`, back, true);
    });
  };
  function openSettings(): void {
    ++settingsGeneration;
    showPicker('设置 · 本次会话 / 本项目 / 全局', [...agent.settings].sort((a, b) => (a.section.order ?? 100) - (b.section.order ?? 100)).map(({ id, section, ownerPlugin }) => ({
      value: id, label: section.title,
      description: `作用域: ${section.scopeTargets?.map(target => scopeLabel(target.scope)).join(' / ') ?? (!section.draft && !section.commit && !adapters.some(adapter => adapter.settings?.[id]) ? '当前运行 · 只读状态' : '插件定义（未声明保存目标）')}\n${section.description ?? ''}\n拥有者: ${ownerPlugin} · 生效时机: ${section.applyMode}`,
    })), openSetting, undefined, false, undefined, true);
  }
  const frontendCommands: Record<string, (arg: string) => void> = {
    settings: () => openSettings(),
    help: () => say(`命令（由已加载插件提供）：\n${agent.commands.list().map(command => `  /${command.id}  ${command.description}`).join('\n')}\n${HELP_FOOTER}`),
  };
  const dispatch = (line: string) => {
    ++settingsGeneration;
    const [name, ...rest] = line.slice(1).trim().split(/\s+/); const arg = rest.join(' ');
    if (!agent.commands.has(name)) { err(`未知命令: /${name}，输入 /help 查看帮助`); return; }
    const frontend = frontendCommands[name]; if (frontend) { frontend(arg); return; }
    const specialized = adapters.map(adapter => adapter.commands?.[name]).find(Boolean);
    if (specialized) { void Promise.resolve(specialized(arg)).catch(error => err(error instanceof Error ? error.message : String(error))); return; }
    void agent.dispatchCommand(line, { signal: commandController.signal, interact }).then(showResult).catch(error => err(error instanceof Error ? error.message : String(error)));
  };
  let adaptersReady = pendingAdapters.length === 0;
  const ready = Promise.all(pendingAdapters).then(() => { adaptersReady = true; });
  const handleCommand = (line: string) => { if (adaptersReady) dispatch(line); else void ready.then(() => { if (!stopped) dispatch(line); }); };

  // --- 输入 ---
  editor.onSubmit = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.setText('');
    editor.addToHistory(trimmed);
    if (trimmed.startsWith('/')) {
      handleCommand(trimmed);
      return;
    }
    turns.submit(trimmed);
  };

  // --- 启动 ---
  transcript.addChild(header);
  if (agent.paths?.cwd && agent.paths.cwd !== agent.cwd) {
    transcript.addChild(new Text(ui.muted(`启动目录: ${safeTerminalText(agent.paths.cwd)}\n工具执行/权限基准: ${safeTerminalText(agent.cwd)}（项目根目录）`), 1, 0));
  }
  const hints: Component = {
    invalidate() {},
    render: (width) => terminal.rows < 16 ? [] : [truncateToWidth(ui.dim(turns.running
      ? ` Enter 排队 · Esc 中断${turns.size ? '并清空队列' : ''} · Ctrl+O 详情`
      : ` Enter 发送 · Shift+Enter 换行 · Ctrl+O ${expanded ? '收起' : '详情'}`), width)],
  };
  const queuePreview: Component = {
    invalidate() {},
    render: (width) => turns.size ? [truncateToWidth(ui.muted(` ↳ 排队 ${turns.size} · 下一条: ${safeTerminalText(turns.next ?? '').replace(/\s+/g, ' ')}`), width)] : [],
  };
  const footer = new VStack([
    { component: { invalidate() {}, render: (width: number) => terminal.rows >= 16 ? [truncateToWidth(statusText, width)] : [] }, visible: () => !!activePanel() },
    { component: interaction, visible: () => !!activePanel() },
    { component: new VStack([queuePreview, editor, hints]), visible: () => !activePanel() },
    status,
  ]);
  if (isViewportTUI(tui)) {
    tui.setLayoutRoot(new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 0, minSize: 3 },
    ]));
  } else {
    tui.addChild(transcript);
    tui.addChild(footer);
  }
  updateStatus();
  tui.setFocus(editor);
  tui.start();
  if (options.resume) {
    void agent.session.resume(options.resume, { allowLegacyProvider: options.allowLegacySession }).catch((error) => err(error instanceof Error ? error.message : String(error)));
  }
  return { stop };
}
