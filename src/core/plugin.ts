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
  /** 可返回异步清理函数；按注册的逆序释放资源。 */
  register(ctx: PluginContext): void | PluginDisposer | Promise<void | PluginDisposer>;
}

export type PluginDisposer = () => void | Promise<void>;

export async function loadPlugins(plugins: Plugin[], ctx: PluginContext): Promise<() => Promise<void>> {
  const disposers: PluginDisposer[] = [];
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    const errors: unknown[] = [];
    for (const cleanup of disposers.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Plugin cleanup failed');
  })();
  try {
    for (const plugin of plugins) {
      const cleanup = await plugin.register(ctx);
      if (cleanup) disposers.push(cleanup);
    }
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Plugin initialization and cleanup failed'); }
    throw error;
  }
  return dispose;
}
