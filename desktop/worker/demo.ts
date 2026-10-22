import { FakeProvider, textResponse, toolUseResponse } from '../../src/providers/fake.js';
import { definePlugin } from '../../src/sdk/index.js';
import { markdownSample } from '../shared/markdown-sample.js';
/** 离线剧本只在宿主专门创建的演示目录使用，不替换真实项目配置。 */
export function demoProviderPlugin() {
  const provider = new FakeProvider([
    (request) => {
      const history = request.messages.filter((m) => m.role !== 'user' || m.source !== 'runtime');
      const last = history.at(-1);
      if (last?.role === 'user' && last.content === '演示 Markdown 排版')
        return textResponse(markdownSample);
      if (last?.role === 'user' && typeof last.content === 'string')
        return toolUseResponse(
          [
            {
              id: 'demo-read-' + request.messages.length,
              name: 'read_file',
              input: { path: 'README.md' },
            },
          ],
          '这是离线演示。我先读取 README.md，再请求创建 demo-note.txt。',
        );
      const blocks = last?.role === 'user' && Array.isArray(last.content) ? last.content : [];
      if (blocks.some((b) => b.type === 'tool_result' && b.isError))
        return textResponse(
          '本次工具没有成功执行（可能被拒绝或取消）。我已保留结果，不会自动重试。',
        );
      const previous = history.at(-2);
      if (
        previous?.role === 'assistant' &&
        previous.content.some((b) => b.type === 'tool_use' && b.name === 'read_file')
      )
        return toolUseResponse(
          [
            {
              id: 'demo-write-' + request.messages.length,
              name: 'write_file',
              input: {
                path: 'demo-note.txt',
                content: 'agentlab 离线演示。此文件由真实 ToolExecutor 在批准后创建。\n',
              },
            },
          ],
          '读取完成。接下来需要你批准本次文件写入。',
        );
      return textResponse(
        '演示完成：读取、人工审批、写入与会话保存都走真实 runtime。可以在右侧文件列表检查 demo-note.txt，或新建会话再试。',
      );
    },
  ]);
  return definePlugin({
    manifest: { id: 'agentlab.desktop-demo-provider', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.provider('fake', provider);
    },
  });
}
