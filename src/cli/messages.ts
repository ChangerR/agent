import { Markdown, Text, truncateToWidth, type Component, type MarkdownTheme } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { AssistantMessage, ToolResult } from '../core/protocol/types.js';

/** 思考与工具保留完整内容，默认只展示摘要；展开是视图状态，不修改模型历史。 */
export class ThinkingMessage implements Component {
  text = '';
  constructor(private expanded: () => boolean) {}
  invalidate(): void {}
  render(width: number): string[] {
    if (this.expanded()) return new Text(chalk.dim(this.text), 1, 0).render(width);
    return [truncateToWidth(chalk.dim(` 思考 · ${this.text.length} 字符 · /details 展开`), width)];
  }
}

export class ToolMessage implements Component {
  private startedAt = Date.now();
  private finishedAt?: number;
  private result?: ToolResult;
  constructor(private summary: string, private expanded: () => boolean) {}
  finish(result: ToolResult): void {
    this.result = result;
    this.finishedAt = Date.now();
  }
  invalidate(): void {}
  render(width: number): string[] {
    const marker = !this.result ? '…' : this.result.isError ? '×' : '✓';
    const color = this.result?.isError ? chalk.red : !this.result ? chalk.cyan : chalk.dim;
    const seconds = this.finishedAt === undefined ? '' : ` · ${((this.finishedAt - this.startedAt) / 1000).toFixed(1)}s`;
    const lines = [truncateToWidth(color(` ${marker} ${this.summary.replace(/\s+/g, ' ')}${seconds}`), width)];
    if (!this.result) return lines;
    const content = this.result.content || '(无输出)';
    const output = content.split('\n');
    const limit = this.result.isError ? 5 : 2;
    const preview = this.expanded() ? content : output.slice(0, limit).map((line) => line.slice(0, 180)).join('\n');
    lines.push(...new Text(chalk.dim(preview), 3, 0).render(width));
    if (!this.expanded() && preview !== content) {
      lines.push(truncateToWidth(chalk.dim(`   ${output.length} 行输出 · /details 展开`), width));
    }
    return lines;
  }
}

type StreamBlock = { kind: 'text'; text: string; comp: Markdown } | { kind: 'thinking'; text: string; comp: ThinkingMessage };

/** 类型切换先刷新旧块；定时器可取消，完整消息校准已显示的增量。 */
export class StreamMessages {
  private blocks: StreamBlock[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private theme: MarkdownTheme,
    private expanded: () => boolean,
    private add: (component: Component) => void,
    private render: () => void,
  ) {}

  append(kind: 'text' | 'thinking', delta: string): void {
    let block = this.blocks.at(-1);
    if (!block || block.kind !== kind) {
      this.flush();
      block = kind === 'text'
        ? { kind, text: '', comp: new Markdown('', 1, 0, this.theme) }
        : { kind, text: '', comp: new ThinkingMessage(this.expanded) };
      this.blocks.push(block);
      this.add(block.comp);
    }
    block.text += delta;
    this.timer ??= setTimeout(() => this.flush(), 60);
  }

  finish(message?: AssistantMessage): void {
    if (message) {
      // 通常协议归约器会合并相邻同类增量；校准只在块结构一致时进行。
      const content = message.content.filter((b) => b.type === 'text' || b.type === 'thinking');
      if (content.length === this.blocks.length && content.every((b, i) => b.type === this.blocks[i].kind)) {
        content.forEach((b, i) => { this.blocks[i].text = b.type === 'text' ? b.text : b.thinking; });
      }
    }
    this.flush();
    this.blocks = [];
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const block of this.blocks) {
      if (block.kind === 'text') block.comp.setText(block.text);
      else block.comp.text = block.text;
    }
    this.render();
  }
}
