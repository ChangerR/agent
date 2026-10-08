import { Key, matchesKey, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import { safeTerminalText, ui } from './theme.js';

export interface PanelItem {
  value: string;
  label: string;
  description?: string;
  current?: boolean;
}

export interface PanelOptions {
  title: string;
  kind: 'picker' | 'permission' | 'details';
  /** 设置面板显式保留完整细框；权限审批始终使用警示框。 */
  framed?: boolean;
  items?: PanelItem[];
  initialValue?: string;
  filterable?: boolean;
  body?: () => string;
  context?: () => string;
  previewBody?: () => string;
  requireSelection?: boolean;
  /** 窄屏标题与操作来源仍保留在边框内。 */
  compactTitle?: string;
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
    this.selected = options.requireSelection ? -1 : Math.max(0, index);
  }

  private get items(): PanelItem[] {
    return (this.options.items ?? []).filter((item) => `${item.label} ${item.value}`.toLowerCase().includes(this.filter.toLowerCase()));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = Math.max(3, Math.min(18, Math.floor(this.options.rows() * 0.8), this.options.rows() - 3));
    const inner = Math.max(1, width - 4);
    const permission = this.options.kind === 'permission';
    const framed = permission || this.options.framed === true;
    const color = permission ? ui.warning : ui.border;
    // 不信任工具提供的终端控制序列；单行标签也不能改变鼠标行映射。
    const safe = safeTerminalText;
    const labelText = (s: string) => safe(s).replace(/\s+/g, ' ');
    const row = (s: string, selected = false) => {
      const content = truncateToWidth(s, inner);
      const padded = content + ' '.repeat(Math.max(0, inner - visibleWidth(content)));
      const body = selected ? ui.selectedBg(padded) : padded;
      return truncateToWidth((framed ? color('│ ') : '  ') + body + (framed ? color(' │') : '  '), width);
    };
    const items = this.items;
    this.selected = Math.max(this.options.requireSelection ? -1 : 0, Math.min(this.selected, items.length - 1));
    const selected = items[this.selected];
    const heading = width < 40 ? this.options.compactTitle ?? this.options.title : this.options.title;
    const title = truncateToWidth(` ${labelText(heading)}${this.viewingDetails ? ' · 详情' : ''} `, Math.max(1, width - 2));
    // 普通选择器采用 pi 的开放式细线；设置保留细框，审批保留警示框。
    const lines = [framed
      ? color('╭') + (permission ? ui.warning(title) : ui.accent(chalk.bold(title))) + color(`${'─'.repeat(Math.max(0, width - 2 - visibleWidth(title)))}╮`)
      : ui.border('─') + ui.accent(chalk.bold(title)) + ui.border('─'.repeat(Math.max(0, width - 1 - visibleWidth(title))))];
    this.optionRows.clear();
    // 极小窗口将取消提示放进底框，给操作来源、选项留出可见行。
    const footerCount = height >= 8 ? 2 : height >= 5 ? 1 : 0;
    const capacity = height - 2 - footerCount;
    if (this.options.context && capacity >= 2) lines.push(row(permission ? chalk.bold(labelText(this.options.context())) : ui.muted(labelText(this.options.context()))));
    if (this.options.filterable && capacity >= 4) lines.push(row(ui.muted('搜索: ') + (this.filter ? ui.text(labelText(this.filter)) : ui.dim('输入模型名筛选'))));
    if (!this.viewingDetails && this.options.previewBody && capacity >= 5) lines.push(row(ui.muted(labelText(this.options.previewBody()))));
    const available = height - 1 - footerCount - lines.length;
    const optionCount = this.viewingDetails ? 0 : Math.min(items.length, Math.max(1, Math.min(6, available - (available >= 4 ? 1 : 0))));
    const start = Math.max(0, Math.min(this.selected - Math.floor(optionCount / 2), items.length - optionCount));
    for (let i = start; i < start + optionCount; i++) {
      const active = i === this.selected;
      this.optionRows.set(lines.length, i);
      const label = `${active ? '>' : ' '} ${labelText(items[i].label)}`;
      const current = items[i].current ? ui.muted(' · 当前') : '';
      lines.push(row((active ? (permission ? ui.warning : ui.accent)(chalk.bold(label)) : ui.text(label)) + current, active));
    }
    if (!this.viewingDetails && !items.length && available > 0) lines.push(row(ui.warning('无匹配项，请退格修改搜索')));
    const room = Math.max(0, height - 1 - footerCount - lines.length);
    const body = this.viewingDetails
      ? [selected?.description, this.options.body?.()].filter(Boolean).join('\n\n')
      : selected?.description ?? (!this.options.previewBody ? this.options.body?.() : '') ?? '';
    const bodyLines = body ? new Text(safe(body), 0, 0).render(inner) : [];
    this.bodyHeight = Math.max(1, room);
    this.bodyLines = bodyLines.length;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, bodyLines.length - room)));
    lines.push(...bodyLines.slice(this.viewingDetails ? this.offset : 0, (this.viewingDetails ? this.offset : 0) + room).map(line => row(ui.muted(line))));
    const scrollInfo = this.viewingDetails && bodyLines.length ? ` ${this.offset + 1}–${Math.min(this.offset + room, bodyLines.length)}/${bodyLines.length}` : this.selected < 0 ? ' 未选择' : items.length ? ` ${this.selected + 1}/${items.length}` : '';
    if (footerCount === 2) lines.push(row(ui.dim(`${this.viewingDetails ? '↑↓ 滚动' : '↑↓ 选择 · Enter 确认'}${scrollInfo}`)));
    const cancel = this.options.kind === 'permission' ? 'Esc 拒绝' : 'Esc 返回';
    if (footerCount) lines.push(row(ui.dim(this.options.kind === 'details' ? (width < 40 ? '↑↓ 滚动 · Esc 返回' : '↑↓/PgUp/PgDn 滚动 · Esc 返回') : this.viewingDetails ? `Tab/Enter 返回选项 · ${cancel}` : width < 28 ? '↑↓ Enter确认 Tab详情' : width < 40 ? '↑↓ Enter 确认 · Tab详情' : `Tab 查看完整详情 · ${cancel}`)));
    const bottom = truncateToWidth(height < 8 ? ` ${cancel} ` : '', Math.max(0, width - 2));
    lines.push(framed
      ? color(`╰${bottom}${'─'.repeat(Math.max(0, width - 2 - visibleWidth(bottom)))}╯`)
      : ui.border('─') + ui.dim(bottom) + ui.border('─'.repeat(Math.max(0, width - 1 - visibleWidth(bottom)))));
    return lines.map(line => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.options.cancel(); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.ctrl('o'))) {
      if (this.options.kind !== 'details') { this.viewingDetails = !this.viewingDetails; this.offset = 0; if (!this.viewingDetails && this.options.requireSelection) this.selected = -1; }
    } else if (matchesKey(data, Key.enter)) {
      if (this.viewingDetails && this.options.kind !== 'details') { this.viewingDetails = false; if (this.options.requireSelection) this.selected = -1; }
      else if (!this.viewingDetails) {
        const item = this.items[this.selected];
        if (item) this.options.select?.(item.value);
        return;
      }
    } else if (this.viewingDetails && (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown))) {
      this.scroll(matchesKey(data, Key.pageUp) ? -this.bodyHeight : this.bodyHeight);
    } else if (this.viewingDetails && (matchesKey(data, Key.home) || matchesKey(data, Key.end))) {
      this.scroll(matchesKey(data, Key.home) ? -this.bodyLines : this.bodyLines);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const direction = matchesKey(data, Key.up) ? -1 : 1;
      if (this.viewingDetails) this.scroll(direction);
      else if (this.items.length) this.selected = this.selected < 0 ? (direction < 0 ? this.items.length - 1 : 0) : (this.selected + direction + this.items.length) % this.items.length;
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
