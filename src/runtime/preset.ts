import type { AgentConfig, ConfigSources } from '../core/config.js';
import type { AgentPaths } from '../core/paths.js';
import type { Provider } from '../core/provider.js';
import type { CapabilitySelections, Plugin } from '../sdk/index.js';
import type { BuiltinCommandServices } from '../builtin/commands.js';
export interface PresetContext { cwd: string; paths: AgentPaths; configSources: ConfigSources; config: AgentConfig; logPath: string; provider(name?: string): Provider; services: BuiltinCommandServices; capabilityChoices(): Record<string, { selected: string | false; available: readonly string[] }>; modelInfo(model: string): { contextWindow: number; maxOutputTokens: number } | undefined }
export interface Preset { plugins: Plugin[]; selections: CapabilitySelections }
