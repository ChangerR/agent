/**
 * MCP 桥接端到端测试：用 examples/mcp-server.ts 起一个真实 stdio MCP server，
 * 验证 connect → listTools → 桥接 → callTool 全链路。
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpClientManager } from '../src/mcp/plugin.js';

const serverEntry = join(__dirname, '..', 'examples', 'mcp-server.ts');

describe('MCP 桥接', () => {
  it('连接 stdio server 并调用工具', { timeout: 60_000 }, async () => {
    const manager = new McpClientManager();
    try {
      const client = await manager.connect('demo', {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['tsx', serverEntry],
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
    }
  });
});
