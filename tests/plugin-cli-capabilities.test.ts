import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { createAgent } from '../src/index.js';
import { startTui } from '../src/cli/app.js';
import { PluginToolMessage } from '../src/cli/plugin-renderers.js';
import { definePlugin, type Plugin } from '../src/sdk/index.js';
import { mkdtempProject } from './helpers/project.js';
import { Composer } from '../src/cli/composer.js';

class MemoryTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; output = '';
  input?: (data: string) => void; resize?: () => void;
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
  stop(): void {} async drainInput(): Promise<void> {} write(data: string): void { this.output += data; }
  moveBy(): void {} hideCursor(): void {} showCursor(): void {} clearLine(): void {} clearFromCursor(): void {} clearScreen(): void {} setTitle(): void {} setProgress(): void {}
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function mount(plugins: Plugin[], cwd?: string) {
  const dir = cwd ?? await mkdtempProject(join(tmpdir(), 'agent-plugin-ui-'));
  const agent = await createAgent(dir, { config: { provider: 'fake' }, plugins, autoSaveSessions: false });
  const terminal = new MemoryTerminal(); let renderer!: TuiAltScreen;
  const start = TuiAltScreen.prototype.start;
  vi.stubEnv('AGENTLAB_SCREEN', 'alt');
  vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function(this: TuiAltScreen) { renderer = this; start.call(this); });
  const session = startTui(agent, { terminal, onExit() {} });
  return { agent, terminal, screen: () => renderer.getScreenLines().map(stripTerminalSequences).join('\n'),
    send: (line: string) => { terminal.input?.(line); terminal.input?.('\r'); },
    async dispose() { session?.stop(); await agent.dispose(); await rm(dir, { recursive: true, force: true }); },
  };
}

describe('generic plugin CLI capabilities', () => {
  it('默认项目、可选全局；显示真实路径，取消不写，一次提交携带原scope且无需额外确认', async () => {
    const cwd = await mkdtempProject(join(tmpdir(), 'scope-ui-'));
    const globalPath = join(cwd, 'global.json'); const projectPath = join(cwd, 'agent.config.json');
    const originalGlobal = '{"origin":"global"}'; const originalProject = '{"origin":"project"}';
    await writeFile(globalPath, originalGlobal); await writeFile(projectPath, originalProject);
    const read = vi.fn((_signal: AbortSignal, scope?: string) => ({ origin: scope }));
    const draft = vi.fn((value: unknown) => value);
    const commit = vi.fn(async (value: unknown, _signal: AbortSignal, scope?: string) => { await writeFile(scope === 'global' ? globalPath : projectPath, JSON.stringify({ value, saved: true })); });
    const ui = await mount([definePlugin({ manifest: { id: 'test.scoped-ui', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.settings('scoped', { title: '范围设置', order: -1, schema: {}, applyMode: 'newSession',
        scopeTargets: [{ scope: 'project', path: projectPath }, { scope: 'global', path: globalPath }], read, draft, commit });
    } })], cwd);
    const down = () => ui.terminal.input?.('\x1b[B'); const enter = () => ui.terminal.input?.('\r');
    try {
      ui.send('/settings'); enter();
      await vi.waitFor(() => expect(ui.screen()).toContain('范围设置 · 本项目'));
      expect(ui.screen()).not.toContain('选择作用域');
      expect(read).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'project');
      expect(ui.screen()).toContain(projectPath);
      down(); down(); enter();
      await vi.waitFor(() => expect(ui.screen()).toContain('范围设置 · 全局'));
      expect(ui.screen()).toContain(globalPath); expect(read).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'global');
      enter();
      await vi.waitFor(() => expect(ui.screen()).toContain('输入完整 JSON'));
      ui.terminal.input?.('未提交'); ui.terminal.input?.('\x1b');
      await vi.waitFor(() => expect(ui.screen()).toContain('编辑 JSON'));
      expect(commit).not.toHaveBeenCalled();
      expect(await readFile(globalPath, 'utf8')).toBe(originalGlobal); expect(await readFile(projectPath, 'utf8')).toBe(originalProject);
      enter(); await vi.waitFor(() => expect(ui.screen()).toContain('输入完整 JSON'));
      enter(); enter();
      await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
      expect(commit).toHaveBeenLastCalledWith({ origin: 'global' }, expect.any(AbortSignal), 'global');
      expect(JSON.parse(await readFile(globalPath, 'utf8'))).toEqual({ value: { origin: 'global' }, saved: true });
      expect(await readFile(projectPath, 'utf8')).toBe(originalProject);
      expect(ui.screen()).not.toContain('确认 Save');
    } finally { await ui.dispose(); }
  });

  it('多作用域只读设置默认本项目，仍可直接查看全局；单作用域继续直接展示详情', async () => {
    const read = vi.fn((_signal: AbortSignal, scope?: string) => ({ origin: scope }));
    const ui = await mount([definePlugin({ manifest: { id: 'test.readonly-scopes', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.settings('readonly-scopes', { title: '只读范围', order: -1, schema: {}, applyMode: 'newSession',
        scopeTargets: [{ scope: 'project', path: '/project/config.json' }, { scope: 'global', path: '/global/config.json' }], read });
      ctx.provide.settings('readonly-single', { title: '单范围只读', order: -0.5, schema: {}, applyMode: 'newSession',
        scopeTargets: [{ scope: 'project', path: '/project/config.json' }], read: () => ({ single: true }) });
    } })]);
    try {
      ui.send('/settings'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('切换到全局'));
      expect(ui.screen()).toContain('只读范围 · 本项目 · 只读');
      expect(ui.screen()).not.toContain('选择作用域'); expect(ui.screen()).not.toContain('编辑 JSON');
      expect(read).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'project');
      ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('"origin": "project"'));
      ui.terminal.input?.('\x1b');
      await vi.waitFor(() => expect(ui.screen()).toContain('切换到全局'));
      ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('只读范围 · 全局 · 只读'));
      expect(read).toHaveBeenLastCalledWith(expect.any(AbortSignal), 'global');
      ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('"origin": "global"'));
      ui.terminal.input?.('\x1b'); await vi.waitFor(() => expect(ui.screen()).toContain('切换到本项目'));
      ui.terminal.input?.('\x1b'); ui.terminal.input?.('\x1b[B'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('单范围只读 · 本项目 · 只读'));
      expect(ui.screen()).toContain('"single": true'); expect(ui.screen()).not.toContain('查看当前值');
    } finally { await ui.dispose(); }
  });

  it('旧插件未声明scope保持undefined参数且不虚称只写会话', async () => {
    const read = vi.fn(() => ({ count: 1 }));
    const ui = await mount([definePlugin({ manifest: { id: 'test.old-settings', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.settings('old', { title: '旧设置', order: -1, schema: {}, applyMode: 'newSession', read, draft: value => value, commit() {} });
    } })]);
    try {
      ui.send('/settings'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('插件未声明保存目标'));
      expect(ui.screen()).not.toContain('不写配置文件');
      expect(read).toHaveBeenLastCalledWith(expect.any(AbortSignal), undefined);
    } finally { await ui.dispose(); }
  });

  it('返回后迟到的设置读取不会重新打开旧面板', async () => {
    let finish!: (value: unknown) => void;
    const ui = await mount([definePlugin({ manifest: { id: 'test.slow-settings', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.settings('slow', { title: '慢设置', order: -1, schema: {}, applyMode: 'newSession', read: () => new Promise(resolve => { finish = resolve; }) });
    } })]);
    try {
      ui.send('/settings'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('正在读取设置'));
      ui.terminal.input?.('\x1b'); finish({ stale: true });
      await vi.waitFor(() => expect(ui.screen()).toContain('设置 · 本次会话 / 本项目 / 全局'));
      expect(ui.screen()).not.toContain('"stale"');
    } finally { await ui.dispose(); }
  });

  it('文件补全以规范化项目根目录为基准而不是启动进程的工作目录', async () => {
    const cwd = await mkdtempProject(join(tmpdir(), 'completion-root-')); const child = join(cwd, 'child');
    await mkdir(child); await writeFile(join(cwd, 'root-only.txt'), 'offline');
    const autocomplete = vi.spyOn(Composer.prototype, 'setAutocompleteProvider');
    const ui = await mount([], child);
    try {
      expect(ui.agent.cwd).toBe(cwd);
      await vi.waitFor(() => expect(ui.screen()).toContain('工具执行/权限基准'));
      expect(ui.screen()).toContain(child); expect(ui.screen()).toContain('项目根目录');
      const provider = autocomplete.mock.calls.at(-1)![0]; const line = './root-only';
      const suggestions = await provider.getSuggestions([line], 0, line.length, { force: true, signal: new AbortController().signal });
      expect(suggestions?.items.some(item => item.value.includes('root-only.txt'))).toBe(true);
    } finally { await ui.dispose(); await rm(cwd, { recursive: true, force: true }); }
  });

  it('discovers plugin commands and settings with no CLI switch edit or custom renderer', async () => {
    const ui = await mount([definePlugin({ manifest: { id: 'test.generic-ui', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.command('hello_plugin', { description: '来自插件的问候', handler: () => ({ type: 'text', text: 'generic command delivered' }) });
      ctx.provide.settings('custom', { title: '插件设置', order: -1, schema: { type: 'object' }, applyMode: 'newSession', read: () => ({ enabled: true }) });
    } })]);
    try {
      ui.send('/hello_plugin'); await vi.waitFor(() => expect(ui.screen()).toContain('generic command delivered'));
      ui.send('/help'); await vi.waitFor(() => expect(stripTerminalSequences(ui.terminal.output)).toContain('/hello_plugin'));
      ui.send('/settings'); ui.terminal.input?.('\r');
      await vi.waitFor(() => expect(ui.screen()).toContain('插件设置'));
      expect(ui.screen()).toContain('test.generic-ui'); expect(ui.screen()).toContain('重启后生效'); expect(ui.screen()).toContain('"enabled": true');
    } finally { await ui.dispose(); }
  });
  it('loads an optional external TUI entry for commands, settings, status and tool rendering', async () => {
    const cwd = await mkdtempProject(join(tmpdir(), 'agent-plugin-entry-')); const entry = join(cwd, 'entry.mjs');
    await writeFile(entry, `export function createTuiAdapter(ctx) { if ('agent' in ctx || 'permission' in ctx) throw new Error('unbounded context'); if (!ctx.inspect().commands.some(c => c.id === 'custom_frontend') || typeof ctx.invokeTool !== 'function') throw new Error('missing bounded runtime'); return {
      commands: { custom_frontend() { ctx.say('external command UI'); } },
      settings: { custom_frontend(back) { ctx.showDetails('external settings UI', () => 'renderer-provided editor', back); } },
      statusItems: { custom: () => 'plugin status ready' },
      toolRenderers: { custom_tool: (operation) => ['PLUGIN TOOL ' + (operation.result?.content ?? 'running')] },
    }; }`);
    const ui = await mount([definePlugin({ manifest: { id: 'test.external-ui', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.command('custom_frontend', { description: '外部界面', handler: () => ({ type: 'text', text: 'headless command implementation' }) });
      ctx.provide.settings('custom_frontend', { title: '外部插件设置', order: -1, schema: {}, applyMode: 'newSession' });
      ctx.provide.tui('external-ui', { entry, kind: 'editor' });
    } })], cwd);
    try {
      expect(await ui.agent.dispatchCommand('/custom_frontend')).toEqual({ type: 'text', text: 'headless command implementation' });
      await vi.waitFor(() => expect(ui.screen()).toContain('plugin status ready'));
      ui.send('/custom_frontend'); await vi.waitFor(() => expect(ui.screen()).toContain('external command UI'));
      ui.send('/settings'); ui.terminal.input?.('\r'); await vi.waitFor(() => expect(ui.screen()).toContain('external settings UI'));
      ui.terminal.input?.('\x1b'); ui.terminal.input?.('\x1b');
      ui.agent.events.emit({ type: 'tool_call', toolUse: { type: 'tool_use', id: 'custom-1', name: 'custom_tool', input: {} } });
      ui.agent.events.emit({ type: 'tool_result', toolUseId: 'custom-1', name: 'custom_tool', result: { content: 'done' } });
      await vi.waitFor(() => expect(ui.screen()).toContain('PLUGIN TOOL done'));
    } finally { await ui.dispose(); }
  });
  it('renderer failure falls back without mutating tool output or retrying the tool', () => {
    const report = vi.fn(); const renderer = vi.fn(() => { throw new Error('display failed'); });
    const message = new PluginToolMessage('safe summary', () => false, { name: 'custom', input: { value: 1 } }, () => renderer, report);
    const result = { content: 'successful output' }; message.finish(result);
    expect(message.render(80).map(stripTerminalSequences).join('\n')).toContain('successful output');
    message.render(80);
    expect(renderer).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce(); expect(result).toEqual({ content: 'successful output' });
  });
});

it('真实模式选择器显示约束，选择 yolo 一次保存并应用，无二次确认', async () => {
  const cwd = await mkdtempProject(join(tmpdir(), 'agent-mode-ui-')); await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ provider: 'fake', permissionMode: 'auto', capabilities: { policy: 'deterministic' }, pluginConfig: { 'agentlab.policy': { writeRoots: ['src'] } } }));
  const ui = await mount([], cwd);
  try {
    ui.send('/mode'); await vi.waitFor(() => expect(ui.screen()).toContain('auto · 当前'));
    expect(ui.screen()).toContain('writeRoots'); expect(ui.screen()).toContain('src');
    ui.terminal.input?.('\u001b[B');
    await vi.waitFor(() => expect(ui.screen()).toContain('> yolo'));
    expect(ui.screen()).toContain('未知 Shell/MCP');
    expect(ui.screen()).not.toContain('普通操作自动放行，包括写入与执行');
    expect(ui.agent.permission.mode).toBe('auto');
    ui.terminal.input?.('\r');
    expect(ui.agent.permission.mode).toBe('yolo');
    expect(JSON.parse(await readFile(join(cwd, 'agent.config.json'), 'utf8')).permissionMode).toBe('yolo');
    await vi.waitFor(() => expect(ui.screen()).toContain('权限模式已保存'));
    expect(ui.screen()).not.toContain('确认会话模式');
  } finally { await ui.dispose(); }
});
