import { createElement } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ children, href }) =>
    createElement('span', { className: 'link-text', title: href }, children),
  table: ({ children }) =>
    createElement(
      'div',
      {
        className: 'markdown-table-scroll',
        role: 'region',
        'aria-label': 'Markdown 表格',
        tabIndex: 0,
      },
      createElement('table', undefined, children),
    ),
};

/** 只扩展 Markdown 语法，不解析模型输出中的原始 HTML。 */
export function MessageMarkdown({ text }: { text: string }) {
  return createElement(
    'div',
    { className: 'markdown' },
    createElement(Markdown, { remarkPlugins: [remarkGfm], components }, text),
  );
}
