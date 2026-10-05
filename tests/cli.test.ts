import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TuiAltScreen, stripTerminalSequences, visibleWidth, type Component, type MarkdownTheme, type Terminal } from '@earendil-works/pi-tui';
import { startTui } from '../src/cli/app.js';
import { StreamMessages, ToolMessage } from '../src/cli/messages.js';
import { TurnQueue } from '../src/cli/turn-queue.js';
import { createAgent } from '../src/index.js';

const identity = (s: string) => s;
const theme: MarkdownTheme = {
  heading: identity, link: identity, linkUrl: identity, code: identity,
  codeBlock: identity, codeBlockBorder: identity, quote: identity, quoteBorder: identity,
  hr: identity, listBullet: identity, bold: identity, italic: identity, strikethrough: identity, underline: identity,
};
const text = (comp: Component, width = 80) => comp.render(width).map(stripTerminalSequences).join('\n');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('TUI 消息与调度', () => {
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

describe('真实 TUI 离线交互', () => {
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
      await vi.waitFor(() => expect(stripTerminalSequences(terminal.output)).toContain('权限请求'));
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
});
