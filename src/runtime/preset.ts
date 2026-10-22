import type { AgentConfig, ConfigSources } from '../core/config.js';
import type { AgentPaths } from '../core/paths.js';
import type { Provider } from '../core/provider.js';
import type { CapabilitySelections, Plugin } from '../sdk/index.js';
import type { RuntimeServices } from './services.js';
export interface PresetContext {
  cwd: string;
  paths: AgentPaths;
  configSources: ConfigSources;
  config: AgentConfig;
  logPath: string;
  provider(name?: string): Provider;
  services: RuntimeServices;
  capabilityChoices(): Record<string, { selected: string | false; available: readonly string[] }>;
  modelInfo(model: string): { contextWindow: number; maxOutputTokens: number } | undefined;
  /** 实际待装配的插件定义；包含外部插件，供宿主 schema 设置入口使用。 */
  pluginDefinitions?(): readonly Plugin[];
}
export interface Preset {
  controlTools?: readonly {
    ownerPlugin: string;
    name: string;
    allowedAfterDenial?: boolean;
    /** 由父任务管理的规划与委派控制，不向 child 暴露或允许执行。 */
    rootOnly?: boolean;
  }[];
  plugins: Plugin[];
  selections: CapabilitySelections;
}
