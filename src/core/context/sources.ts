/** 按注册顺序收集来源。保留出处和稳定性，调用方只将 text 合成为模型提示。 */
import { z } from 'zod';
import type { ContextInput, ContextSegment, ContextSource } from '../../sdk/runtime-capabilities.js';
const SegmentSchema = z.object({ id: z.string().min(1), source: z.string().min(1), stability: z.enum(['stable', 'session', 'turn']), text: z.string() });
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
export async function collectContext(sources: readonly ContextSource[], input: ContextInput, signal: AbortSignal): Promise<readonly ContextSegment[]> {
  const sections: ContextSegment[] = [];
  const snapshot = deepFreeze({ cwd: input.cwd, tools: input.tools.map(({ name, description, risk, inputSchema }) => ({ name, description, risk, inputSchema: structuredClone(inputSchema) })), skills: input.skills.map(({ name, description }) => ({ name, description })) });
  for (const source of sources) {
    signal.throwIfAborted();
    const result = await source.getContext(snapshot, signal);
    signal.throwIfAborted();
    const parsed = z.array(SegmentSchema).parse(result);
    sections.push(...parsed.map((segment) => Object.freeze(segment)));
  }
  return Object.freeze(sections);
}
export function contextText(segments: readonly ContextSegment[]): string { return segments.map((segment) => segment.text).filter(Boolean).join('\n\n'); }
