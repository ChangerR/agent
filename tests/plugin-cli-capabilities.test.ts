import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TuiAltScreen, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';
import { createAgent } from '../src/index.js';
import { startTui } from '../src/cli/app.js';
import { PluginToolMessage } from '../src/cli/plugin-renderers.js';
import { definePlugin, type Plugin } from '../src/sdk/index.js';

class MemoryTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; output = '';
  input?: (data: string) => void; resize?: () => void;
  start(input: (data: string) => void, resize: () => void): void { this.input = input; this.resize = resize; }
  stop(): void {} async drainInput(): Promise<void> {} write(data: string): void { this.output += data; }
  moveBy(): void {} hideCursor(): void {} showCursor(): void {} clearLine(): void {} clearFromCursor(): void {} clearScreen(): void {} setTitle(): void {} setProgress(): void {}
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function mount(plugins: Plugin[], cwd?: string) {
  const dir = cwd ?? await mkdtemp(join(tmpdir(), 'agent-plugin-ui-'));
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
      expect(ui.screen()).toContain('test.generic-ui'); expect(ui.screen()).toContain('newSession'); expect(ui.screen()).toContain('"enabled": true');
    } finally { await ui.dispose(); }
  });
  it('loads an optional external TUI entry for commands, settings, status and tool rendering', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agent-plugin-entry-')); const entry = join(cwd, 'entry.mjs');
    await writeFile(entry, `export function createTuiAdapter(ctx) { if ('agent' in ctx || 'permission' in ctx) throw new Error('unbounded context'); if (!ctx.inspect().commands.some(c => c.id === 'custom_frontend') || typeof ctx.invokeTool !== 'function') throw new Error('missing bounded runtime'); return {
      commands: { custom_frontend() { ctx.say('external command UI'); } },
      settings: { custom_frontend(back) { ctx.showDetails('external settings UI', () => 'renderer-provided editor', back); } },
      statusItems: { custom: () => 'plugin status ready' },
      toolRenderers: { custom_tool: (operation) => ['PLUGIN TOOL ' + (operation.result?.content ?? 'running')] },
    }; }`);
    const ui = await mount([definePlugin({ manifest: { id: 'test.external-ui', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
      ctx.provide.command('custom_frontend', { description: '外部界面', handler: () => ({ type: 'text', text: 'headless command implementation' }) });
      ctx.provide.settings('custom_frontend', { title: '外部插件设置', order: -1, schema: {}, applyMode: 'restart' });
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
