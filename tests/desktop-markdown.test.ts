import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from '../desktop/renderer/MessageMarkdown.js';
import { markdownSample } from '../desktop/shared/markdown-sample.js';

const render = (text: string) => renderToStaticMarkup(createElement(MessageMarkdown, { text }));

describe('桌面 Markdown 消息', () => {
  it('截图中的管道表格解析为表头和单元格，并保持列对齐与独立滚动容器', () => {
    const html = render(markdownSample);
    expect(html).toContain('aria-label="Markdown 表格"');
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<td style="text-align:left"><code>src/core/</code></td>');
    expect(html).toContain('<th style="text-align:center">状态</th>');
    expect(html).not.toContain('| :---');
    expect(html.match(/<tr>/g)).toHaveLength(5);
  });
  it('代码保持换行缩进，任务列表、删除线和引用输出各自语义元素', () => {
    const html = render(markdownSample);
    expect(html).toContain('<pre><code class="language-text">');
    expect(html).toContain('\n                      │');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<del>旧排版</del>');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(2);
  });
  it('流式到达的半张表格可渲染；原始 HTML 和脚本链接不能变成可执行内容', () => {
    expect(() => render(markdownSample.slice(0, 130))).not.toThrow();
    const html = render('<script>alert(1)</script>\n\n[x](javascript:alert%281%29)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('javascript:');
  });
});
