import { Editor, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/** 保留 pi-tui 的编辑、粘贴、补全与光标；只把运行状态嵌入细分隔线。 */
export class Composer extends Editor {
  status = () => '';
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width < 12) return super.renderTopBorder(width, hiddenLineCount);
    const overflow = hiddenLineCount > 0 ? ` ↑ ${hiddenLineCount} more` : '';
    const label = truncateToWidth(this.status(), Math.max(1, width - 6 - visibleWidth(overflow))) + overflow;
    if (!label) return super.renderTopBorder(width, hiddenLineCount);
    return truncateToWidth(this.borderColor('── ') + label + this.borderColor(' ' + '─'.repeat(Math.max(0, width - visibleWidth(label) - 4))), width);
  }
}
