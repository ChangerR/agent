/**
 * 插件 API：一切能力（provider、内置工具、MCP、skill……）都经由这个接口挂载。
 *
 * 内置能力与第三方插件走同一条路 —— core 只提供 PluginContext 上的注册表，
 * 这就是「一切皆为插件」的落点。
 */
import type { AgentConfig } from './config.js';
import type { HookPoint, HookHandler } from './hooks.js';
import type { ProviderRegistry, ToolRegistry } from './registry.js';

export interface PluginContext {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  hooks: {
    register(point: HookPoint, handler: HookHandler): void;
  };
  config: AgentConfig;
}

export interface Plugin {
  name: string;
  register(ctx: PluginContext): void | Promise<void>;
}

export async function loadPlugins(plugins: Plugin[], ctx: PluginContext): Promise<void> {
  for (const plugin of plugins) {
    await plugin.register(ctx);
  }
}
