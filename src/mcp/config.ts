/**
 * MCP 配置加载：mcp.json
 *
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "remote":     { "url": "https://example.com/mcp" }
 *   }
 * }
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const StdioServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
});

const HttpServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const McpConfigSchema = z.object({
  mcpServers: z.record(z.union([StdioServerSchema, HttpServerSchema])).default({}),
});

export type McpServerConfig = z.infer<typeof McpConfigSchema>['mcpServers'][string];
export type McpConfig = z.infer<typeof McpConfigSchema>;

export function loadMcpConfig(path: string): McpConfig {
  if (!existsSync(path)) return { mcpServers: {} };
  return McpConfigSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
}
