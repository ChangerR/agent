/**
 * MCP Client 管理器 + 工具桥接。
 *
 * 每个 MCP server 的工具以 `mcp__<server>__<tool>` 命名注册进 ToolRegistry，
 * 与 Claude Code 的命名约定一致 —— 从权限规则的角度它们与普通工具完全同构，
 * 例如 allow 规则 "mcp__filesystem(read_file)" 可以精细控制到 server 级。
 */
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Plugin } from '../core/plugin.js';
import type { Tool } from '../core/registry.js';
import type { McpServerConfig } from './config.js';
import { loadMcpConfig } from './config.js';

interface ConnectedServer {
  name: string;
  client: Client;
  close: () => Promise<void>;
}

export class McpClientManager {
  private servers: ConnectedServer[] = [];
  private closing?: Promise<void>;

  async connect(name: string, config: McpServerConfig, options: { cwd?: string } = {}): Promise<Client> {
    const client = new Client({ name: 'agentlab', version: '0.1.0' });

    if ('command' in config) {
      const transport = new StdioClientTransport({
        command: config.command,
        cwd: options.cwd,
        args: config.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
        stderr: 'pipe',
      });
      try { await client.connect(transport); }
      catch (error) { await transport.close(); throw error; }
      this.servers.push({
        name,
        client,
        close: async () => {
          await client.close();
        },
      });
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
      try { await client.connect(transport); }
      catch (error) { await transport.close(); throw error; }
      this.servers.push({
        name,
        client,
        close: async () => {
          await client.close();
        },
      });
    }
    return client;
  }

  /** 把一个 server 的全部工具桥接为本地 Tool */
  async bridgeTools(serverName: string, client: Client): Promise<Tool[]> {
    const { tools } = await client.listTools();
    return tools.map(
      (t): Tool => ({
        name: `mcp__${serverName}__${t.name}`,
        description: `[MCP:${serverName}] ${t.description ?? t.name}`,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        // MCP 工具风险未知，保守按 write 处理；可通过 allow 规则精细放行
        risk: 'write',
        analyzeInput: (input) => ({
          patternTarget: canonicalInput(input),
          summary: `mcp:${serverName}.${t.name}(${JSON.stringify(input).slice(0, 80)})`,
        }),
        execute: async (input, ctx) => {
          ctx.signal.throwIfAborted();
          const result = await client.callTool({ name: t.name, arguments: input }, undefined, { signal: ctx.signal });
          const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
          const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c))).join('\n');
          return { content: text || '(no content)', isError: Boolean(result.isError) };
        },
      }),
    );
  }

  async disconnect(client: Client): Promise<void> {
    this.servers = this.servers.filter((server) => server.client !== client);
    await client.close();
  }

  closeAll(): Promise<void> {
    if (this.closing) return this.closing;
    const servers = this.servers;
    this.servers = [];
    this.closing = (async () => {
      try {
        const results = await Promise.allSettled(servers.map((s) => s.close()));
        const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
        if (errors.length) throw new AggregateError(errors, 'MCP cleanup failed');
      } finally { this.closing = undefined; }
    })();
    return this.closing;
  }

  serverNames(): string[] {
    return this.servers.map((s) => s.name);
  }
}

/**
 * MCP 插件：读 mcp.json，连接所有 server，把工具挂进注册表。
 * 连接失败的 server 只警告不阻断（MCP 是可选能力）。
 */
export function mcpPlugin(configPath: string): Plugin {
  return {
    name: 'mcp',
    async register(ctx) {
      const config = loadMcpConfig(configPath);
      const manager = new McpClientManager();
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        let client: Client | undefined;
        try {
          client = await manager.connect(name, serverConfig, { cwd: dirname(resolve(configPath)) });
          const tools = await manager.bridgeTools(name, client);
          for (const tool of tools) ctx.tools.register(tool);
        } catch (err) {
          if (client) {
            try { await manager.disconnect(client); }
            catch (cleanupError) { console.error(`[mcp] server "${name}" 清理失败: ${String(cleanupError)}`); }
          }
          console.error(`[mcp] server "${name}" 连接失败: ${err instanceof Error ? err.message : err}`);
        }
      }
      return () => manager.closeAll();
    },
  };
}

/** 授权使用完整、键排序后的 JSON；展示摘要可以截短，授权身份不可截短。 */
function canonicalInput(input: Record<string, unknown>): string {
  return JSON.stringify(input, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
    }
    return value;
  });
}
