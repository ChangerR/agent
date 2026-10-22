import { dirname, resolve } from 'node:path';
import { definePlugin } from '../sdk/index.js';
import { McpClientManager } from '../mcp/plugin.js';
import { loadMcpConfig } from '../mcp/config.js';
import { McpResultConfig } from '../mcp/results.js';
export function builtinMcpPlugin(configPath: string, cwd?: string) {
  return definePlugin({
    manifest: { id: 'agentlab.mcp', version: '1.0.0', apiVersion: 1 },
    config: {
      schema: McpResultConfig,
      ownedFields: [
        'maxInlineChars',
        'maxAgeDays',
        'maxStoredBytes',
        'deduplicate',
        'maxSearchChars',
      ],
      defaults: {},
      applyMode: 'newSession',
    },
    async setup(ctx) {
      const manager = new McpClientManager(McpResultConfig.parse(ctx.config.value));
      ctx.onDispose(() => manager.closeAll());
      if (cwd) await manager.maintain(cwd);
      const states: Record<string, string> = {};
      for (const [name, config] of Object.entries(loadMcpConfig(configPath).mcpServers)) {
        let client: Awaited<ReturnType<McpClientManager['connect']>> | undefined;
        try {
          client = await manager.connect(name, config, { cwd: dirname(resolve(configPath)) });
          const tools = await manager.bridgeTools(name, client);
          // 注册冲突不是连接失败，必须令宿主回滚而非隐藏半个服务。
          states[name] = 'available';
          for (const tool of tools) ctx.provide.tool(tool.name, tool);
        } catch (error) {
          if (states[name] === 'available') throw error;
          states[name] = 'unavailable';
          if (client) await manager.disconnect(client);
          console.error(
            `[mcp] server "${name}" unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // 本地结果恢复不依赖远端 server 当前是否在线。
      if (manager.serverNames().length > 0 || (cwd && (await manager.hasResults(cwd)))) {
        ctx.provide.tool('mcp_read_result', manager.resultReader());
        ctx.provide.tool('mcp_search_result', manager.resultSearcher());
      }
      ctx.provide.settings('mcp', {
        title: 'MCP 服务',
        description: `配置文件: ${resolve(configPath)}；stdio 工作目录为该文件所在目录，修改在重启后生效。`,
        schema: { type: 'object' },
        applyMode: 'newSession',
        read: () => ({ ...states, resultStorage: manager.resultStatus() }),
      });
    },
  });
}
