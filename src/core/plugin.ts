/**
 * 插件 API：一切能力（provider、内置工具、MCP、skill……）都经由这个接口挂载。
 *
 * 内置能力与第三方插件走同一条路 —— core 只提供 PluginContext 上的注册表，
 * 这就是「一切皆为插件」的落点。
 */
import type { AgentConfig } from './config.js';
import type { HookPoint, HookHandler, RegisteredHook } from './hooks.js';
import type { ProviderRegistry, ToolRegistry } from './registry.js';
import type { RegistrationBatch } from './registration.js';
import type { PluginSetupContext } from '../sdk/plugin.js';

export interface PluginContext {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  hooks: {
    register(point: HookPoint, handler: HookHandler): void;
    prepareBatch?(hooks: readonly RegisteredHook[]): RegistrationBatch;
  };
  config: AgentConfig;
  /** 事务适配器提供；旧插件在分配资源后可立即登记，setup 抛错仍清理。 */
  onDispose?: PluginSetupContext['onDispose'];
  withResource?: PluginSetupContext['withResource'];
}

export interface Plugin {
  name: string;
  /** 可返回异步清理函数；按注册的逆序释放资源。 */
  register(ctx: PluginContext): void | PluginDisposer | Promise<void | PluginDisposer>;
}

export type PluginDisposer = () => void | Promise<void>;

/** @deprecated 新代码使用 PluginHost；旧入口也使用同一事务宿主。 */
export { loadPlugins } from '../compat/legacy-loader.js';
