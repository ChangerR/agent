import { describe, expect, it, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { InteractionPanel } from '../src/cli/interaction-panel.js';
import { SettingsInputPanel } from '../src/cli/settings-input.js';

const display = (lines: string[]) => lines.map(stripTerminalSequences);
const click = (y: number, width: number, height: number): TuiMouseEvent => ({
  type: 'click', button: 'left', x: 4, y, screenX: 4, screenY: y, width, height,
  shift: false, alt: false, ctrl: false,
});

describe('pi 风格交互面板', () => {
  it.each([[40, 12], [80, 24]])('普通选择器使用开放细线并保持 %i×%i 内的行映射', (width, rows) => {
    const select = vi.fn();
    const panel = new InteractionPanel({ title: '选择模型', kind: 'picker', filterable: true,
      items: [{ value: 'one', label: '模型一', current: true }, { value: 'two', label: '模型二', description: '模型二说明' }],
      rows: () => rows, changed: vi.fn(), cancel: vi.fn(), select,
    });
    const lines = display(panel.render(width));
    expect(lines[0]).toMatch(/^─ 选择模型 .*─$/);
    expect(lines.join('\n')).not.toMatch(/[╭╮╰╯│]/);
    expect(lines.join('\n')).toContain('> 模型一 · 当前');
    expect(lines.join('\n')).toContain('Esc 返回');
    expect(lines.length).toBeLessThanOrEqual(rows - 3);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    const target = lines.findIndex(line => line.includes('模型二'));
    panel.handleMouse(click(target, width, lines.length));
    expect(select).not.toHaveBeenCalled();
    expect(display(panel.render(width)).join('\n')).toContain('> 模型二');
    panel.handleInput('\r');
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith('two');
  });

  it.each([[40, 12], [80, 24]])('显式设置面板 %i×%i 保留完整细框，不影响选择和返回', (width, rows) => {
    for (const kind of ['picker', 'details'] as const) {
      const cancel = vi.fn();
      const select = vi.fn();
      const panel = new InteractionPanel({ title: '项目权限设置', kind, framed: true,
        items: [{ value: 'draft', label: '项目草稿' }], body: () => '需要明确 Save 才保存',
        rows: () => rows, changed: vi.fn(), cancel, select,
      });
      const lines = display(panel.render(width));
      expect(lines[0]).toMatch(/^╭ 项目权限设置 .*╮$/);
      expect(lines.at(-1)).toMatch(/^╰.*╯$/);
      expect(lines.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│'))).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(rows - 3);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      if (kind === 'picker') {
        expect(lines.join('\n')).toContain('> 项目草稿');
        panel.handleInput('\r');
        expect(select).toHaveBeenCalledWith('draft');
      }
      panel.handleInput('\x1b');
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it.each([[24, 8], [40, 12], [80, 24]])('审批 %i×%i 保留边框、来源与重新选择后的 Enter 确认', (width, rows) => {
    const select = vi.fn();
    const cancel = vi.fn();
    const panel = new InteractionPanel({ title: 'Agent 正在请求权限', compactTitle: '权限 · bash', kind: 'permission', requireSelection: true,
      context: () => 'bash · 触发: 危险检测', body: () => '完整参数\n'.repeat(12),
      items: [{ value: 'once', label: '允许一次' }, { value: 'deny', label: '拒绝' }],
      rows: () => rows, changed: vi.fn(), select, cancel,
    });
    let lines = display(panel.render(width));
    expect(lines[0]).toMatch(/^╭.*╮$/);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/);
    expect(lines.join('\n')).toContain('bash');
    expect(lines.join('\n')).toContain('Esc 拒绝');
    expect(lines.length).toBeLessThanOrEqual(rows - 3);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    panel.handleInput('\r');
    expect(select).not.toHaveBeenCalled();
    panel.handleInput('\x1b[B');
    panel.handleInput('\t');
    panel.render(width);
    panel.handleInput('\r');
    panel.handleInput('\r');
    expect(select).not.toHaveBeenCalled();
    panel.handleInput('\x1b[A');
    lines = display(panel.render(width));
    const target = lines.findIndex(line => line.includes('> 拒绝'));
    expect(target).toBeGreaterThanOrEqual(0);
    panel.handleMouse(click(target, width, lines.length));
    expect(select).not.toHaveBeenCalled();
    panel.handleInput('\r');
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith('deny');
    panel.handleInput('\x1b');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('工具文本不能注入控制序列或伪造选项行，筛选与详情仍可返回', () => {
    const select = vi.fn();
    const panel = new InteractionPanel({ title: '模型\x1b[2J\n选择', kind: 'picker', filterable: true,
      items: [{ value: 'one', label: '模型\n一\x1b]52;c;hidden\x07', description: '可见正文\x1b[31m\n完整详情' }],
      rows: () => 12, changed: vi.fn(), cancel: vi.fn(), select,
    });
    const raw = panel.render(40);
    expect(raw.join('\n')).not.toContain('\x1b[2J');
    expect(raw.join('\n')).not.toContain('\x1b]52');
    expect(raw.every(line => !line.includes('\n'))).toBe(true);
    const lines = display(raw);
    panel.handleMouse(click(lines.findIndex(line => line.includes('> 模型 一')), 40, lines.length));
    panel.handleInput('\r');
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith('one');
    panel.handleInput('missing');
    expect(display(panel.render(40)).join('\n')).toContain('无匹配项');
    for (let i = 0; i < 'missing'.length; i++) panel.handleInput('\x7f');
    panel.handleInput('\t');
    expect(display(panel.render(40)).join('\n')).toContain('完整详情');
    panel.handleInput('\r');
    expect(select).toHaveBeenCalledTimes(1);
  });

  it.each([[24, 8], [40, 12], [80, 24]])('字段草稿 %i×%i 保留完整细框，保留校验与取消', (width, rows) => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const panel = new SettingsInputPanel({ title: '项目\x1b[2J规则', value: 'bad rule', description: '\x1b]52;c;hidden\x07草稿尚未保存',
      validate: () => '无效规则', onSubmit, onCancel, rows: () => rows, changed: vi.fn(),
    });
    const raw = panel.render(width);
    const lines = display(raw);
    expect(lines[0]).toMatch(/^╭ 项目规则 .*╮$/);
    expect(lines.at(-1)).toMatch(/^╰ .*╯$/);
    expect(lines.at(-1)).toMatch(/Esc ?返回/);
    expect(lines.slice(1, -1).every(line => line.startsWith('│') && line.endsWith('│'))).toBe(true);
    expect(raw.join('\n')).not.toContain('\x1b[2J');
    expect(raw.join('\n')).not.toContain('\x1b]52');
    expect(lines.length).toBeLessThanOrEqual(rows - 3);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    panel.handleInput('\r');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(display(panel.render(width)).join('\n')).toContain('无效规则');
    panel.handleInput('\x1b');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
