import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
/**
 * MCP 桥接端到端测试：用 examples/mcp-server.ts 起一个真实 stdio MCP server，
 * 验证 connect → listTools → 桥接 → callTool 全链路。
 */
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { PermissionEngine } from '../src/core/permission/engine.js';
import { McpClientManager } from '../src/mcp/plugin.js';

const serverEntry = join(__dirname, '..', 'examples', 'mcp-server.ts');

describe('MCP 桥接', () => {
  it('授权身份包含完整参数，记忆规则只匹配同一目标', async () => {
    const client = { listTools: async () => ({ tools: [{ name: 'write', inputSchema: {} }] }) } as unknown as Client;
    const [tool] = await new McpClientManager().bridgeTools('test', client);
    const first = { padding: 'x'.repeat(250), path: 'src/[a]*.ts' };
    const second = { ...first, path: '/outside/secret' };
    const target = tool.analyzeInput!(first).patternTarget;
    expect(target).toContain(first.path);
    expect(target).not.toBe(tool.analyzeInput!(second).patternTarget);
    expect(target).toBe(tool.analyzeInput!({ path: first.path, padding: first.padding }).patternTarget);
    const permission = new PermissionEngine({ mode: 'ask', rules: { allow: [], ask: [], deny: [] } });
    permission.addSessionRule('allow', `${tool.name}(=${JSON.stringify(target)})`);
    expect(permission.check(tool, first).kind).toBe('allow');
    expect(permission.check(tool, second).kind).toBe('ask');
    expect(permission.check(tool, { ...first, path: 'src/a123.ts' }).kind).toBe('ask');
  });
  it('工具调用传递轮次取消信号，已取消的调用不发往服务端', async () => {
    const controller = new AbortController();
    const callTool = vi.fn((_params, _schema, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const client = { listTools: async () => ({ tools: [{ name: 'slow', inputSchema: { type: 'object' } }] }), callTool } as unknown as Client;
    const [tool] = await new McpClientManager().bridgeTools('test', client);
    const pending = tool.execute({}, { cwd: process.cwd(), signal: controller.signal });
    expect(callTool.mock.calls[0][2].signal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(tool.execute({}, { cwd: process.cwd(), signal: controller.signal })).rejects.toThrow();
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it('连接 stdio server 并调用工具', { timeout: 60_000 }, async () => {
    const manager = new McpClientManager();
    try {
      const client = await manager.connect('demo', {
        // 使用已安装的 loader，不依赖 npx 下载/包装或 tsx CLI 的额外 IPC socket。
        command: process.execPath,
        args: ['--import', 'tsx', serverEntry],
      });
      const tools = await manager.bridgeTools('demo', client);

      // 工具以 mcp__<server>__<tool> 命名
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['mcp__demo__add', 'mcp__demo__echo']);

      const add = tools.find((t) => t.name === 'mcp__demo__add')!;
      const result = await add.execute({ a: 2, b: 40 }, { cwd: process.cwd(), signal: new AbortController().signal });
      expect(result.content).toBe('42');
    } finally {
      await manager.closeAll();
      expect(manager.serverNames()).toEqual([]);
      await manager.closeAll();
    }
  });
});

it('MCP stdio 相对脚本按显式配置目录启动，不依赖父进程 cwd', { timeout: 60_000 }, async () => {
  const manager = new McpClientManager();
  try {
    const client = await manager.connect('relative', {
      command: process.execPath,
      args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, './mcp-server.ts'],
    }, { cwd: dirname(serverEntry) });
    const names = (await manager.bridgeTools('relative', client)).map(tool => tool.name);
    expect(names).toContain('mcp__relative__add');
  } finally { await manager.closeAll(); }
});
