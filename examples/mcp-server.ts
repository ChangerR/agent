/**
 * 示例 MCP server（用于验证 MCP 桥接，无需外部依赖）。
 *
 * 用法：mcp.json
 *   { "mcpServers": { "demo": { "command": "npx", "args": ["tsx", "examples/mcp-server.ts"] } } }
 *
 * 提供两个工具：add（加法）与 echo（回显）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'demo', version: '0.1.0' });

server.tool('add', 'Add two numbers', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}));

server.tool('echo', 'Echo the input', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));

await server.connect(new StdioServerTransport());
