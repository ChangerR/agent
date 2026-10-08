import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TuiAltScreen, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type Terminal } from '@earendil-works/pi-tui';
import { startTui } from '../src/cli/app.js';
import { DetailRegistry, renderHistory, StreamMessages, ToolMessage } from '../src/cli/messages.js';
import { InteractionPanel } from '../src/cli/interaction-panel.js';
import { TurnQueue } from '../src/cli/turn-queue.js';
import { SUMMARY_MARKER } from '../src/core/context/manager.js';
import type { Message } from '../src/core/protocol/types.js';
import { saveSession } from '../src/core/session/store.js';
import { createAgent } from '../src/index.js';
import { FakeProvider } from '../src/providers/fake.js';

const identity = (s: string) => s;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity,
  codeBlock: identity, codeBlockBorder: identity, quote: identity, quoteBorder: identity,
  hr: identity, listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const text = (comp: Component, width = 80) => comp.render(width).map(stripTerminalSequences).join('\n');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('TUI 消息与调度', () => {
  it('折叠工具按可见行限高，完整输出与参数仍能展开，失败突出显示', () => {
    let expanded = false;
    const tool = new ToolMessage('read_file: 长路径', () => expanded, { name: 'read_file', input: { path: '完整参数路径' } });
    tool.finish({ content: '中文长行'.repeat(300) + '\n末尾' });
    expect(tool.render(24)).toHaveLength(2);
    expect(text(tool, 24)).toContain('2 行输出');
    expanded = true;
    expect(text(tool, 80)).toContain('完整参数路径');
    expect(text(tool, 80)).toContain('末尾');
    expanded = false;
    tool.finish({ content: '错误原因\n修复方法\n第三行\n末尾', isError: true });
    expect(tool.render(24)).toHaveLength(4);
    expect(text(tool, 24)).toContain('失败');
    expect(text(tool, 24)).toContain('错误原因');
  });

  it('框内不执行工具来源的 ANSI/OSC 控制序列，独立详情提示真实可用按键', () => {
    const panel = new InteractionPanel({ title: '工具\x1b[2J标题', kind: 'details', rows: () => 12,
      body: () => '\x1b]52;c;clipboard\x07可见正文\x1b[31m红色', changed: vi.fn(), cancel: vi.fn() });
    const raw = panel.render(40).join('\n');
    expect(raw).not.toContain('\x1b[2J');
    expect(raw).not.toContain('\x1b]52');
    const display = stripTerminalSequences(raw);
    expect(display).toContain('可见正文');
    expect(display).toContain('Esc 返回');
    expect(display).not.toContain('返回选项');
  });

  it('详情支持翻页与首尾跳转，返回选项不会授权', () => {
    const select = vi.fn();
    const panel = new InteractionPanel({ title: '权限', kind: 'permission', rows: () => 24,
      items: [{ value: 'once', label: '允许一次' }], body: () => Array.from({ length: 60 }, (_, i) => `参数 ${i}`).join('\n'),
      changed: vi.fn(), select, cancel: vi.fn(),
    });
    panel.handleInput('\t'); panel.render(40);
    panel.handleInput('\x1b[F');
    expect(text(panel, 40)).toContain('参数 59');
    panel.handleInput('\x1b[H');
    expect(text(panel, 40)).toContain('参数 0');
    panel.handleInput('\x1b[6~');
    expect(text(panel, 40)).not.toContain('参数 0\n');
    panel.handleInput('\r');
    expect(select).not.toHaveBeenCalled();
  });

  it('详情编号保留完整参数与实时结果，清空后不引用旧会话', () => {
    const registry = new DetailRegistry();
    const operation = { name: 'bash', input: { command: '多行命令\n完整结尾' } };
    const tool = new ToolMessage('工具摘要', () => false, operation);
    const id = registry.add('工具', () => tool.details());
    expect(registry.get(id)?.body()).toContain('正在执行');
    tool.finish({ content: '完整输出结尾', isError: true });
    expect(registry.get(id)?.body()).toContain('完整结尾');
    expect(registry.get(id)?.body()).toContain('完整输出结尾');
    registry.clear();
    expect(registry.get(id)).toBeUndefined();
    expect(registry.add('新会话', () => '新内容')).toBe(1);
  });

  it('极小面板仍能选到拒绝，鼠标点击不会直接授权，尺寸与内容宽度有界', () => {
    let rows = 6;
    const select = vi.fn();
    const panel = new InteractionPanel({ title: '权限请求', kind: 'permission', rows: () => rows,
      items: [{ value: 'once', label: '允许一次' }, { value: 'remember', label: '记住' }, { value: 'deny', label: '拒绝' }],
      body: () => '长正文'.repeat(100), changed: vi.fn(), select, cancel: vi.fn(),
    });
    expect(panel.render(20)).toHaveLength(3);
    panel.handleInput('\x1b[A');
    expect(text(panel, 20)).toContain('拒绝');
    panel.handleMouse({ type: 'click', button: 'left', x: 1, y: 1, screenX: 1, screenY: 1, width: 20, height: 3, shift: false, alt: false, ctrl: false });
    expect(select).not.toHaveBeenCalled();
    panel.handleInput('\r');
    expect(select).toHaveBeenCalledWith('deny');
    rows = 24;
    for (const line of panel.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });

  it('刷新前切换思考/正文，旧块内容仍完整，结束时清理刷新任务', () => {
    vi.useFakeTimers();
    const components: Component[] = [];
    const streams = new StreamMessages(theme, () => true, (comp) => components.push(comp), vi.fn());
    streams.append('thinking', '思考末尾');
    streams.append('text', '正文末尾');
    streams.append('thinking', '补充思考');
    streams.finish();
    expect(components.map((comp) => text(comp))).toEqual([
      expect.stringContaining('思考末尾'), expect.stringContaining('正文末尾'), expect.stringContaining('补充思考'),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('流式刷新合并增量，最终使用完整消息校准正文', () => {
    vi.useFakeTimers();
    const components: Component[] = [];
    const render = vi.fn();
    const streams = new StreamMessages(theme, () => false, (comp) => components.push(comp), render);
    streams.append('text', 'a');
    streams.append('text', 'b');
    const before = render.mock.calls.length;
    vi.advanceTimersByTime(60);
    expect(render).toHaveBeenCalledTimes(before + 1);
    expect(text(components[0])).toContain('ab');
    streams.finish({ role: 'assistant', content: [{ type: 'text', text: '完整回复' }] });
    expect(text(components[0])).toContain('完整回复');
  });

  it('排队要等上一轮清理结束，中断时清空待发送输入', async () => {
    const order: string[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const queue = new TurnQueue(async (input) => {
      order.push(`start ${input}`);
      if (input === 'a') await gate;
      order.push(`cleanup ${input}`);
    }, vi.fn(), vi.fn());
    queue.submit('a');
    queue.submit('b');
    queue.submit('c');
    expect(queue.size).toBe(2);
    finish();
    await vi.waitFor(() => expect(queue.running).toBe(false));
    expect(order).toEqual(['start a', 'cleanup a', 'start b', 'cleanup b', 'start c', 'cleanup c']);

    let release!: () => void;
    const interrupted = new TurnQueue(() => new Promise<void>((resolve) => { release = resolve; }), vi.fn(), vi.fn());
    interrupted.submit('active');
    interrupted.submit('pending');
    expect(interrupted.clear()).toBe(1);
    release();
    await vi.waitFor(() => expect(interrupted.running).toBe(false));
  });

  it('并行工具按各自组件更新，展开可查看被收起的完整输出', () => {
    let expanded = false;
    const first = new ToolMessage('读取甲', () => expanded);
    const second = new ToolMessage('读取乙', () => expanded);
    second.finish({ content: '乙结果' });
    first.finish({ content: '甲一\n甲二\n甲三' });
    expect(text(first)).not.toContain('甲三');
    expect(text(second)).toContain('乙结果');
    expanded = true;
    expect(text(first)).toContain('甲三');
    for (const line of first.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
  });
});

/** 用真实 pi-tui 渲染到内存终端，避免真实网络与交互终端依赖。 */
class MemoryTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = '';
  input?: (data: string) => void;
  resize?: () => void;
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

async function mountTui(config: Record<string, unknown> = {}) {
  vi.stubEnv('AGENTLAB_SCREEN', 'alt');
  let renderer!: TuiAltScreen;
  const originalStart = TuiAltScreen.prototype.start;
  vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function (this: TuiAltScreen) {
    renderer = this;
    originalStart.call(this);
  });
  const dir = await mkdtemp(join(tmpdir(), 'agentlab-ui-'));
  await writeFile(join(dir, 'agent.config.json'), JSON.stringify({ provider: 'fake', permissionMode: 'auto', ...config }));
  const agent = await createAgent(dir);
  const terminal = new MemoryTerminal();
  const session = startTui(agent, { terminal, onExit: vi.fn() });
  const screen = () => renderer.getScreenLines().map(stripTerminalSequences);
  const send = (command: string) => { terminal.input?.(command); terminal.input?.('\r'); };
  return {
    agent, terminal, screen, send, renderer: () => renderer,
    async dispose() { session?.stop(); await agent.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

/** 可选保存真实渲染的文本屏幕供人工 QA，不影响默认测试。 */
async function snapshot(name: string, lines: string[]) {
  const outputDir = process.env.AGENTLAB_TUI_SNAPSHOT_DIR;
  if (outputDir) await writeFile(join(outputDir, `tui-${name}.txt`), lines.join('\n'));
}

describe('TUI 审批模型运行状态', () => {
  it.each([
    { judgeModel: '', before: 'initial-model（跟随当前模型）', after: 'changed-model（跟随当前模型）' },
    { judgeModel: 'fixed-reviewer', before: 'fixed-reviewer（显式指定）', after: 'fixed-reviewer（显式指定）' },
  ])('auto 底栏展示实际加载模型，切换主模型时来源为 $judgeModel', async ({ judgeModel, before, after }) => {
    const ui = await mountTui({ model: 'initial-model', judgeModel });
    try {
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain(`审批 已加载 ${before}`));
      ui.send('/model changed-model');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain(`审批 已加载 ${after}`));
      ui.send('/permissions');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('auto 审批模型'));
      expect(ui.screen().join('\n')).toContain(`已加载 ${after}`);
    } finally { await ui.dispose(); }
  });

  it('运行时未加载时底栏不把已配置模型显示成已加载', async () => {
    const ui = await mountTui({ judgeModel: 'configured-reviewer' });
    try {
      vi.spyOn(ui.agent.loop, 'getJudgeStatus').mockReturnValue({ loaded: false });
      ui.send('/redraw');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('审批 未加载'));
      expect(ui.screen().slice(-8).join('\n')).not.toContain('审批 已加载');
    } finally { await ui.dispose(); }
  });
});

describe('真实 TUI 离线交互', () => {
  it('设置入口可返回，项目默认单独确认 Save，浏览与草稿不修改运行权限', async () => {
    const ui = await mountTui();
    const file = join(ui.agent.cwd, 'agent.config.json');
    const before = await readFile(file, 'utf8');
    const down = () => ui.terminal.input?.('\x1b[B');
    const enter = () => ui.terminal.input?.('\r');
    try {
      ui.send('/settings'); down(); enter();
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('思考等级'));
      ui.terminal.input?.('\x1b');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('设置 · 当前会话'));
      ui.terminal.input?.('\x1b');
      ui.send('/permissions'); down(); down(); down(); down(); enter();
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('项目默认设置'));
      enter(); down(); enter(); // auto -> yolo，仍只是项目草稿
      expect(await readFile(file, 'utf8')).toBe(before);
      expect(ui.agent.permission.mode).toBe('auto');
      for (let i = 0; i < 5; i++) down(); enter();
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('确认 Save'));
      enter(); enter(); // 未重新选择不能保存
      expect(await readFile(file, 'utf8')).toBe(before);
      down(); down(); enter(); enter(); // 显式确认；重复 Enter 不触发新菜单
      expect(JSON.parse(await readFile(file, 'utf8')).permissionMode).toBe('yolo');
      expect(ui.agent.permission.mode).toBe('auto');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('项目默认设置'));
      await snapshot('project-explicit-save', ui.screen());
    } finally { await ui.dispose(); }
  });

  it('审批面板具有完整边框与来源，40×12 和 24×8 保留可选动作，详情控制字符不执行', async () => {
    const ui = await mountTui(); const controller = new AbortController(); const resolve = vi.fn();
    try {
      ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve,
        request: { toolName: 'bash', toolUseId: 'call-unique', decisionSource: 'danger', cwd: '/tmp/project', input: { command: 'echo ok' }, summary: 'echo ok', reason: '危险操作需要确认' } });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('Agent 正在请求权限'));
      expect(ui.screen().join('\n')).toContain('触发: 危险检测');
      for (const [columns, rows] of [[40, 12], [24, 8]]) {
        ui.terminal.columns = columns; ui.terminal.rows = rows; ui.terminal.resize?.();
        await vi.waitFor(() => expect(ui.screen()).toHaveLength(rows));
        const screen = ui.screen();
        expect(screen.some(line => line.startsWith('╭') && line.endsWith('╮'))).toBe(true);
        expect(screen.some(line => line.startsWith('╰') && line.endsWith('╯'))).toBe(true);
        expect(screen.join('\n')).toContain('bash');
        for (const line of screen) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
        ui.terminal.input?.('\x1b[A');
        await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('❯ 拒绝'));
        ui.terminal.input?.('\x1b[B');
      }
      ui.terminal.columns = 80; ui.terminal.rows = 24; ui.terminal.resize?.(); ui.terminal.input?.('\t');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('call-unique'));
      expect(ui.screen().join('\n')).toContain('/tmp/project');
      expect(resolve).not.toHaveBeenCalled();
    } finally { controller.abort(); await ui.dispose(); }
  });

  it('Esc 拒绝和外部取消不吞掉恢复草稿的 Enter', async () => {
    for (const abort of [false, true]) {
      const ui = await mountTui(); const controller = new AbortController();
      const run = vi.spyOn(ui.agent.loop, 'run');
      try {
        ui.terminal.input?.('草稿');
        ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve: vi.fn(),
          request: { toolName: 'bash', input: {}, summary: '操作', reason: '确认' } });
        if (abort) controller.abort(); else ui.terminal.input?.('\x1b');
        ui.terminal.input?.('\r');
        await vi.waitFor(() => expect(run).toHaveBeenCalledWith('草稿'));
      } finally { controller.abort(); await ui.dispose(); }
    }
  });

  it('审批结束后的重复 Enter 不发送草稿，也不应用恢复的设置候选', async () => {
    const ui = await mountTui();
    const run = vi.spyOn(ui.agent.loop, 'run');
    const controller = new AbortController();
    const ask = () => ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve: vi.fn(),
      request: { toolName: 'bash', input: { command: 'echo test' }, summary: 'echo test', reason: '确认' } });
    try {
      ui.terminal.input?.('未发送草稿'); ask();
      ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\r'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('未发送草稿'));
      expect(run).not.toHaveBeenCalled();
      ui.terminal.input?.('\x15');
      ui.send('/think'); ui.terminal.input?.('\x1b[B'); ask();
      ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\r'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('❯ low'));
      expect(ui.agent.loop.thinking).toBe('off');
      ui.terminal.input?.('\x1b');
    } finally { controller.abort(); await ui.dispose(); }
  });

  it('关闭危险操作强制询问时，模式和记忆范围不承诺仍会拦截', async () => {
    const ui = await mountTui({ dangerForceAsk: false });
    const controller = new AbortController();
    try {
      ui.send('/mode'); ui.terminal.input?.('\x1b[B');
      await vi.waitFor(() => expect(ui.screen().join('').replace(/[\s│]/g, '')).toContain('已关闭危险操作强制询问'));
      ui.terminal.input?.('\x1b');
      ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve: vi.fn(),
        request: { toolName: 'custom_plugin', input: {}, summary: '插件调用', reason: '确认' } });
      ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\t');
      await vi.waitFor(() => expect(ui.screen().join('').replace(/[\s│]/g, '')).toContain('custom_plugin的所有调用'));
      expect(ui.screen().join('').replace(/[\s│]/g, '')).toContain('已关闭危险操作强制询问');
    } finally { controller.abort(); await ui.dispose(); }
  });

  it('设置候选不等于当前值，筛选和取消不修改设置，详情解释生效时机', async () => {
    const ui = await mountTui();
    try {
      ui.send('/think');
      ui.terminal.input?.('\x1b[B');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('❯ low'));
      expect(ui.screen().join('\n')).toContain('off · 当前');
      expect(ui.agent.loop.thinking).toBe('off');
      ui.terminal.input?.('\t');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('下一次模型请求生效'));
      ui.terminal.input?.('\x1b');
      expect(ui.agent.loop.thinking).toBe('off');
      ui.send('/model'); ui.terminal.input?.('gpt-4o');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('当前: claude-sonnet-4-5'));
      expect(ui.agent.loop.model).toBe('claude-sonnet-4-5');
      await snapshot('filtered-model-current', ui.screen());
      ui.terminal.input?.('\x1b');
      ui.send('/mode');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('跟随当前模型'));
      expect(ui.screen().join('\n')).not.toContain('未加载审批模型');
      expect(ui.agent.permission.mode).toBe('auto');
      ui.terminal.input?.('\x1b');
    } finally { await ui.dispose(); }
  });

  it('记住审批说明真实匹配范围与会话恢复，未选择和详情返回不能授权', async () => {
    const ui = await mountTui();
    const controller = new AbortController(); const resolve = vi.fn();
    try {
      ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve,
        request: { toolName: 'read_file', input: { path: 'note.txt' }, summary: '读取 note.txt', reason: '请确认' } });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('未选择'));
      ui.terminal.input?.('\r'); ui.terminal.input?.('\r');
      expect(resolve).not.toHaveBeenCalled();
      ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\x1b[B');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('相同匹配目标'));
      expect(ui.screen().join('\n')).toContain('其他参数可能不同');
      expect(ui.screen().join('').replace(/[\s│]/g, '')).toContain('会话保存和恢复');
      await snapshot('permission-remember-scope', ui.screen());
      ui.terminal.input?.('\t'); ui.terminal.input?.('\r');
      ui.terminal.input?.('\r'); ui.terminal.input?.('\r');
      expect(resolve).not.toHaveBeenCalled();
      ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\r');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({ allow: true, remember: 'session' });
    } finally { controller.abort(); await ui.dispose(); }
  });

  it('运行时关闭选择器不打断任务，草稿与排队提示在底部保留', async () => {
    const ui = await mountTui();
    let release!: () => void;
    const abort = vi.spyOn(ui.agent.loop, 'abort_current');
    vi.spyOn(ui.agent.loop, 'run').mockImplementation(() => new Promise((resolve) => { release = () => resolve({ reason: 'completed', turns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }); }));
    try {
      ui.send('第一轮');
      ui.send('下一项任务');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('下一条: 下一项任务'));
      expect(ui.screen().join('\n')).toContain('Enter 排队');
      ui.send('/model');
      ui.terminal.input?.('\x03');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('❯ 输入'));
      expect(abort).not.toHaveBeenCalled();
      ui.send('/queue clear');
      ui.terminal.input?.('未发送草稿');
      const controller = new AbortController();
      const resolve = vi.fn();
      ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve,
        request: { toolName: 'bash', input: {}, summary: '操作上下文', reason: '需要确认' } });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('请求权限'));
      ui.terminal.input?.('\x1b');
      expect(resolve).toHaveBeenCalledWith({ allow: false });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('未发送草稿'));
      release();
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('Enter 发送'));
      ui.terminal.columns = 24; ui.terminal.rows = 8; ui.terminal.resize?.();
      await vi.waitFor(() => expect(ui.screen()).toHaveLength(8));
      expect(ui.screen().join('\n')).toContain('auto · 思考 off');
      for (const line of ui.screen()) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      await snapshot('narrow-idle', ui.screen());
    } finally { release?.(); await ui.dispose(); }
  });

  it('高窗口中的思考菜单独占底部，移除输入框且切换时清屏重绘', async () => {
    const ui = await mountTui();
    try {
      ui.terminal.columns = 140;
      ui.terminal.rows = 70;
      ui.terminal.resize?.();
      await vi.waitFor(() => expect(ui.screen()).toHaveLength(70));
      expect(ui.screen().join('\n')).toContain('❯ 输入');
      ui.terminal.output = '';
      ui.send('/think');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('╭ 思考等级'));
      const shown = ui.screen();
      const start = shown.findIndex((line) => line.includes('╭ 思考等级'));
      expect(start).toBeGreaterThanOrEqual(54);
      expect(shown[start - 1]).not.toContain('思考等级（当前');
      expect(shown.join('\n')).not.toContain('❯ 输入');
      expect(shown.join('\n')).not.toContain('Enter 发送');
      expect(shown.slice(start).join('\n')).toContain('❯ off');
      expect(shown.slice(start).join('\n')).toContain('Enter 确认');
      expect(ui.renderer().hasOverlay()).toBe(false);
      expect(ui.terminal.output).toContain('\x1b[2J');
      await snapshot('think-tall', shown);
      ui.terminal.input?.('\x1b[B');
      ui.terminal.input?.('\x1b[B');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('❯ medium'));
      ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('❯ 输入'));
      expect(ui.screen().join('\n')).not.toContain('╭ 思考等级');
      expect(ui.screen().join('\n')).toContain('思考 medium');
    } finally { await ui.dispose(); }
  });

  it('模型选择固定在底部，可筛选，当前模型已选中且无需浮动弹层', async () => {
    const ui = await mountTui();
    try {
      ui.send('/model');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('选择模型'));
      expect(ui.renderer().hasOverlay()).toBe(false);
      const shown = ui.screen();
      const panelStart = shown.findIndex((line) => line.includes('╭ 选择模型'));
      expect(panelStart).toBeGreaterThanOrEqual(3);
      expect(shown.slice(panelStart).join('\n')).toContain('Enter 确认');
      expect(shown.slice(panelStart).join('\n')).toContain('❯ claude-sonnet-4-5 · 当前');
      await snapshot('model', shown);
      ui.terminal.input?.('gpt-4o');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('搜索: gpt-4o'));
      ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.agent.loop.model).toBe('gpt-4o'));
      await vi.waitFor(() => expect(ui.screen().slice(-8).join('\n')).toContain('Enter 发送'));
    } finally { await ui.dispose(); }
  });

  it('长审批正文不能挤走选项，窄屏能滚动到完整参数末尾，浏览详情不会误批准', async () => {
    const ui = await mountTui();
    const controller = new AbortController();
    const resolve = vi.fn();
    try {
      ui.agent.events.emit({ type: 'permission_request', signal: controller.signal, resolve, request: {
        toolName: 'bash', summary: `发布 ${'很长的命令 '.repeat(200)}`,
        reason: '需要确认远端写入范围', input: { command: `${'command argument\n'.repeat(80)}END_PARAMETER_UNIQUE` },
      } });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('请求权限'));
      expect(ui.renderer().hasOverlay()).toBe(false);
      expect(ui.screen().slice(-16).join('\n')).toContain('允许一次');
      expect(ui.screen().slice(-16).join('\n')).toContain('允许并记住此规则');
      expect(ui.screen().slice(-16).join('\n')).toContain('Enter 确认');
      await snapshot('permission', ui.screen());
      ui.terminal.columns = 32;
      ui.terminal.rows = 10;
      ui.terminal.resize?.();
      await vi.waitFor(() => expect(ui.screen()).toHaveLength(10));
      expect(ui.screen().join('\n')).toContain('允许一次');
      expect(ui.screen().join('\n')).toContain('Enter 确认');
      for (const line of ui.screen()) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
      ui.terminal.input?.('\t');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('返回选项'));
      for (let i = 0; i < 500; i++) ui.terminal.input?.('\x1b[B');
      await vi.waitFor(() => expect(ui.screen().join('').replace(/[\s│]/g, '')).toContain('END_PARAMETER_UNIQUE'));
      await snapshot('narrow-permission-details', ui.screen());
      ui.terminal.input?.('\r');
      expect(resolve).not.toHaveBeenCalled();
      ui.terminal.input?.('\x1b');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({ allow: false });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('Enter 发送'));
    } finally { controller.abort(); await ui.dispose(); }
  });

  it('审批优先于模型选择，连续审批与中断后恢复原筛选，后台工具结果不掩盖等待确认状态', async () => {
    const ui = await mountTui();
    const first = new AbortController();
    const second = new AbortController();
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    try {
      ui.send('/model');
      ui.terminal.input?.('gpt');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('搜索: gpt'));
      ui.agent.events.emit({ type: 'permission_request', request: { toolName: 'first', input: {}, summary: '第一项', reason: '确认' }, signal: first.signal, resolve: firstResolve });
      ui.agent.events.emit({ type: 'permission_request', request: { toolName: 'second', input: {}, summary: '第二项', reason: '确认' }, signal: second.signal, resolve: secondResolve });
      ui.agent.events.emit({ type: 'tool_result', toolUseId: 'background', name: 'read_file', result: { content: '后台读取完成' } });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('first · 第一项'));
      expect(ui.screen().join('\n')).toContain('等待你确认权限');
      ui.terminal.input?.('\r');
      expect(firstResolve).not.toHaveBeenCalled();
      ui.terminal.input?.('\x1b[B');
      ui.terminal.input?.('\r');
      expect(firstResolve).toHaveBeenCalledTimes(1);
      expect(firstResolve).toHaveBeenCalledWith({ allow: true });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('second · 第二项'));
      ui.terminal.input?.('\r'); ui.terminal.input?.('\r');
      expect(secondResolve).not.toHaveBeenCalled();
      second.abort();
      expect(secondResolve).toHaveBeenCalledTimes(1);
      expect(secondResolve).toHaveBeenCalledWith({ allow: false });
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('搜索: gpt'));
      ui.terminal.input?.('\x1b');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('Enter 发送'));
      expect(ui.agent.permission.getSessionRules().allow).toEqual([]);
    } finally { first.abort(); second.abort(); await ui.dispose(); }
  });

  it('对话身份、思考和工具状态清楚，Ctrl+O 展开与编号详情可看到完整内容', async () => {
    const ui = await mountTui();
    try {
      vi.spyOn(ui.agent.loop, 'run').mockImplementation(async () => {
        ui.agent.events.emit({ type: 'thinking_delta', text: '先检查项目，再执行测试。' });
        ui.agent.events.emit({ type: 'text_delta', text: '我会检查项目。' });
        ui.agent.events.emit({ type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '先检查项目，再执行测试。' }, { type: 'text', text: '我会检查项目。' }] } });
        ui.agent.events.emit({ type: 'tool_call', toolUse: { type: 'tool_use', id: 'test', name: 'bash', input: { command: 'pnpm test', description: '完整参数说明 '.repeat(20) } } });
        ui.agent.events.emit({ type: 'tool_result', toolUseId: 'test', name: 'bash', result: { content: '输出一\n输出二\n输出三\n输出四\n输出五\nOUTPUT_END_UNIQUE' } });
        return { reason: 'completed', turns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      });
      ui.send('帮我运行测试');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('工具 #2'));
      const collapsed = ui.screen().join('\n');
      expect(collapsed).toContain('❯ 你');
      expect(collapsed).toContain('◇ 思考 #1 · 已结束');
      expect(collapsed).toContain('● Agent');
      expect(collapsed).toContain('完成 · bash');
      expect(collapsed).toContain('#2 · 6 行输出');
      expect(collapsed).not.toContain('OUTPUT_END_UNIQUE');
      await snapshot('conversation', ui.screen());
      ui.terminal.input?.('\x0f');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('OUTPUT_END_UNIQUE'));
      ui.terminal.input?.('\x0f');
      await vi.waitFor(() => expect(ui.screen().join('\n')).not.toContain('OUTPUT_END_UNIQUE'));
      ui.send('/details 2');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('╭ #2 工具 · bash'));
      expect(ui.screen().join('\n')).toContain('完整参数');
      for (let i = 0; i < 100; i++) ui.terminal.input?.('\x1b[B');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('OUTPUT_END_UNIQUE'));
      await snapshot('tool-details', ui.screen());
      ui.terminal.input?.('\x1b');
      await vi.waitFor(() => expect(ui.screen().join('\n')).toContain('Enter 发送'));
    } finally { await ui.dispose(); }
  });

  it('显示固定底栏，审批 Ctrl+C 后可继续输入，缩窄窗口仍可渲染', async () => {
    vi.stubEnv('AGENTLAB_SCREEN', 'alt');
    let renderer: TuiAltScreen | undefined;
    const originalStart = TuiAltScreen.prototype.start;
    vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function (this: TuiAltScreen) {
      renderer = this;
      originalStart.call(this);
    });
    const dir = await mkdtemp(join(tmpdir(), 'agentlab-cli-'));
    let session: ReturnType<typeof startTui>;
    try {
      await writeFile(join(dir, 'agent.config.json'), JSON.stringify({ provider: 'fake', permissionMode: 'ask' }));
      await writeFile(join(dir, 'demo.txt'), '演示内容');
      const agent = await createAgent(dir);
      const terminal = new MemoryTerminal();
      const exit = vi.fn();
      session = startTui(agent, { terminal, onExit: exit });
      await vi.waitFor(() => expect(terminal.output).toContain('AgentLab'));
      const screen = () => renderer!.getScreenLines().map(stripTerminalSequences);
      expect(screen()).toHaveLength(24);
      expect(screen().slice(-8).join('\n')).toContain('Enter 发送');
      terminal.input?.('读取 demo.txt');
      terminal.input?.('\r');
      await vi.waitFor(() => expect(stripTerminalSequences(terminal.output)).toContain('请求权限'));
      terminal.input?.('\x03');
      await vi.waitFor(() => expect(stripTerminalSequences(terminal.output)).toContain('本轮已中断'));
      expect(exit).not.toHaveBeenCalled();
      terminal.columns = 32;
      terminal.resize?.();
      terminal.input?.('你好');
      terminal.input?.('\r');
      await vi.waitFor(() => expect(agent.loop.getMessages().some((m) => m.role === 'user' && m.content === '你好')).toBe(true));
      await vi.waitFor(() => expect(screen().slice(-8).join('\n')).toContain('就绪'));
      for (const line of screen()) expect(visibleWidth(line)).toBeLessThanOrEqual(32);
      // 历史超出一屏后，向上查看不会因后台追加消息强行跳到底部。
      agent.events.emit({ type: 'notice', text: Array.from({ length: 50 }, (_, i) => `历史消息 ${i}`).join('\n') });
      await vi.waitFor(() => expect(screen().join('\n')).toContain('历史消息 49'));
      renderer!.scrollBy(-10);
      await vi.waitFor(() => expect(renderer!.isFollowingOutput).toBe(false));
      agent.events.emit({ type: 'notice', text: '后台新消息' });
      await vi.waitFor(() => expect(screen().join('\n')).toContain('历史消息 30'));
      expect(renderer!.isFollowingOutput).toBe(false);
      expect(screen().slice(-8).join('\n')).toContain('Enter 发送');
    } finally {
      session?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('帮助里能看到 /save 和 /sessions', async () => {
    vi.stubEnv('AGENTLAB_SCREEN', 'alt');
    const dir = await mkdtemp(join(tmpdir(), 'agentlab-cli-'));
    let session: ReturnType<typeof startTui>;
    try {
      await writeFile(join(dir, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
      const agent = await createAgent(dir);
      const terminal = new MemoryTerminal();
      session = startTui(agent, { terminal, onExit: vi.fn() });
      terminal.input?.('/help');
      terminal.input?.('\r');
      await vi.waitFor(() => expect(stripTerminalSequences(terminal.output)).toContain('/save'));
      expect(stripTerminalSequences(terminal.output)).toContain('/sessions');
    } finally {
      session?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('startTui resume 重绘历史、底栏模型和标题，下一轮请求带上旧历史', async () => {
    vi.stubEnv('AGENTLAB_SCREEN', 'alt');
    let renderer: TuiAltScreen | undefined;
    const originalStart = TuiAltScreen.prototype.start;
    vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function (this: TuiAltScreen) {
      renderer = this;
      originalStart.call(this);
    });
    const dir = await mkdtemp(join(tmpdir(), 'agentlab-cli-'));
    let session: ReturnType<typeof startTui>;
    try {
      await writeFile(join(dir, 'agent.config.json'), JSON.stringify({ provider: 'fake', permissionMode: 'ask' }));
      const messages = [
        { role: 'user', source: 'summary', content: `${SUMMARY_MARKER}\n这里是很早的讨论，不应该整段铺开。` },
        { role: 'user', content: '请读取笔记' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我去读一下。' },
            { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'note.txt' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tool-1', content: '笔记正文-UNIQUE' }] },
        { role: 'assistant', content: [{ type: 'text', text: '笔记已经看到了。' }] },
      ] as Message[];
      await saveSession({
        schemaVersion: 1,
        id: 'resumecli01',
        title: '笔记',
        createdAt: '2026-10-05T01:02:03.000Z',
        updatedAt: '2026-10-05T01:02:03.000Z',
        cwd: dir,
        model: 'gpt-4o',
        provider: 'fake',
        endpointKey: 'default',
        thinking: 'high',
        permissionMode: 'ask',
        sessionRules: { allow: [], ask: [], deny: [] },
        usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stats: { messages: messages.length, estimatedTokens: 20, runs: 2 },
        messages,
      });
      const agent = await createAgent(dir);
      const provider = agent.providers.get('fake');
      expect(provider).toBeInstanceOf(FakeProvider);
      const terminal = new MemoryTerminal();
      session = startTui(agent, { terminal, onExit: vi.fn(), resume: 'resumecli01' });
      const screen = () => renderer!.getScreenLines().map(stripTerminalSequences);
      await vi.waitFor(() => expect(screen().join('\n')).toContain('请读取笔记'));
      const shown = screen().join('\n');
      expect(shown).toContain('AgentLab');
      expect(shown).toContain('早期对话摘要');
      expect(shown).toContain('笔记正文-UNIQUE');
      expect(shown).not.toContain('不应该整段铺开');
      expect(screen().slice(-8).join('\n')).toContain('gpt-4o');
      terminal.input?.('接着说');
      terminal.input?.('\r');
      await vi.waitFor(() => expect((provider as FakeProvider).requests.length).toBeGreaterThan(0));
      const request = (provider as FakeProvider).requests.at(-1)!;
      expect(request.messages.some((message) => message.role === 'user' && message.content === '请读取笔记')).toBe(true);
      expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: '接着说' });
      expect(request.tools.length).toBeGreaterThan(0);
    } finally {
      session?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('renderHistory', () => {
  it('窄屏下每一行都不超出可见宽度', () => {
    const long = '很长的一行内容'.repeat(30);
    const messages = [
      { role: 'user', source: 'summary', content: `${SUMMARY_MARKER}\n${long}` },
      { role: 'user', content: long },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: long },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'text', text: long },
          { type: 'tool_use', id: 't', name: 'read_file', input: { path: long } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: long }] },
    ] as Message[];
    const components = renderHistory(messages, {
      theme,
      expanded: () => false,
      summarize: (name, input) => `${name} ${JSON.stringify(input)}`,
    });
    for (const comp of components) {
      for (const line of comp.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
    const expanded = renderHistory(messages, {
      theme,
      expanded: () => true,
      summarize: (name) => name,
    });
    for (const comp of expanded) {
      for (const line of comp.render(20)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });
});
