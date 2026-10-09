/** 设置中的单行输入；Enter 提交并保存当前字段，Esc 取消未提交输入。 */
import { Input, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { safeTerminalText, ui } from './theme.js';

export interface SettingsInputRequest {
  title: string;
  value: string;
  description: string;
  /** JSON 初始值可包含格式化换行；普通字段保持单行校验。 */
  format?: 'json';
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export class SettingsInputPanel implements Component {
  private input = new Input({ prompt: ui.accent('> ') });
  private error?: string;
  private inputRow = 1;
  private pending = true;
  constructor(private options: SettingsInputRequest & { rows: () => number; changed: () => void }) {
    let initial = options.value;
    if (options.format === 'json') { try { initial = JSON.stringify(JSON.parse(initial)); } catch { /* 无效初值照常交给校验 */ } }
    this.input.setValue(initial.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    this.input.focused = true;
    this.input.onSubmit = value => {
      if (!this.pending) return;
      this.error = options.validate?.(value);
      if (!this.error) { this.pending = false; options.onSubmit(value); }
      else options.changed();
    };
    this.input.onEscape = () => { if (this.pending) { this.pending = false; options.onCancel(); } };
  }
  invalidate(): void { this.input.invalidate(); }
  render(width: number): string[] {
    const height = Math.max(3, Math.min(10, this.options.rows() - 3));
    const inner = Math.max(1, width - 4);
    const row = (line: string) => {
      const content = truncateToWidth(line, inner);
      return truncateToWidth(ui.border('│ ') + content + ' '.repeat(Math.max(0, inner - visibleWidth(content))) + ui.border(' │'), width);
    };
    const rule = (label: string, title = false) => {
      const content = truncateToWidth(` ${safeTerminalText(label).replace(/\s+/g, ' ')} `, Math.max(0, width - 2));
      return truncateToWidth(ui.border(title ? '╭' : '╰') + (title ? ui.accent(chalk.bold(content)) : ui.dim(content)) + ui.border('─'.repeat(Math.max(0, width - visibleWidth(content) - 2)) + (title ? '╮' : '╯')), width);
    };
    const lines = [rule(this.options.title, true)];
    this.inputRow = lines.length;
    lines.push(...this.input.render(inner).map(row));
    const body = this.error ? ui.error(safeTerminalText(this.error)) : ui.muted(safeTerminalText(this.options.description));
    const room = Math.max(0, height - lines.length - 1);
    lines.push(...new Text(body, 0, 0).render(inner).slice(0, room).map(row));
    lines.push(rule(width < 28 ? 'Enter保存 · Esc取消' : 'Enter 保存 · Esc 取消'));
    return lines.slice(0, height);
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
    // pi-tui 的粘贴通道保留部分控制字符；在下一次渲染前转成可见转义，防止终端注入。
    const value = this.input.getValue();
    const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (value !== escaped) { this.input.setValue(escaped); this.error = '控制字符已转为可见转义，请核对后再提交。'; }
    this.options.changed();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y !== this.inputRow) return undefined;
    return this.input.handleMouse({ ...event, x: Math.max(0, event.x - 2), y: 0, width: Math.max(1, event.width - 4) });
  }
}
