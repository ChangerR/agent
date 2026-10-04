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
 * - /model /mode /think 不带参数时弹选择器，无需背名字
 */
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  Spacer,
  Text,
  TuiMainScreen,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type OverlayHandle,
  type SelectListTheme,
  type TUI,
} from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { PermissionRequest, UserDecision } from '../core/events.js';
import type { ThinkingLevel } from '../core/provider.js';
import { emptyUsage, type TokenUsage } from '../core/protocol/types.js';
import type { Agent } from '../index.js';

// ---------------------------------------------------------------------------
// 主题
// ---------------------------------------------------------------------------

const markdownTheme: MarkdownTheme = {
  heading: (s) => chalk.bold.cyan(s),
  link: (s) => chalk.blue(s),
  linkUrl: (s) => chalk.dim(s),
  code: (s) => chalk.yellow(s),
  codeBlock: (s) => chalk.gray(s),
  codeBlockBorder: (s) => chalk.dim(s),
  quote: (s) => chalk.gray.italic(s),
  quoteBorder: (s) => chalk.dim(s),
  hr: (s) => chalk.dim(s),
  listBullet: (s) => chalk.cyan(s),
  bold: (s) => chalk.bold(s),
  italic: (s) => chalk.italic(s),
  strikethrough: (s) => chalk.strikethrough(s),
  underline: (s) => chalk.underline(s),
};

const selectTheme: SelectListTheme = {
  selectedPrefix: (s) => chalk.green(s),
  selectedText: (s) => chalk.green.bold(s),
  description: (s) => chalk.gray(s),
  scrollInfo: (s) => chalk.dim(s),
  noMatch: (s) => chalk.yellow(s),
};

const editorTheme: EditorTheme = {
  borderColor: (s) => chalk.cyan(s),
  selectList: selectTheme,
};

const HELP = `命令（不带参数弹出选择器）：
  /model [name]          查看/切换模型
  /mode [ask|auto|yolo]  查看/切换权限模式
  /think [off|low|medium|high]  查看/设置思考等级
  /permissions           查看权限决策日志
  /skills                列出可用 skill
  /tools                 列出已注册工具
  /redraw                强制全屏重绘（画面残留时用）
  /help                  显示帮助
  /exit                  退出
其他输入直接作为对话发送。Esc 中断当前轮，Ctrl+C 中断/退出。
调试：会话事件全量记录在 .agentlab/logs/session-*.jsonl
画面异常时：先试 /redraw；仍异常可设 AGENTLAB_FULL_REDRAW=1 后重启（关闭差分渲染）。
缓存命中率 = cache 读取 / (cache 读取 + 未命中输入)。分母为 0 时显示为 -。`;

const RENDER_THROTTLE_MS = 60;

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

export function startTui(agent: Agent): void {
  if (!process.stdin.isTTY) {
    // 非 TTY 环境（管道/CI）：打印装配信息后退出，便于 smoke 测试
    console.log('AgentLab（非 TTY 环境，仅展示装配信息）');
    console.log(`providers: ${agent.providers.list().map((p) => p.name).join(', ')}`);
    console.log(`tools: ${agent.tools.list().map((t) => t.name).join(', ')}`);
    console.log(`log: ${agent.logPath}`);
    return;
  }

  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiMainScreen(terminal);

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
  let running = false;
  const queue: string[] = [];

  // --- 固定布局：消息流在上，状态栏与编辑器固定在下 ---
  const status = new Text('', 1, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        { name: 'model', description: '查看/切换模型' },
        { name: 'mode', description: '查看/切换权限模式' },
        { name: 'think', description: '查看/设置思考等级' },
        { name: 'permissions', description: '权限决策日志' },
        { name: 'redraw', description: '强制全屏重绘' },
        { name: 'skills', description: '列出 skill' },
        { name: 'tools', description: '列出工具' },
        { name: 'help', description: '帮助' },
        { name: 'exit', description: '退出' },
      ],
      process.cwd(),
    ),
  );

  // 注意：fullRedraw 模式下 requestRender 已被包装为强制全量，这里无需判断
  const render = () => tui.requestRender();

  const updateStatus = () => {
    status.setText(
      chalk.dim(
        `model: ${model} · mode: ${mode} · think: ${thinking} · tokens: ${fmtTokens(usage.inputTokens)}↑ ${fmtTokens(usage.outputTokens)}↓ · cache ${fmtTokens(usage.cacheReadTokens)}读/${fmtTokens(usage.cacheWriteTokens)}写 (${cacheHitRate(usage)})${running ? ' · 运行中…' : ''}`,
      ),
    );
    status.invalidate();
    render();
  };

  /** 消息组件插入到状态栏之前（children 尾部两个位置留给 status/editor） */
  const addMessage = (comp: Component) => {
    tui.children.splice(tui.children.length - 2, 0, comp);
    tui.invalidate();
    render();
  };

  const say = (text: string) => addMessage(new Text(chalk.yellow(text), 1, 0));
  const err = (text: string) => addMessage(new Text(chalk.red(text), 1, 0));

  // --- 通用选择器弹层 ---
  function showPicker(
    title: string,
    items: Array<{ value: string; label: string; description?: string }>,
    onPick: (value: string) => void,
  ): OverlayHandle {
    const panel = new Container();
    panel.addChild(new Text(chalk.bold.yellow(title), 1, 0));
    const list = new SelectList(items, Math.min(items.length, 10), selectTheme);
    const handle = tui.showOverlay(panel, { anchor: 'bottom-center', width: '70%' });
    const close = () => {
      handle.hide();
      tui.setFocus(editor);
      render();
    };
    list.onSelect = (item) => {
      close();
      onPick(item.value);
    };
    list.onCancel = () => close();
    panel.addChild(list);
    tui.setFocus(list);
    return handle;
  }

  // --- 权限请求弹层 ---
  function showPermissionOverlay(request: PermissionRequest, resolve: (d: UserDecision) => void): void {
    const panel = new Container();
    panel.addChild(new Text(chalk.bold.yellow('权限请求'), 1, 0));
    panel.addChild(new Text(request.summary, 1, 0));
    panel.addChild(new Text(chalk.dim(request.reason), 1, 0));
    const options: Array<{ label: string; decision: UserDecision }> = [
      { label: '允许一次', decision: { allow: true } },
      { label: '本次会话始终允许', decision: { allow: true, remember: 'session' } },
      { label: '本项目始终允许', decision: { allow: true, remember: 'project' } },
      { label: '拒绝', decision: { allow: false } },
    ];
    const list = new SelectList(
      options.map((o, i) => ({ value: String(i), label: o.label })),
      options.length,
      selectTheme,
    );
    const handle = tui.showOverlay(panel, { anchor: 'center', width: '60%' });
    const done = (decision: UserDecision) => {
      handle.hide();
      resolve(decision);
      tui.setFocus(editor);
      render();
    };
    list.onSelect = (item) => done(options[Number(item.value)].decision);
    list.onCancel = () => done({ allow: false });
    panel.addChild(list);
    tui.setFocus(list);
  }

  // --- 流式渲染（节流：Markdown 重排有成本，按 ~60ms 合并 delta） ---
  let currentText: { comp: Markdown; buf: string } | null = null;
  let currentThinking: { comp: Text; buf: string } | null = null;
  let pendingFlush = false;
  let lastFlushAt = 0;

  const flushStreams = () => {
    flushPending();
    currentText = null;
    currentThinking = null;
  };

  const flushPending = () => {
    if (!pendingFlush) return;
    pendingFlush = false;
    lastFlushAt = Date.now();
    if (currentText) {
      currentText.comp.setText(currentText.buf);
      currentText.comp.invalidate();
    }
    if (currentThinking) {
      currentThinking.comp.setText(chalk.gray.italic(currentThinking.buf));
      currentThinking.comp.invalidate();
    }
    render();
  };

  const scheduleFlush = () => {
    if (pendingFlush) return;
    const elapsed = Date.now() - lastFlushAt;
    if (elapsed >= RENDER_THROTTLE_MS) {
      flushPendingNow();
    } else {
      pendingFlush = true;
      setTimeout(flushPending, RENDER_THROTTLE_MS - elapsed);
    }
  };

  const flushPendingNow = () => {
    pendingFlush = true;
    flushPending();
  };

  const appendText = (delta: string) => {
    currentThinking = null;
    if (!currentText) {
      currentText = { comp: new Markdown('', 1, 0, markdownTheme), buf: '' };
      addMessage(currentText.comp);
    }
    currentText.buf += delta;
    scheduleFlush();
  };

  const appendThinking = (delta: string) => {
    currentText = null;
    if (!currentThinking) {
      currentThinking = { comp: new Text('', 1, 0), buf: '' };
      addMessage(currentThinking.comp);
    }
    currentThinking.buf += delta;
    scheduleFlush();
  };

  // --- 事件订阅 ---
  agent.events.on('text_delta', (e) => appendText(e.text));
  agent.events.on('thinking_delta', (e) => appendThinking(e.text));
  agent.events.on('assistant_message', () => flushStreams());
  agent.events.on('tool_call', (e) => {
    flushStreams();
    const tool = agent.tools.get(e.toolUse.name);
    const summary = tool?.analyzeInput?.(e.toolUse.input as Record<string, unknown>).summary ?? e.toolUse.name;
    addMessage(new Text(chalk.magenta(`⏺ ${summary}`), 1, 0));
  });
  agent.events.on('tool_result', (e) => {
    const preview = e.result.content.split('\n').slice(0, 5).join('\n    ').slice(0, 500);
    addMessage(new Text((e.result.isError ? chalk.red : chalk.gray)(`  ⎿ ${preview}`), 1, 0));
  });
  agent.events.on('notice', (e) => say(e.text));
  agent.events.on('compacted', (e) => say(`上下文已压缩：${e.beforeMessages} → ${e.afterMessages} 条消息`));
  agent.events.on('error', (e) => err(e.error.message));
  agent.events.on('turn_end', (e) => {
    usage = {
      inputTokens: usage.inputTokens + e.usage.inputTokens,
      outputTokens: usage.outputTokens + e.usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + e.usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens + e.usage.cacheWriteTokens,
    };
    updateStatus();
  });
  agent.events.on('loop_end', (e) => {
    flushStreams();
    addMessage(new Text(chalk.dim(`— 本轮结束 · ${e.reason} —`), 1, 0));
    addMessage(new Spacer(1));
    running = false;
    updateStatus();
    const next = queue.shift();
    if (next !== undefined) void runTurn(next);
  });
  agent.events.on('permission_request', (e) => showPermissionOverlay(e.request, e.resolve));

  // --- 全局按键：Esc 中断当前轮；Ctrl+C 中断/退出 ---
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.escape) && running && !tui.hasOverlay()) {
      agent.loop.abort_current();
      say('已中断');
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (running) {
        agent.loop.abort_current();
      } else {
        tui.stop();
        process.exit(0);
      }
      return { consume: true };
    }
    return undefined;
  });

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
    updateStatus();
  };

  const setMode = (m: string) => {
    agent.permission.setMode(m as 'ask' | 'auto' | 'yolo');
    mode = m;
    say(`权限模式切换为 ${m}`);
    updateStatus();
  };

  const setThinking = (level: string) => {
    agent.loop.setThinking(level as ThinkingLevel);
    thinking = level as ThinkingLevel;
    say(`思考等级切换为 ${level}`);
    updateStatus();
  };

  const handleCommand = (cmd: string) => {
    const [name, ...rest] = cmd.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case 'exit':
        tui.stop();
        process.exit(0);
      case 'help':
        say(HELP);
        return;
      case 'redraw':
        tui.requestRender(true);
        say('已强制全屏重绘');
        return;
      case 'model': {
        if (arg) {
          setModel(arg);
          return;
        }
        showPicker(
          `选择模型（当前: ${model}）`,
          agent.knownModels.map((m) => ({
            value: m.name,
            label: m.name === model ? `${m.name} ✓` : m.name,
            description: m.info ? `context ${m.info.contextWindow.toLocaleString()} · output ${m.info.maxOutputTokens.toLocaleString()}` : '未知规格',
          })),
          setModel,
        );
        return;
      }
      case 'mode': {
        if (arg === 'ask' || arg === 'auto' || arg === 'yolo') {
          setMode(arg);
          return;
        }
        if (arg) {
          err('用法: /mode ask|auto|yolo');
          return;
        }
        showPicker(
          `权限模式（当前: ${mode}）`,
          [
            { value: 'ask', label: 'ask', description: '每个操作都询问（最安全）' },
            { value: 'auto', label: 'auto', description: '只读自动放行；配置 judgeModel 后写操作由 LLM 审批员把关' },
            { value: 'yolo', label: 'yolo', description: '全部放行（deny 规则与危险检测仍生效），仅限沙箱' },
          ],
          setMode,
        );
        return;
      }
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
            { value: 'off', label: 'off', description: '关闭思考，最快最省' },
            { value: 'low', label: 'low', description: '轻度推理' },
            { value: 'medium', label: 'medium', description: '均衡' },
            { value: 'high', label: 'high', description: '深度推理，慢但适合难题' },
          ],
          setThinking,
        );
        return;
      }
      case 'permissions': {
        const log = agent.permission.getAuditLog();
        say(
          log.length === 0
            ? '(暂无决策记录)'
            : log.map((e) => `[${e.decision.kind}] ${e.summary} — ${e.decision.reason} (${e.decision.source})`).join('\n'),
        );
        return;
      }
      case 'skills': {
        const skills = agent.skillLoader.list();
        say(skills.length === 0 ? '(无可用 skill)' : skills.map((s) => `${s.name}: ${s.description}`).join('\n'));
        return;
      }
      case 'tools':
        say(agent.tools.list().map((t) => `${t.name} [${t.risk}]`).join('\n'));
        return;
      default:
        err(`未知命令: /${name}，输入 /help 查看帮助`);
    }
  };

  // --- 输入 ---
  const runTurn = async (text: string) => {
    running = true;
    updateStatus();
    try {
      await agent.loop.run(text);
    } catch (e) {
      err(e instanceof Error ? e.message : String(e));
      running = false;
      updateStatus();
    }
  };

  editor.onSubmit = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.setText('');
    editor.addToHistory(trimmed);
    if (trimmed.startsWith('/')) {
      handleCommand(trimmed);
      return;
    }
    addMessage(new Spacer(1));
    addMessage(new Text(chalk.blue.bold(`❯ ${trimmed}`), 1, 0));
    if (running) {
      queue.push(trimmed);
      say(`已排队（当前轮结束后发送）：${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}`);
    } else {
      void runTurn(trimmed);
    }
  };

  // --- 启动 ---
  tui.addChild(new Text(chalk.bold.cyan('AgentLab') + chalk.dim(' — 教学版插件式 agent · pi-tui · /help 查看命令'), 1, 1));
  tui.addChild(new Text(chalk.dim(`会话日志: ${agent.logPath}`), 1, 0));
  tui.addChild(new Spacer(1));
  tui.addChild(status);
  tui.addChild(editor);
  updateStatus();
  tui.setFocus(editor);
  tui.start();
}
