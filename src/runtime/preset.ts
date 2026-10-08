import type { AgentConfig } from '../core/config.js';
import type { Provider } from '../core/provider.js';
import type { CapabilitySelections, Plugin } from '../sdk/index.js';
import type { BuiltinCommandServices } from '../builtin/commands.js';
export interface PresetContext { cwd: string; config: AgentConfig; logPath: string; provider(): Provider; services: BuiltinCommandServices; modelInfo(model: string): { contextWindow: number; maxOutputTokens: number } | undefined }
export interface Preset { plugins: Plugin[]; selections: CapabilitySelections }
