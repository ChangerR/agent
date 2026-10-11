/** 普通输入经过真实 TUI、规划插件和工具执行；只替换模型及终端 I/O。 */
import { afterEach, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { createAgent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
import { startTui } from '../src/cli/app.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import type { ChatRequest } from '../src/core/provider.js';
import type { Plan } from '../src/core/plan.js';
import { mkdtempProject } from './helpers/project.js';

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
const planFrom = (request: ChatRequest): Plan =>
  JSON.parse(request.system.split('当前所属计划（版本变化后须重新读取）: ')[1].split('\n')[0]);
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
    await vi.waitFor(() => expect(screen()).toContain('当前: 了解项目结构'));
    expect(screen()).toContain('计划: 检查优化点');
    expect(screen()).toContain('下一步: 分析优化建议');
    if (size.rows === 40) {
      expect(screen()).toContain('[进行中] 了解项目结构');
      expect(screen()).toContain('[待办] 分析优化建议');
    }
    expect(planningRequests).toBe(1);
    // 执行模型尚未调用任何工具，计划及首步已由宿主发布并渲染。
    expect(execution.requests).toHaveLength(0);
    first.resolve();
    await vi.waitFor(() => expect(screen()).toContain('当前: 分析优化建议'));
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
