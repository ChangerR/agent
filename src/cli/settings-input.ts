/** 设置中的单行草稿输入；Enter 只提交字段草稿，不保存配置。 */
import { Input, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import chalk from 'chalk';

export interface SettingsInputRequest {
  title: string;
  value: string;
  description: string;
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export class SettingsInputPanel implements Component {
  private input = new Input({ prompt: '> ' });
  private error?: string;
  private inputRow = 1;
  constructor(private options: SettingsInputRequest & { rows: () => number; changed: () => void }) {
    this.input.setValue(options.value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    this.input.focused = true;
    this.input.onSubmit = value => {
      this.error = options.validate?.(value);
      if (!this.error) options.onSubmit(value);
      else options.changed();
    };
    this.input.onEscape = options.onCancel;
  }
  invalidate(): void { this.input.invalidate(); }
  render(width: number): string[] {
    const height = Math.max(3, Math.min(10, this.options.rows() - 3));
    const inner = Math.max(1, width - 4);
    const frame = (line: string) => {
      const content = truncateToWidth(line, inner);
      return truncateToWidth(`│ ${content}${' '.repeat(Math.max(0, inner - visibleWidth(content)))} │`, width);
    };
    const border = (left: string, label: string, right: string) => {
      const content = truncateToWidth(label, Math.max(0, width - 4));
      return truncateToWidth(`${left} ${content} ${'─'.repeat(Math.max(0, width - visibleWidth(content) - 4))}${right}`, width);
    };
    const lines = [chalk.cyan(border('╭', this.options.title, '╮'))];
    this.inputRow = lines.length;
    lines.push(...this.input.render(inner).map(frame));
    const body = this.error ? chalk.red(this.error) : this.options.description;
    const room = Math.max(0, height - lines.length - 1);
    lines.push(...new Text(body, 0, 0).render(inner).slice(0, room).map(frame));
    lines.push(chalk.cyan(border('╰', 'Enter 草稿 · Esc 返回 · 需 Save', '╯')));
    return lines.slice(0, height);
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
    // pi-tui 的粘贴通道保留部分控制字符；在下一次渲染前转成可见转义，防止终端注入。
    const value = this.input.getValue();
    const escaped = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (value !== escaped) { this.input.setValue(escaped); this.error = '控制字符已转为可见转义，请核对后再提交草稿。'; }
    this.options.changed();
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.y !== this.inputRow) return undefined;
    return this.input.handleMouse({ ...event, x: Math.max(0, event.x - 2), y: 0, width: Math.max(1, event.width - 4) });
  }
}
