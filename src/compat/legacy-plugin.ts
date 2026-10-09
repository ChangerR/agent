/** 旧 register(ctx) 的事务包装：注册表和钩子都只能写入宿主暂存区。 */
import type { AgentConfig } from '../core/config.js';
import type { Plugin as LegacyPlugin, PluginContext } from '../core/plugin.js';
import type { Provider } from '../core/provider.js';
import { ProviderRegistry, ToolRegistry, type Tool } from '../core/registry.js';
import { definePlugin, type Plugin, type PluginManifest, type PluginSetupContext } from '../sdk/plugin.js';

export interface LegacyPluginOptions {
  id?: string;
  version?: string;
  requires?: Record<string, string>;
  optional?: Record<string, string>;
  config?: AgentConfig;
}

export function adaptLegacyPlugin(plugin: LegacyPlugin, options: LegacyPluginOptions = {}): Plugin {
  const manifest: PluginManifest = {
    id: options.id ?? plugin.name,
    version: options.version ?? '1.0.0',
    apiVersion: 1,
    ...(options.requires ? { requires: options.requires } : {}),
    ...(options.optional ? { optional: options.optional } : {}),
  };
  return definePlugin({
    manifest,
    async setup(context) {
      const dependencies = [...Object.keys(manifest.requires ?? {}), ...Object.keys(manifest.optional ?? {})]
        .map((id) => context.dependencies.optional(id)).filter((handle) => handle !== undefined);
      class TransactionalProviders extends ProviderRegistry {
        private staged = new Map<string, Provider>();
        override register(provider: Provider): void {
          if (this.staged.has(provider.name)) throw new Error(`Duplicate legacy provider: ${provider.name}`);
          context.provide.provider(provider.name, provider);
          this.staged.set(provider.name, provider);
        }
        override get(name: string): Provider {
          const found = this.list().find((provider) => provider.name === name);
          if (!found) throw new Error(`Provider not found: ${name}`);
          return found;
        }
        override list(): Provider[] { return [...dependencies.flatMap((dependency) => dependency.list('provider').map((record) => record.implementation)), ...this.staged.values()]; }
      }
      class TransactionalTools extends ToolRegistry {
        private staged = new Map<string, Tool>();
        override register(tool: Tool): void {
          if (this.staged.has(tool.name)) throw new Error(`Duplicate legacy tool: ${tool.name}`);
          context.provide.tool(tool.name, tool);
          this.staged.set(tool.name, tool);
        }
        override get(name: string): Tool | undefined {
          const own = this.staged.get(name); if (own) return own;
          const record = dependencies.flatMap(dependency => dependency.list('tool')).find(record => record.capabilityId === name || record.aliases.includes(name));
          return record ? { ...record.implementation, execute: async () => { throw new Error('Dependent tools must be invoked through runtime.invokeTool'); } } : undefined;
        }
        override list(): Tool[] { return [...dependencies.flatMap((dependency) => dependency.list('tool').map((record) => ({ ...record.implementation, execute: async () => { throw new Error('Dependent tools must be invoked through runtime.invokeTool'); } }))), ...this.staged.values()]; }
      }
      const legacyContext: PluginContext & Pick<PluginSetupContext, 'onDispose' | 'withResource'> = {
        providers: new TransactionalProviders(),
        tools: new TransactionalTools(),
        hooks: context.hooks,
        config: structuredClone(options.config ?? context.config.core) as AgentConfig,
        onDispose: context.onDispose,
        withResource: context.withResource,
      };
      const dispose = await plugin.register(legacyContext);
      if (dispose) context.onDispose(dispose);
    },
  });
}
export const legacyPlugin = adaptLegacyPlugin;
