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
        private open = true;
        private assertOpen(): void { if (!this.open) throw new Error('Legacy tool registration is closed'); }
        override register(tool: Tool): void {
          this.assertOpen();
          if (this.get(tool.name)) throw new Error(`Duplicate legacy tool: ${tool.name}`);
          // 本地注册表同时暂存工具和别名，不能在 alias 声明之前提交宿主记录。
          super.register(tool);
        }
        override alias(name: string, target: string): void {
          this.assertOpen();
          if (this.get(name)) throw new Error(`Invalid or conflicting tool alias: ${name}`);
          // 依赖工具仅可读，不能通过别名把它重新归属到当前插件。
          super.alias(name, target);
        }
        override get(name: string): Tool | undefined {
          const own = super.get(name); if (own) return own;
          const record = dependencies.flatMap(dependency => dependency.list('tool')).find(record => record.capabilityId === name || record.aliases.includes(name));
          return record ? { ...record.implementation, execute: async () => { throw new Error('Dependent tools must be invoked through runtime.invokeTool'); } } : undefined;
        }
        override list(): Tool[] { return [...dependencies.flatMap((dependency) => dependency.list('tool').map((record) => ({ ...record.implementation, execute: async () => { throw new Error('Dependent tools must be invoked through runtime.invokeTool'); } }))), ...super.list()]; }
        override aliasesFor(name: string): readonly string[] {
          return Object.freeze([...super.aliasesFor(name), ...dependencies.flatMap(dependency => dependency.list('tool')).filter(record => record.capabilityId === name).flatMap(record => record.aliases)]);
        }
        flush(): void {
          this.assertOpen();
          for (const tool of super.list()) context.provide.tool(tool.name, tool, { aliases: super.aliasesFor(tool.name) });
        }
        close(): void { this.open = false; super.freeze(); }
      }
      const tools = new TransactionalTools();
      const legacyContext: PluginContext & Pick<PluginSetupContext, 'onDispose' | 'withResource'> = {
        providers: new TransactionalProviders(),
        tools,
        hooks: context.hooks,
        config: structuredClone(options.config ?? context.config.core) as AgentConfig,
        onDispose: context.onDispose,
        withResource: context.withResource,
      };
      try {
        const dispose = await plugin.register(legacyContext);
        // flush 的验证也可能失败，返回的资源清理必须先加入宿主回滚事务。
        if (dispose) context.onDispose(dispose);
        tools.flush();
      } finally { tools.close(); }
    },
  });
}
export const legacyPlugin = adaptLegacyPlugin;
