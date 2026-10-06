import { Key, matchesKey, Text, truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import chalk from 'chalk';

export interface PanelItem {
  value: string;
  label: string;
  description?: string;
}

export interface PanelOptions {
  title: string;
  kind: 'picker' | 'permission' | 'details';
  items?: PanelItem[];
  initialValue?: string;
  filterable?: boolean;
  body?: () => string;
  rows: () => number;
  changed: () => void;
  select?: (value: string) => void;
  cancel: () => void;
}

/** 底部交互面板：先给操作选项留空间，长内容在独立窗口里滚动。 */
export class InteractionPanel implements Component {
  private filter = '';
  private selected = 0;
  private offset = 0;
  private viewingDetails: boolean;
  private bodyHeight = 1;
  private bodyLines = 0;
  private optionRows = new Map<number, number>();

  constructor(private options: PanelOptions) {
    this.viewingDetails = options.kind === 'details';
    const index = this.items.findIndex((item) => item.value === options.initialValue);
    this.selected = Math.max(0, index);
  }

  private get items(): PanelItem[] {
    return (this.options.items ?? []).filter((item) => `${item.label} ${item.value}`.toLowerCase().includes(this.filter.toLowerCase()));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.max(3, Math.min(14, Math.floor(this.options.rows() * 0.6), this.options.rows() - 3));
    const items = this.items;
    this.selected = Math.max(0, Math.min(this.selected, items.length - 1));
    const selected = items[this.selected];
    const title = `${this.options.title}${this.viewingDetails && this.options.kind !== 'details' ? ' · 详情' : ''}`;
    const lines = [truncateToWidth(chalk.bold.cyan(`── ${title}`), width)];
    this.optionRows.clear();
    if (this.options.filterable && height >= 5) lines.push(truncateToWidth(` 搜索: ${this.filter || '输入模型名筛选'}`, width));
    const footerCount = height >= 6 ? 2 : 1;
    const available = height - lines.length - footerCount;
    const optionCount = this.viewingDetails ? 0 : Math.min(items.length, Math.max(1, Math.min(6, available - 2)));
    // 选项与确认提示始终保留；详情再长也不能把它们挤走。
    const start = Math.max(0, Math.min(this.selected - Math.floor(optionCount / 2), items.length - optionCount));
    for (let i = start; i < start + optionCount; i++) {
      const active = i === this.selected;
      this.optionRows.set(lines.length, i);
      const label = ` ${active ? '❯' : ' '} ${items[i].label}`;
      lines.push(truncateToWidth(active ? chalk.bgCyan.black.bold(label) : label, width));
    }
    if (!this.viewingDetails && !items.length && available > 0) lines.push(truncateToWidth(chalk.yellow(' 无匹配项，请退格修改搜索'), width));
    const room = Math.max(0, height - lines.length - footerCount);
    const body = this.options.body?.() ?? selected?.description ?? '';
    const bodyLines = body ? new Text(body, 1, 0).render(width) : [];
    this.bodyHeight = Math.max(1, room);
    this.bodyLines = bodyLines.length;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, bodyLines.length - room)));
    const content = bodyLines.slice(this.viewingDetails ? this.offset : 0, (this.viewingDetails ? this.offset : 0) + room);
    lines.push(...content);
    const scrollInfo = this.viewingDetails && bodyLines.length ? ` ${this.offset + 1}–${Math.min(this.offset + room, bodyLines.length)}/${bodyLines.length} 行` : items.length ? ` ${this.selected + 1}/${items.length}` : '';
    if (footerCount === 2) lines.push(truncateToWidth(chalk.bold(`${this.viewingDetails ? ' ↑↓ 滚动' : ' ↑↓ 选择 · Enter 确认'}${scrollInfo}`), width));
    const cancel = this.options.kind === 'permission' ? 'Esc 拒绝' : 'Esc 返回';
    const hint = this.options.kind === 'details'
      ? ' ↑↓ 滚动 · Esc 返回'
      : this.viewingDetails ? ` Tab/Enter 返回选项 · ${cancel}`
        : footerCount === 2 ? ` Tab 查看完整详情 · ${cancel}` : width < 28 ? ' ↑↓ Enter Tab Esc' : ' ↑↓选 Enter确认 Tab详情 Esc';
    lines.push(truncateToWidth(hint, width));
    return lines.slice(0, height);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.options.cancel(); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl('o'))) {
      if (this.options.kind !== 'details') { this.viewingDetails = !this.viewingDetails; this.offset = 0; }
    } else if (matchesKey(data, Key.enter)) {
      if (this.viewingDetails && this.options.kind !== 'details') this.viewingDetails = false;
      else if (!this.viewingDetails) {
        const item = this.items[this.selected];
        if (item) this.options.select?.(item.value);
        return;
      }
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const direction = matchesKey(data, Key.up) ? -1 : 1;
      if (this.viewingDetails) this.scroll(direction);
      else if (this.items.length) this.selected = (this.selected + direction + this.items.length) % this.items.length;
    } else if (this.options.filterable && !this.viewingDetails) {
      if (matchesKey(data, Key.backspace)) this.filter = Array.from(this.filter).slice(0, -1).join('');
      else if (/^[^\x00-\x1f\x7f]+$/u.test(data)) this.filter += data;
      this.selected = 0;
    }
    this.options.changed();
  }

  private scroll(delta: number): void {
    this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.bodyLines - this.bodyHeight)));
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel' && event.wheelDelta) {
      if (this.viewingDetails) this.scroll(event.wheelDelta);
      else this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + Math.sign(event.wheelDelta)));
    } else if (event.type === 'click') {
      const index = this.optionRows.get(event.y);
      if (index !== undefined) this.selected = index;
      // 点击只选中，权限操作始终需要 Enter 明确确认。
    } else return undefined;
    this.options.changed();
    return { handled: true, focus: true };
  }
}
