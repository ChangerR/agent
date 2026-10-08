/** 可选终端 entry 契约；SDK 只存 entry 描述，headless 不加载此文件。 */
import type { Agent } from '../runtime/agent.js';
import type { CommandInspection } from '../sdk/index.js';
import type { PanelItem } from './interaction-panel.js';
import type { PermissionSettingsPicker } from '../builtin/policy-legacy/tui.js';
import type { SettingsInputRequest } from './settings-input.js';
import type { ToolResult, TokenUsage } from '../core/protocol/types.js';
export interface TuiPluginContext {
  readonly cwd: string;
  inspect(): CommandInspection;
  dispatchCommand: Agent['dispatchCommand'];
  invokeTool: Agent['invokeTool'];
  say(text: string): void;
  error(text: string): void;
  showPicker(title: string, items: PanelItem[], onPick: (value: string) => void, initialValue?: string, filterable?: boolean, onCancel?: () => void, framed?: boolean): void;
  showPermissionPicker(request: PermissionSettingsPicker): void;
  showDetails(title: string, body: () => string, onBack?: () => void, framed?: boolean): void;
  showInput(request: SettingsInputRequest): void;
  updateStatus(): void;
  exit(): void;
  redraw(): void;
  toggleDetails(): void;
  detail(id: number): { id: number; title: string; body: () => string } | undefined;
  usage(): TokenUsage;
  queue: { size(): number; clear(): number };
}
export interface BuiltinTuiContext extends TuiPluginContext { agent: Agent }
export type TuiCommandHandler = (args: string, onBack?: () => void) => void | Promise<void>;
export interface TuiToolRenderInput { readonly name: string; readonly input: unknown; readonly result?: Readonly<ToolResult> }
export type TuiToolRenderer = (input: TuiToolRenderInput, width: number) => readonly string[];
export interface TuiAdapter {
  toolRenderers?: Record<string, TuiToolRenderer>;
  statusItems?: Record<string, () => string>;
  commands?: Record<string, TuiCommandHandler>;
  settings?: Record<string, (onBack?: () => void) => void>;
  dispose?(): void | Promise<void>;
}
export interface TuiEntry { createTuiAdapter(context: TuiPluginContext): TuiAdapter | Promise<TuiAdapter> }
