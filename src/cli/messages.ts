import { Markdown, Spacer, Text, truncateToWidth, type Component, type MarkdownTheme } from '@earendil-works/pi-tui';
import chalk from 'chalk';
import type { PermissionRequest } from '../core/events.js';
import type { AssistantMessage, Message, ToolResult } from '../core/protocol/types.js';

export interface DetailEntry { id: number; title: string; body: () => string }

/** 编号只属于当前视图，不写入模型协议或保存的历史。 */
export class DetailRegistry {
  private entries: DetailEntry[] = [];
  add(title: string, body: () => string): number {
    const id = this.entries.length + 1;
    this.entries.push({ id, title, body });
    return id;
  }
  get(id: number): DetailEntry | undefined { return this.entries.find((entry) => entry.id === id); }
  clear(): void { this.entries = []; }
}

export class UserMessage implements Component {
  constructor(private content: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [truncateToWidth(chalk.bold.cyan(' ❯ 你'), width), ...new Text(this.content, 3, 0).render(width)];
  }
}

class AssistantText implements Component {
  private markdown: Markdown;
  constructor(text: string, theme: MarkdownTheme) { this.markdown = new Markdown(text, 3, 0, theme); }
  setText(text: string): void { this.markdown.setText(text); }
  invalidate(): void { this.markdown.invalidate(); }
  render(width: number): string[] {
    return [truncateToWidth(chalk.bold(' ● Agent'), width), ...this.markdown.render(width)];
  }
}

/** 思考与工具保留完整内容，默认只展示摘要；展开是视图状态，不修改模型历史。 */
export class ThinkingMessage implements Component {
  text = '';
  detailId?: number;
  private active = true;
  constructor(private expanded: () => boolean) {}
  finish(): void { this.active = false; }
  invalidate(): void {}
  render(width: number): string[] {
    const title = ` ◇ 思考${this.detailId ? ` #${this.detailId}` : ''} · ${this.active ? '进行中' : '已结束'}`;
    const lines = [truncateToWidth(chalk.cyan(title), width)];
    if (this.expanded()) lines.push(...new Text(this.text, 3, 0).render(width));
    else {
      const preview = this.text.trim().split('\n').filter(Boolean).at(-1) ?? '正在整理思路…';
      lines.push(truncateToWidth(`   ${preview}`, width));
      lines.push(truncateToWidth(`   ${this.detailId ? `/details ${this.detailId}` : '/details'} · Ctrl+O 展开`, width));
    }
    return lines;
  }
}

export class ToolMessage implements Component {
  private startedAt = Date.now();
  private finishedAt?: number;
  private result?: ToolResult;
  detailId?: number;
  constructor(private summary: string, private expanded: () => boolean, private operation?: { name: string; input: unknown }) {}
  finish(result: ToolResult): void {
    this.result = result;
    this.finishedAt = Date.now();
  }
  invalidate(): void {}
  details(): string {
    return `${this.summary}\n${this.operation ? `\n完整参数:\n${JSON.stringify(this.operation.input, null, 2)}\n` : ''}\n${this.result ? `执行${this.result.isError ? '失败' : '完成'}:\n${this.result.content}` : '正在执行，尚无结果'}`;
  }
  render(width: number): string[] {
    const marker = !this.result ? '…' : this.result.isError ? '×' : '✓';
    const color = this.result?.isError ? chalk.red : !this.result ? chalk.cyan : chalk.green;
    const seconds = ` · ${(((this.finishedAt ?? Date.now()) - this.startedAt) / 1000).toFixed(1)}s`;
    const label = this.operation?.name ?? this.summary.replace(/\s+/g, ' ');
    const lines = [truncateToWidth(color(` ${marker} 工具${this.detailId ? ` #${this.detailId}` : ''} · ${label} · ${!this.result ? '执行中' : this.result.isError ? '失败' : '完成'}${seconds}`), width)];
    if (this.operation) lines.push(truncateToWidth(`   ${this.summary.replace(/\s+/g, ' ')}`, width));
    const detailHint = truncateToWidth(`   ${this.detailId ? `/details ${this.detailId}` : '/details'} · Ctrl+O ${this.expanded() ? '收起' : '展开'}`, width);
    if (!this.result) return [...lines, detailHint];
    const content = this.result.content || '(无输出)';
    const output = content.split('\n');
    const limit = this.result.isError ? 5 : 2;
    const preview = this.expanded() ? content : output.slice(0, limit).map((line) => line.slice(0, 180)).join('\n');
    lines.push(...new Text(preview, 3, 0).render(width));
    if (this.detailId || !this.expanded() && preview !== content) lines.push(detailHint);
    return lines;
  }
}

export class PermissionMessage implements Component {
  private result = '等待你确认';
  detailId?: number;
  constructor(private request: PermissionRequest) {}
  finish(result: string): void { this.result = result; }
  details(): string { return `${this.result}\n${this.request.reason}\n\n完整参数:\n${JSON.stringify(this.request.input, null, 2)}`; }
  invalidate(): void {}
  render(width: number): string[] {
    return [
      truncateToWidth(chalk.bold.yellow(` ? 权限 · ${this.request.toolName} · ${this.result}`), width),
      truncateToWidth(`   ${this.request.summary.replace(/\s+/g, ' ')}`, width),
      ...(this.detailId ? [truncateToWidth(`   /details ${this.detailId} 查看审批理由和参数`, width)] : []),
    ];
  }
}

type StreamBlock = { kind: 'text'; text: string; comp: AssistantText } | { kind: 'thinking'; text: string; comp: ThinkingMessage };

/** 类型切换先刷新旧块；定时器可取消，完整消息校准已显示的增量。 */
export class StreamMessages {
  private blocks: StreamBlock[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private theme: MarkdownTheme,
    private expanded: () => boolean,
    private add: (component: Component) => void,
    private render: () => void,
    private details?: DetailRegistry,
  ) {}

  append(kind: 'text' | 'thinking', delta: string): void {
    let block = this.blocks.at(-1);
    if (!block || block.kind !== kind) {
      this.flush();
      const previous = this.blocks.at(-1);
      if (previous?.kind === 'thinking') previous.comp.finish();
      block = kind === 'text'
        ? { kind, text: '', comp: new AssistantText('', this.theme) }
        : { kind, text: '', comp: new ThinkingMessage(this.expanded) };
      if (block.kind === 'thinking' && this.details) {
        const thinking = block.comp;
        thinking.detailId = this.details.add('思考', () => thinking.text);
      }
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
    for (const block of this.blocks) if (block.kind === 'thinking') block.comp.finish();
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

/** 折叠的长文本。摘要消息用它，展开状态跟 /details 走，不改历史。 */
export class CollapsibleText implements Component {
  constructor(
    private title: string,
    private body: string,
    private expanded: () => boolean,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (this.expanded()) {
      return new Text(chalk.dim(`${this.title}\n${this.body}`), 1, 0).render(width);
    }
    const preview = this.body.replace(/\s+/g, ' ').trim();
    return [truncateToWidth(chalk.dim(` ${this.title} · ${preview.length} 字符 · /details 展开`), width)];
  }
}

export interface HistoryRenderOptions {
  theme: MarkdownTheme;
  expanded: () => boolean;
  summarize: (name: string, input: unknown) => string;
  details?: DetailRegistry;
}

/** 把已保存的历史画回转录区。工具结果按 toolUseId 对上之前的 ToolMessage。 */
export function renderHistory(messages: readonly Message[], options: HistoryRenderOptions): Component[] {
  const components: Component[] = [];
  const tools = new Map<string, ToolMessage>();
  const pushUserText = (content: string) => {
    components.push(new Spacer(1));
    components.push(new UserMessage(content));
  };

  for (const message of messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.source === 'summary') {
          components.push(new CollapsibleText('早期对话摘要', message.content, options.expanded));
        } else {
          pushUserText(message.content);
        }
        continue;
      }
      for (const block of message.content) {
        if (block.type === 'text') {
          pushUserText(block.text);
          continue;
        }
        let tool = tools.get(block.toolUseId);
        if (!tool) {
          tool = new ToolMessage(block.toolUseId, options.expanded);
          components.push(tool);
        }
        tool.finish({ content: block.content, isError: block.isError });
        tools.delete(block.toolUseId);
      }
      continue;
    }

    for (const block of message.content) {
      if (block.type === 'text') {
        components.push(new AssistantText(block.text, options.theme));
      } else if (block.type === 'thinking') {
        const thinking = new ThinkingMessage(options.expanded);
        thinking.text = block.thinking;
        thinking.finish();
        if (options.details) thinking.detailId = options.details.add('思考', () => thinking.text);
        components.push(thinking);
      } else if (block.type === 'redacted_thinking') {
        components.push(new Text(chalk.dim('思考 · 已由服务端打码'), 1, 0));
      } else {
        const tool = new ToolMessage(options.summarize(block.name, block.input), options.expanded, { name: block.name, input: block.input });
        if (options.details) tool.detailId = options.details.add(`工具 · ${block.name}`, () => tool.details());
        tools.set(block.id, tool);
        components.push(tool);
      }
    }
  }

  for (const tool of tools.values()) {
    tool.finish({ content: '(结果未保存)', isError: true });
  }
  return components;
}
