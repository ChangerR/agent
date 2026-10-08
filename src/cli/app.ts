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
import { InteractionPanel, type PanelItem } from './interaction-panel.js';
import { TurnQueue } from './turn-queue.js';
import { createPermissionSettings } from './permission-settings.js';
import { SettingsInputPanel } from './settings-input.js';

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

const HELP = `命令（不带参数在底部打开选择器）：
  /model [name]          查看/切换模型
  /mode [ask|auto|yolo]  查看/切换权限模式
  /think [off|low|medium|high]  查看/设置思考等级
  /settings              模型、思考与权限设置
  /permissions           权限设置（会话与项目默认）
  /permissions audit     查看权限决策日志
  /skills                列出可用 skill
  /tools                 列出已注册工具
  /details [编号]        展开/收起全部详情，或查看某条完整内容
  /stats                 查看 token、缓存和日志信息
  /queue clear           清空待发送消息
  /redraw                强制全屏重绘（画面残留时用）
  /help                  显示帮助
  /exit                  退出
其他输入直接作为对话发送。Ctrl+O 展开/收起详情，Esc 中断当前轮并清空排队，Ctrl+C 中断/退出。
选择器：↑↓ 选择，Enter 确认，Esc 返回。审批：先用 ↑↓ 或鼠标选择，再 Enter 确认；Tab 查看完整参数，↑↓ 滚动，Tab 返回选项，Esc 拒绝。
消息区独立滚动，底部保留输入框。AGENTLAB_SCREEN=main 可使用终端原生滚动历史。
调试：会话事件全量记录在 .agentlab/logs/session-*.jsonl
画面异常时：先试 /redraw；仍异常可设 AGENTLAB_FULL_REDRAW=1 后重启（关闭差分渲染）。
缓存命中率 = cache 读取 / (cache 读取 + 未命中输入)。分母为 0 时显示为 -。
  /save                  保存当前会话
  /sessions              列出已保存会话（/sessions rm <id> 删除）
  /resume [id]           恢复会话（无参数弹出选择器，latest 为最近一次）`;

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const delta = Date.now() - then;
  if (delta < 10_000) return '刚刚';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatUpdated(iso);
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  const unsubscribe: Array<() => void> = [];
  const transcript = new Container();
  const header = new Text(ui.accent(chalk.bold('AgentLab')) + ui.dim('  coding agent') + '\n' + ui.muted('/model 切换模型 · /settings 设置 · /help 帮助'), 1, 1);
  const scroll = new ScrollView(transcript, { follow: 'end', primary: true });

  // --- 消息区拥有独立视口，状态与输入不参与历史滚动 ---
  let statusText = '';
  const status: Component = {
    invalidate() {},
    render: (width) => [
      truncateToWidth(ui.dim(` ${mode} · 思考 ${thinking}${width >= 60 ? ` · ${safeTerminalText(basename(agent.cwd))}` : ''}`), width),
      truncateToWidth(ui.muted(` ↑${fmtTokens(usage.inputTokens)} ↓${fmtTokens(usage.outputTokens)} · cache ${cacheHitRate(usage)} · ${safeTerminalText(model)}`), width),
    ],
  };
  const editor = new Composer(tui, { borderColor: ui.border, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 6 });
  editor.status = () => statusText;
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        { name: 'model', description: '查看/切换模型' },
        { name: 'mode', description: '查看/切换权限模式' },
        { name: 'think', description: '查看/设置思考等级' },
        { name: 'settings', description: '模型、思考与权限设置' },
        { name: 'permissions', description: '权限设置与决策日志' },
        { name: 'redraw', description: '强制全屏重绘' },
        { name: 'skills', description: '列出 skill' },
        { name: 'tools', description: '列出工具' },
        { name: 'details', description: '展开/收起工具输出和思考' },
        { name: 'stats', description: 'token、缓存和日志' },
        { name: 'save', description: '保存当前会话' },
        { name: 'sessions', description: '列出会话，rm 删除' },
        { name: 'resume', description: '恢复会话' },
        { name: 'queue', description: '/queue clear 清空排队' },
        { name: 'help', description: '帮助' },
        { name: 'exit', description: '退出' },
      ],
      process.cwd(),
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
    const comp = new ToolMessage(summary, () => expanded, { name: e.toolUse.name, input: e.toolUse.input });
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

  // --- 命令 ---
  const setModel = (name: string) => {
    agent.loop.setModel(name);
    model = name;
    const info = agent.modelInfo(name);
    say(
      info
        ? `模型切换为 ${name}（context: ${info.contextWindow.toLocaleString()} tokens，max output: ${info.maxOutputTokens.toLocaleString()}）`
        : `模型切换为 ${name}（未知规格，压缩阈值保持配置值；可在 models.json 中补充）`,
    );
    say('下一次模型请求生效（可能在本轮内）；不会切换 provider 或 endpoint');
    updateStatus();
  };


  const setThinking = (level: string) => {
    agent.loop.setThinking(level as ThinkingLevel);
    thinking = level as ThinkingLevel;
    say(`思考等级切换为 ${level}（下一次模型请求生效，可能在本轮内）`);
    updateStatus();
  };

  const runAsync = (task: () => Promise<void>) => {
    void task().catch((error) => err(error instanceof Error ? error.message : String(error)));
  };

  const permissions = createPermissionSettings({
    agent, cwd: agent.cwd,
    notify: (text, error) => error ? err(text) : say(text),
    onModeChange: (next) => { mode = next; updateStatus(); },
    showPicker: (request) => {
      picker = new InteractionPanel({
        title: request.title, kind: 'picker', framed: true, items: request.items.map(item => ({ ...item, current: item.value === request.initialValue })),
        initialValue: request.initialValue, context: request.context ? () => request.context! : undefined, body: request.body, requireSelection: request.requireSelection,
        rows: () => terminal.rows, changed: render,
        select: (value) => {
          picker = undefined;
          if (request.requireSelection) suppressEnterUntil = Date.now() + 500;
          request.onPick(value); focusInteraction();
        },
        cancel: () => { picker = undefined; request.onCancel?.(); focusInteraction(); },
      });
      focusInteraction();
    },
    showDetails: (title, body, onBack) => {
      picker = new InteractionPanel({ title, kind: 'details', framed: true, body, rows: () => terminal.rows, changed: render,
        cancel: () => { picker = undefined; onBack(); focusInteraction(); } });
      focusInteraction();
    },
    showInput: (request) => {
      picker = new SettingsInputPanel({ ...request, rows: () => terminal.rows, changed: render,
        onSubmit: value => { picker = undefined; request.onSubmit(value); focusInteraction(); },
        onCancel: () => { picker = undefined; request.onCancel(); focusInteraction(); } });
      focusInteraction();
    },
  });

  const handleCommand = (cmd: string, onBack?: () => void) => {
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'exit':
        exit();
        return;
      case 'help':
        say(HELP);
        return;
      case 'redraw':
        tui.requestRender(true);
        say('已强制全屏重绘');
        return;
      case 'details':
        if (arg) {
          const entry = /^\d+$/.test(arg) ? details.get(Number(arg)) : undefined;
          if (!entry) { err('用法: /details [消息编号]，编号显示在工具与思考旁'); return; }
          picker = new InteractionPanel({
            title: `#${entry.id} ${entry.title}`, kind: 'details', body: entry.body,
            rows: () => terminal.rows, changed: render,
            cancel: () => { picker = undefined; focusInteraction(); },
          });
          focusInteraction();
        } else toggleDetails();
        return;
      case 'stats':
        say(`tokens: ${fmtTokens(usage.inputTokens)} 输入 / ${fmtTokens(usage.outputTokens)} 输出\ncache: ${fmtTokens(usage.cacheReadTokens)} 读 / ${fmtTokens(usage.cacheWriteTokens)} 写 · 命中率 ${cacheHitRate(usage)}\n会话日志: ${agent.logPath}`);
        return;
      case 'queue':
        if (arg === 'clear') say(`已取消 ${turns.clear()} 条排队消息`);
        else say(`待发送 ${turns.size} 条消息，/queue clear 清空`);
        return;
      case 'model': {
        if (arg) {
          setModel(arg);
          return;
        }
        showPicker(
          `选择模型 · ${agent.loop.providerName}`,
          agent.knownModels.map((m) => ({
            value: m.name,
            label: m.name,
            description: `${m.info ? `context ${m.info.contextWindow.toLocaleString()} · output ${m.info.maxOutputTokens.toLocaleString()}` : '未知规格'}\n下一次模型请求生效；需与当前 provider / endpoint 兼容。`,
          })),
          setModel,
          model,
          true,
          onBack,
        );
        return;
      }
      case 'settings':
        showPicker('设置 · 当前会话', [
          { value: 'model', label: `模型 · ${model}`, description: '本次会话；下一次模型请求生效。' },
          { value: 'think', label: `思考 · ${thinking}`, description: '本次会话；下一次模型请求生效。' },
          { value: 'permissions', label: `权限 · ${mode}`, description: '会话审批行为、记住的规则、项目默认与决策日志。' },
        ], value => handleCommand(`/${value}`, () => handleCommand('/settings')), undefined, false, undefined, true);
        return;
      case 'mode':
        if (arg === 'ask' || arg === 'auto' || arg === 'yolo') permissions.requestMode(arg);
        else if (arg) err('用法: /mode ask|auto|yolo');
        else permissions.openModes(onBack);
        return;
      case 'think': {
        if (arg === 'off' || arg === 'low' || arg === 'medium' || arg === 'high') {
          setThinking(arg);
          return;
        }
        if (arg) {
          err('用法: /think off|low|medium|high');
          return;
        }
        showPicker(
          `思考等级（当前: ${thinking}）`,
          [
            { value: 'off', label: 'off', description: '不请求额外推理参数，实际行为由模型决定。下一次模型请求生效。' },
            { value: 'low', label: 'low', description: '请求轻度推理；下一次模型请求生效，模型需支持。' },
            { value: 'medium', label: 'medium', description: '请求均衡推理；下一次模型请求生效，模型需支持。' },
            { value: 'high', label: 'high', description: '请求深度推理；下一次模型请求生效，模型需支持。' },
          ],
          setThinking,
          thinking,
          false,
          onBack,
        );
        return;
      }
      case 'permissions':
        if (arg === 'audit') permissions.openAudit();
        else if (arg) err('用法: /permissions 或 /permissions audit');
        else permissions.open(onBack);
        return;
      case 'skills': {
        const skills = agent.skillLoader.list();
        say(skills.length === 0 ? '(无可用 skill)' : skills.map((s) => `${s.name}: ${s.description}`).join('\n'));
        return;
      }
      case 'tools':
        say(agent.tools.list().map((t) => `${t.name} [${t.risk}]`).join('\n'));
        return;
      case 'save':
        runAsync(async () => {
          const saved = await agent.session.save();
          if (!saved) {
            say('当前会话还没有内容，未保存');
            return;
          }
          const trimmed = saved.trimmed > 0 ? `（尾部 ${saved.trimmed} 条未完成的工具调用未写入）` : '';
          say(`已保存会话 ${saved.id}（${saved.messageCount} 条消息）→ ${saved.path}${trimmed}`);
        });
        return;
      case 'sessions':
        runAsync(async () => {
          if (arg.startsWith('rm')) {
            const id = arg.slice(2).trim();
            if (!id) {
              err('用法: /sessions rm <id>');
              return;
            }
            const removed = await agent.session.delete(id);
            if (!removed) {
              err(`会话 ${id} 不存在`);
              return;
            }
            say(`已删除会话 ${id}`);
            if (id === agent.session.id) say('当前会话已从磁盘删除，下一次保存会重建');
            return;
          }
          if (arg) {
            err('用法: /sessions 或 /sessions rm <id>');
            return;
          }
          const listing = await agent.session.list();
          if (listing.sessions.length === 0 && listing.broken.length === 0) {
            say('(本项目还没有已保存的会话)');
          } else {
            for (const item of listing.sessions) {
              const mark = item.id === agent.session.id ? ' ✓' : '';
              say(`${item.id}${mark} · ${item.title} · ${relativeTime(item.updatedAt)} · ${item.messageCount} 条`);
            }
          }
          for (const item of listing.broken) err(`[坏文件] ${item.id}: ${item.error.message}`);
        });
        return;
      case 'resume':
        runAsync(async () => {
          if (arg) {
            const [id, flag, ...extra] = arg.split(/\s+/);
            if (extra.length || (flag && flag !== '--legacy')) throw new Error('用法: /resume <id> [--legacy]');
            await agent.session.resume(id, { allowLegacyProvider: flag === '--legacy' });
            return;
          }
          const listing = await agent.session.list();
          if (listing.sessions.length === 0) {
            say('(本项目还没有已保存的会话)');
            return;
          }
          showPicker(
            '恢复会话',
            listing.sessions.map((item) => ({
              value: item.id,
              label: item.title,
              description: `${item.id} · ${formatUpdated(item.updatedAt)} · ${item.messageCount} 条`,
            })),
            (value) => {
              void agent.session.resume(value).catch((error) => err(error instanceof Error ? error.message : String(error)));
            },
          );
        });
        return;
      default:
        err(`未知命令: /${name}，输入 /help 查看帮助`);
    }
  };

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
