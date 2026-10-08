import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripTerminalSequences, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { UserMessage, ToolMessage, StreamMessages } from '../src/cli/messages.js';
import { Composer } from '../src/cli/composer.js';
import { markdownTheme, safeTerminalText } from '../src/cli/theme.js';

const plain = (component: Component, width: number) => component.render(width).map(stripTerminalSequences);
afterEach(() => vi.useRealTimers());

describe('pi 风格消息视觉快照', () => {
  it.each([40, 80, 100])('%i 列中文、组合字符、Markdown、工具状态稳定', (width) => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const components: Component[] = [new UserMessage('请检查 **权限设置**，保留草稿。\n中文 / café / e\u0301 / 🧑‍💻')];
    const streams = new StreamMessages(markdownTheme, () => false, c => components.push(c), () => {});
    streams.append('thinking', '先检查设置，再运行离线测试。');
    streams.append('text', '## 检查结果\n\n- **权限**保留显式确认\n- `draft` 不会自动保存\n\n```ts\nconst mode = "ask";\n```');
    streams.finish();
    const pending = new ToolMessage('bash: pnpm test', () => false, { name: 'bash', input: { command: 'pnpm test' } });
    components.push(pending);
    const success = new ToolMessage('read_file: src/中文.ts', () => false, { name: 'read_file', input: { path: 'src/中文.ts' } });
    success.detailId = 1; success.finish({ content: '第一行\n第二行\n第三行\n第四行\n完整结果仍可访问' }); components.push(success);
    const failure = new ToolMessage('bash: test', () => false, { name: 'bash', input: {} });
    failure.finish({ isError: true, content: '失败原因\n修复后可重新运行' }); components.push(failure);
    const lines = components.flatMap(c => plain(c, width));
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(lines.join('\n')).toMatchSnapshot();
  });

  it('长草稿上方同时显示运行阶段和隐藏行数', () => {
    // 直接检查受保护的布局钩子，不模拟或绕开输入行为。
    class TestComposer extends Composer {
      border(width: number, hidden: number) { return this.renderTopBorder(width, hidden); }
    }
    const editor = Object.create(TestComposer.prototype) as TestComposer;
    editor.borderColor = s => s;
    editor.status = () => '● 等待模型响应 · 12s';
    for (const width of [12, 13, 14, 24, 40, 80, 100]) {
      const line = editor.border(width, 23);
      if (width >= 40) {
        expect(line).toContain('等待模型响应');
        expect(line).toContain('↑ 23 more');
      }
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('长工具输出预览有界，保留完整详情；不执行来源终端控制序列', () => {
    const tool = new ToolMessage('\x1b[2Jbash', () => false, { name: 'bash', input: {} });
    tool.finish({ content: '\x1b]52;c;SECRET\x07' + '中文'.repeat(100_000) + '\nEND' });
    const lines = tool.render(40);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.join('\n')).not.toContain('\x1b[2J');
    expect(lines.join('\n')).not.toContain('\x1b]52');
    expect(tool.details()).toContain('END');
    expect(safeTerminalText('\x1b[2Jvisible\x9bhidden')).toBe('visiblehidden');
  });
});
