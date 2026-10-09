/** 终端、脚本与外部插件共享同一命令目录和调用协议。 */
import { jsonInput } from '../core/permission/input-validation.js';
import type { CapabilityRecord, Command, CommandContext, CommandResult, InteractionRequest, SettingsSection } from '../sdk/index.js';
export class CommandRegistry {
  private entries = new Map<string, { id: string; command: Command }>();
  constructor(records: readonly CapabilityRecord<'command'>[]) {
    for (const record of records) {
      const command = record.implementation;
      for (const name of new Set([record.capabilityId, ...record.aliases, ...(command.aliases ?? [])])) {
        if (this.entries.has(name)) throw new Error(`Command alias conflict: ${name}`);
        this.entries.set(name, { id: record.capabilityId, command });
      }
    }
  }
  list(): Array<{ id: string; description: string }> {
    return [...this.entries].filter(([id, value]) => id === value.id).map(([id, value]) => ({ id, description: value.command.description }));
  }
  has(name: string): boolean { return this.entries.has(name); }
  async dispatch(line: string, context: CommandContext): Promise<CommandResult> {
    context.signal.throwIfAborted();
    const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(line.replace(/^\//, '').trim());
    const name = match?.[1] ?? '';
    const args = match?.[2] ?? '';
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`未知命令: /${name}，输入 /help 查看帮助`);
    let input: Record<string, unknown> = { args };
    // JSON 参数支持插件的结构化脚本调用；普通参数保留原文。
    if (args.startsWith('{')) { const value: unknown = JSON.parse(args); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('命令参数必须是 JSON 对象'); input = value as Record<string, unknown>; }
    input = jsonInput(input, entry.command.inputSchema ?? { type: 'object' });
    const result = await entry.command.handler(Object.freeze(input), context);
    context.signal.throwIfAborted();
    if (result !== undefined && (!result || !['text', 'data', 'interaction'].includes(result.type))) throw new Error(`Invalid command result: ${name}`);
    if (result?.type === 'text' && typeof result.text !== 'string') throw new Error(`Invalid command text: ${name}`);
    return result;
  }
}
export interface SettingsRecord { id: string; ownerPlugin: string; section: SettingsSection; sources?: Readonly<Record<string, string>>; implementations?: readonly string[] }
export function settingsRecords(records: readonly CapabilityRecord<'settings'>[]): SettingsRecord[] {
  return records.map(r => ({ id: r.capabilityId, ownerPlugin: r.ownerPlugin, section: r.implementation }));
}
export async function choose(request: InteractionRequest, context: CommandContext): Promise<string | undefined | InteractionRequest> {
  return context.interact ? context.interact(request) : request;
}
