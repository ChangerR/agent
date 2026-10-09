import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { createAgent } from '../src/index.js';
import { startTui } from '../src/cli/app.js';
import { mkdtempProjectSync } from './helpers/project.js';

class MemoryTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  input?: (data: string) => void;
  start(input: (data: string) => void): void { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const dirs: string[] = [];
let home: string;
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'settings-tui-home-')); dirs.push(home); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); vi.stubEnv('AGENTLAB_SCREEN', 'alt'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
async function mount(global?: Record<string, unknown>) {
  let renderer!: TuiAltScreen;
  const original = TuiAltScreen.prototype.start;
  vi.spyOn(TuiAltScreen.prototype, 'start').mockImplementation(function (this: TuiAltScreen) { renderer = this; original.call(this); });
  const cwd = mkdtempProjectSync(join(tmpdir(), 'settings-tui-autosave-')); dirs.push(cwd);
  const path = join(cwd, 'agent.config.json'); write(path, { provider: 'fake', model: 'before', future: true });
  if (global) write(join(home, '.agent', 'config.json'), global);
  const agent = await createAgent(cwd, { autoSaveSessions: false });
  agent.settings.find(setting => setting.id === 'capability-selection')!.section.order = -1;
  const terminal = new MemoryTerminal(); const tui = startTui(agent, { terminal, onExit: vi.fn() });
  const key = (value: string) => terminal.input?.(value);
  return { agent, path, key, send: (value: string) => { key(value); key('\r'); },
    screen: () => renderer.getScreenLines().map(stripTerminalSequences).join('\n'),
    async dispose() { tui?.stop(); await agent.dispose(); } };
}
const shown = async (ui: Awaited<ReturnType<typeof mount>>, value: string) => vi.waitFor(() => expect(ui.screen()).toContain(value));

// 使用真正的底部交互组件，而非只测试命令插件回调。
describe('设置入口的一次提交', () => {
  it('模型和思考选择即落盘，取消不写，模型菜单的旧快照不会覆盖外部修改', async () => {
    const ui = await mount();
    try {
      ui.send('/think'); ui.key('\x1b[B'); ui.key('\r');
      await vi.waitFor(() => expect(read(ui.path).thinking).toBe('low'));
      expect(ui.agent.loop.thinking).toBe('low');
      const before = readFileSync(ui.path, 'utf8');
      ui.send('/model'); ui.key('gpt-4o'); ui.key('\x1b');
      expect(readFileSync(ui.path, 'utf8')).toBe(before);
      ui.send('/model'); ui.key('gpt-4o');
      write(ui.path, { provider: 'fake', model: 'external', external: true }); ui.key('\r');
      await shown(ui, '配置已变化');
      expect(read(ui.path)).toEqual({ provider: 'fake', model: 'external', external: true });
      expect(ui.agent.loop.model).toBe('before');
      ui.send('/model'); ui.key('gpt-4o'); ui.key('\r');
      await vi.waitFor(() => expect(read(ui.path).model).toBe('gpt-4o'));
      expect(ui.agent.loop.model).toBe('gpt-4o');
    } finally { await ui.dispose(); }
  });

  it('插件 JSON 默认项目，完整 JSON 一次提交即保存并提示重启，Esc 放弃', async () => {
    const ui = await mount();
    try {
      ui.send('/settings'); ui.key('\r');
      await shown(ui, '插件实现与权限策略 · 本项目');
      expect(ui.screen()).not.toContain('选择作用域'); expect(ui.screen()).not.toContain('Save');
      ui.key('\r'); await shown(ui, '编辑 JSON');
      const before = readFileSync(ui.path, 'utf8');
      ui.key('\x05'); ui.key('\x15'); ui.key('{"reviewer":false}'); ui.key('\x1b');
      expect(readFileSync(ui.path, 'utf8')).toBe(before);
      await shown(ui, '切换到全局'); ui.key('\r'); await shown(ui, '输入完整 JSON');
      ui.key('\x05'); ui.key('\x15'); ui.key('\x1b[200~'); ui.key('{\n  "reviewer": false\n}'); ui.key('\x1b[201~'); ui.key('\r');
      await vi.waitFor(() => expect(read(ui.path).capabilities).toEqual({ reviewer: false }));
      await shown(ui, '重启后生效');
      expect(ui.agent.plugins.selected('reviewer')?.id).toBe('model');
      expect(ui.screen()).not.toContain('确认 Save');
    } finally { await ui.dispose(); }
  });

  it('可选全局入口无需确认，保持项目覆盖与其他字段', async () => {
    const ui = await mount({ capabilities: { reviewer: 'model' }, futureGlobal: true });
    try {
      write(ui.path, { provider: 'fake', model: 'before', capabilities: { reviewer: 'model' }, future: true });
      const before = readFileSync(ui.path, 'utf8');
      ui.send('/settings'); ui.key('\r'); await shown(ui, '切换到全局');
      ui.key('\x1b[B'); ui.key('\x1b[B'); ui.key('\r');
      await shown(ui, '插件实现与权限策略 · 全局');
      ui.key('\r'); await shown(ui, '输入完整 JSON'); ui.key('\x05'); ui.key('\x15'); ui.key('{}'); ui.key('\r');
      await vi.waitFor(() => expect(read(join(home, '.agent', 'config.json'))).toEqual({ capabilities: {}, futureGlobal: true }));
      expect(readFileSync(ui.path, 'utf8')).toBe(before);
    } finally { await ui.dispose(); }
  });

  it('异步验证期间 Esc 放弃后不提交，插件错误不回显原始 JSON 或凭据', async () => {
    const ui = await mount();
    let release!: () => void;
    const section = ui.agent.settings.find(setting => setting.id === 'capability-selection')!.section;
    const commit = vi.fn(section.commit!); section.commit = commit;
    const draft = vi.fn<NonNullable<typeof section.draft>>(() => new Promise(resolve => { release = () => resolve({}); })); section.draft = draft;
    try {
      ui.send('/settings'); ui.key('\r'); await shown(ui, '切换到全局'); ui.key('\r'); await shown(ui, '输入完整 JSON');
      ui.key('\x05'); ui.key('\x15'); ui.key('{}'); ui.key('\r'); await shown(ui, '正在验证并保存');
      ui.key('\x1b'); release(); await shown(ui, '编辑 JSON');
      expect(commit).not.toHaveBeenCalled(); expect(read(ui.path)).not.toHaveProperty('capabilities');
      draft.mockImplementation(() => { throw new Error('SECRET_PLUGIN_ERROR'); });
      ui.key('\r'); await shown(ui, '输入完整 JSON'); ui.key('\x05'); ui.key('\x15'); ui.key('{"private":"SECRET_SUBMITTED_JSON"}'); ui.key('\r');
      await shown(ui, '设置失败'); expect(ui.screen()).not.toContain('SECRET_PLUGIN_ERROR'); expect(ui.screen()).not.toContain('SECRET_SUBMITTED_JSON');
    } finally { await ui.dispose(); }
  });
  it('会话恢复废弃未确认模型候选及正在验证的 JSON，不写入新会话', async () => {
    const ui = await mount();
    const restored = () => ui.agent.events.emit({ type: 'session_restored', id: 'restored-session', title: '离线恢复', model: 'before', thinking: 'off', messages: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const section = ui.agent.settings.find(setting => setting.id === 'capability-selection')!.section;
    let release!: () => void;
    const commit = vi.fn(section.commit!); section.commit = commit;
    section.draft = () => new Promise(resolve => { release = () => resolve({}); });
    try {
      const before = readFileSync(ui.path, 'utf8');
      ui.send('/model'); ui.key('gpt-4o'); restored(); ui.key('\r');
      await shown(ui, '已恢复会话'); expect(readFileSync(ui.path, 'utf8')).toBe(before); expect(ui.agent.loop.model).toBe('before');
      ui.send('/settings'); ui.key('\r'); await shown(ui, '切换到全局'); ui.key('\r'); await shown(ui, '输入完整 JSON');
      ui.key('\r'); await shown(ui, '正在验证并保存'); restored(); release();
      await shown(ui, '已恢复会话');
      expect(commit).not.toHaveBeenCalled(); expect(ui.screen()).not.toContain('编辑 JSON'); expect(readFileSync(ui.path, 'utf8')).toBe(before);
    } finally { await ui.dispose(); }
  });

});
