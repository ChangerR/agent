/** 历史显式 debug API 仍记录完整正文；新版默认 preset 使用脱敏 telemetry。 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventBus } from '../core/events.js';
import { createJsonlTelemetry } from '../builtin/telemetry-jsonl/index.js';
export function attachDisposableDebugLogger(events: EventBus, path: string, options: { includeBodies?: boolean } = {}): { path: string; dispose(): void } {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '');
  const telemetry = createJsonlTelemetry({ path, includeBodies: options.includeBodies ?? true });
  const off = events.onAll((event) => {
    const safe = event.type === 'permission_request' ? { type: event.type, request: event.request }
      : event.type === 'session_restored' ? { ...event, messages: [], messageCount: event.messages.length } : event;
    try { void telemetry.onEvent(safe); } catch { /* 旧 debug API 的失败不阻断调用者。 */ }
  });
  let disposed = false;
  return { path, dispose() { if (disposed) return; disposed = true; off(); void telemetry.dispose?.(); } };
}
export function attachDebugLogger(events: EventBus, path: string): string { return attachDisposableDebugLogger(events, path).path; }
