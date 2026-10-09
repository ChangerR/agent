/** 可选 renderer 只影响展示，失败回落通用视图，不改变已执行工具的结果。 */
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ToolResult } from '../core/protocol/types.js';
import { observationSnapshot } from '../runtime/plugin-host.js';
import { ToolMessage } from './messages.js';
import { safeTerminalText } from './theme.js';
import type { TuiToolRenderInput, TuiToolRenderer } from './tui-plugins.js';
export class PluginToolMessage extends ToolMessage {
  private snapshot: TuiToolRenderInput;
  private failed?: TuiToolRenderer;
  constructor(summary: string, expanded: () => boolean, operation: { name: string; input: unknown }, private renderer: () => TuiToolRenderer | undefined, private report: (message: string) => void) {
    super(summary, expanded, operation);
    this.snapshot = observationSnapshot(operation);
  }
  override finish(result: ToolResult): void {
    super.finish(result);
    this.snapshot = observationSnapshot({ ...this.snapshot, result });
  }
  override render(width: number): string[] {
    const renderer = this.renderer();
    if (renderer && renderer !== this.failed) {
      try {
        const lines = renderer(this.snapshot, width);
        if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) throw new Error('renderer 必须返回文本行数组');
        return lines.map(line => truncateToWidth(safeTerminalText(line), width));
      } catch (error) {
        this.failed = renderer;
        this.report(`工具界面已回落通用视图: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return super.render(width);
  }
}
