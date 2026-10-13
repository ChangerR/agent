/** 普通输入经过真实 TUI、规划插件和工具执行；只替换模型及终端 I/O。 */
import { afterEach, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TuiAltScreen,
  stripTerminalSequences,
  visibleWidth,
  type Terminal,
} from '@earendil-works/pi-tui';
import { createAgent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
import { startTui } from '../src/cli/app.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import type { ChatRequest } from '../src/core/provider.js';
import { PlanController } from '../src/core/plan.js';
import { EventBus } from '../src/core/events.js';
import { emptyUsage } from '../src/core/protocol/types.js';
import { planLines } from '../src/builtin/planning/tui.js';
import { mkdtempProject } from './helpers/project.js';
import { requestPlan as planFrom } from './helpers/runtime-plan.js';

class MemoryTerminal implements Terminal {
  kittyProtocolActive = false;
  input?: (data: string) => void;
  constructor(
    public columns: number,
    public rows: number,
  ) {}
  start(input: (data: string) => void): void {
    this.input = input;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { columns: 120, rows: 40 },
  { columns: 40, rows: 14 },
])('普通项目检查自动显示计划和当前步骤，切换进度无需命令：%j', async (size) => {
  const task = '帮我看下当前的项目，看看还有什么优化点';
  const cwd = await mkdtempProject(join(tmpdir(), 'agent-plan-ui-'));
  const first = gate();
  const second = gate();
  let requestNumber = 0;
  let planningRequests = 0;
  const call = (name: string, input: unknown) =>
    toolUseResponse([{ id: `ui-${requestNumber}`, name, input }]);
  const update = (request: ChatRequest, index: number, status: string) => {
    const plan = planFrom(request);
    return call('plan_update', {
      revision: plan.revision,
      stepId: plan.steps[index].id,
      status,
      evidence: 'read_file 已核对项目文件',
    });
  };
  const execution = new FakeProvider([
    () => call('read_file', { path: 'README.md' }),
    (request) => update(request, 0, 'completed'),
    (request) => update(request, 1, 'running'),
    () => call('read_file', { path: 'service.ts' }),
    (request) => update(request, 1, 'completed'),
    textResponse('发现可以合并重复遍历，未修改代码。'),
  ]);
  const provider = definePlugin({
    manifest: { id: 'test.plan-ui', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.provider('plan-ui', {
        name: 'plan-ui',
        capabilities: execution.capabilities,
        async *stream(request, signal) {
          if (request.system.startsWith('[agentlab planning:auto]')) {
            planningRequests++;
            expect(request.messages.at(-1)?.content).toBe(task);
            yield* textResponse(
              JSON.stringify({ goal: '检查优化点', steps: ['了解项目结构', '分析优化建议'] }),
            );
            return;
          }
          requestNumber++;
          if (requestNumber === 1 || requestNumber === 4) {
            const wait = requestNumber === 1 ? first : second;
            await Promise.race([
              wait.promise,
              new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
              ),
            ]);
            signal.throwIfAborted();
          }
          yield* execution.stream(request, signal);
        },
      });
    },
  });
  vi.stubEnv('AGENTLAB_SCREEN', 'alt');
  let renderer!: TuiAltScreen;
  const original = TuiAltScreen.prototype.start;
  vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function (this: TuiAltScreen) {
    renderer = this;
    original.call(this);
  });
  const agent = await createAgent(cwd, {
    plugins: [provider],
    autoSaveSessions: false,
    config: { provider: 'plan-ui', permissionMode: 'auto', capabilities: { reviewer: false } },
  });
  await writeFile(join(cwd, 'README.md'), '项目结构说明');
  await writeFile(join(cwd, 'service.ts'), 'items.map(f); items.map(g);');
  const terminal = new MemoryTerminal(size.columns, size.rows);
  const session = startTui(agent, { terminal, onExit: vi.fn() });
  const screen = () => renderer.getScreenLines().map(stripTerminalSequences).join('\n');
  try {
    terminal.input?.(task);
    terminal.input?.('\r');
    await vi.waitFor(() => expect(screen()).toContain('进行中 · 了解项目结构'));
    expect(screen()).toContain('计划 0/2');
    expect(screen()).not.toContain('[进行中]');
    terminal.input?.('保留草稿');
    terminal.input?.('\x14');
    await vi.waitFor(() => expect(screen()).toContain('[进行中]'));
    expect(screen()).toContain('保留草稿');
    if (size.rows === 40) {
      expect(screen()).toContain('[进行中] 了解项目结构');
      expect(screen()).toContain('[待办] 分析优化建议');
    }
    expect(planningRequests).toBe(1);
    // 执行模型尚未调用任何工具，计划及首步已由宿主发布并渲染。
    expect(execution.requests).toHaveLength(0);
    first.resolve();
    await vi.waitFor(() => expect(screen()).toContain('进行中 · 分析优化建议'));
    if (size.rows === 40) expect(screen()).toContain('[完成] 了解项目结构');
    second.resolve();
    await vi.waitFor(() => expect(agent.loop.plan.snapshot?.phase).toBe('completed'));
    await agent.loop.whenSettled();
    await vi.waitFor(() => expect(screen()).toContain('2/2'));
    expect(execution.requests).toHaveLength(6);
  } finally {
    first.resolve();
    second.resolve();
    session?.stop();
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

it('摘要准确定位完成、阻塞和中断步骤，完整 Unicode 标题及证据可逐行浏览', () => {
  const controller = new PlanController(new EventBus());
  controller.create('目标', ['短步骤', '中文🧑‍💻e\u0301'.repeat(120) + '标题结尾'], 'auto');
  const plan = controller.snapshot!;
  plan.steps[0].status = 'completed';
  plan.steps[0].evidence = '已核实第一步';
  for (const state of ['blocked', 'interrupted', 'cancelled', 'completed'] as const) {
    plan.phase = state;
    plan.steps[1].status = state;
    plan.steps[1].reason =
      state === 'completed' ? undefined : '等待外部条件'.repeat(100) + '原因结尾';
    plan.steps[1].evidence =
      state === 'completed' ? '核验内容'.repeat(100) + '依据结尾' : undefined;
    for (const width of [24, 40, 120]) {
      const collapsed = planLines(plan, false, 8, 0, width);
      expect(collapsed).toHaveLength(1);
      expect(collapsed[0]).toContain(
        state === 'completed'
          ? '完成'
          : state === 'blocked'
            ? '阻塞'
            : state === 'interrupted'
              ? '中断'
              : '取消',
      );
      expect(collapsed[0]).not.toContain('短步骤');
      const seen = new Set<string>();
      for (let offset = 0; offset < 600; offset++) {
        const lines = planLines(plan, true, 3, offset, width);
        expect(lines).toHaveLength(3);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        seen.add(lines[1]);
      }
      const body = [...seen].join('');
      expect(body).toContain('标题结尾');
      expect(body).toContain(state === 'completed' ? '依据结尾' : '原因结尾');
    }
  }
  plan.phase = 'blocked';
  plan.steps[1].status = 'blocked';
  plan.steps[1].reason = 'User denied';
  const denied = stripTerminalSequences(planLines(plan, false, 3, 0, 40)[0]);
  expect(denied).toContain('#2');
  expect(denied).toContain('User');
  expect(denied).toContain('^T');
});

it.each([
  { columns: 120, rows: 40 },
  { columns: 40, rows: 14 },
])('计划浏览保留 root/child 审批、父草稿，新计划及恢复重置折叠：%j', async (size) => {
  const cwd = await mkdtempProject(join(tmpdir(), 'agent-plan-focus-'));
  vi.stubEnv('AGENTLAB_SCREEN', 'alt');
  let renderer!: TuiAltScreen;
  const original = TuiAltScreen.prototype.start;
  vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function (this: TuiAltScreen) {
    renderer = this;
    original.call(this);
  });
  const agent = await createAgent(cwd, {
    autoSaveSessions: false,
    config: { provider: 'fake', capabilities: { reviewer: false } },
  });
  const terminal = new MemoryTerminal(size.columns, size.rows);
  const session = startTui(agent, { terminal, onExit: vi.fn() });
  const screen = () => renderer.getScreenLines().map(stripTerminalSequences).join('\n');
  const run = vi
    .spyOn(agent.loop, 'run')
    .mockResolvedValue({ reason: 'completed', turns: 0, usage: emptyUsage() });
  try {
    agent.loop.plan.create(
      '目标',
      Array.from({ length: 20 }, (_, i) => `核验步骤${i}`),
      'auto',
    );
    terminal.input?.('父草稿');
    await vi.waitFor(() => expect(screen()).toContain('计划 0/20'));
    terminal.input?.('\x14');
    await vi.waitFor(() => expect(screen()).toContain('[待办] 核验步骤0'));
    terminal.input?.('\x1b[1;3B');
    await vi.waitFor(() => expect(screen()).toContain('[待办] 核验步骤1'));
    terminal.input?.('\x1b[1;3A');
    await vi.waitFor(() => expect(screen()).toContain('[待办] 核验步骤0'));
    expect(screen()).toContain('父草稿');
    for (const child of [false, true]) {
      const controller = new AbortController();
      const resolve = vi.fn();
      agent.events.emit({
        type: 'permission_request',
        signal: controller.signal,
        resolve,
        request: {
          toolName: 'write_file',
          input: { path: 'test.txt', content: 'ok' },
          summary: '写入',
          reason: '确认',
          ...(child
            ? { agentId: 'child-focus', agentName: '子任务', runId: 'run-focus', task: '核验' }
            : {}),
        },
      });
      await vi.waitFor(() => expect(screen()).toContain('允许一次'));
      terminal.input?.('\x14');
      terminal.input?.('\x14');
      terminal.input?.('\x1b[1;3B');
      terminal.input?.('\r');
      expect(resolve).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      if (child) {
        terminal.input?.('\x07');
        await vi.waitFor(() => expect(screen()).toContain('父草稿'));
        terminal.input?.('\x14');
        terminal.input?.('\r');
        await vi.waitFor(() => expect(run).toHaveBeenCalledWith('父草稿'));
        expect(resolve).not.toHaveBeenCalled();
        terminal.input?.('\x07');
      }
      terminal.input?.('\x1b[B');
      terminal.input?.('\r');
      expect(resolve).toHaveBeenCalledWith({ allow: true });
    }
    agent.loop.plan.create('新目标', ['新步骤'], 'auto');
    await vi.waitFor(() => expect(screen()).toContain('新步骤'));
    expect(screen()).not.toContain('[待办]');
    terminal.input?.('\x14');
    await vi.waitFor(() => expect(screen()).toContain('[待办] 新步骤'));
    agent.loop.plan.restore(agent.loop.plan.snapshot);
    agent.events.emit({
      type: 'session_restored',
      id: 'restored',
      title: '恢复',
      model: agent.loop.model,
      thinking: agent.loop.thinking,
      usage: emptyUsage(),
      messages: [],
    });
    await vi.waitFor(() => expect(screen()).toContain('中断'));
    expect(screen()).not.toContain('[待办]');
    agent.loop.plan.clear();
    await vi.waitFor(() => expect(screen()).not.toContain('计划 0/1'));
    for (const line of renderer.getScreenLines())
      expect(visibleWidth(line)).toBeLessThanOrEqual(size.columns);
  } finally {
    session?.stop();
    await agent.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
