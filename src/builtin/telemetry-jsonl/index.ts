/** 可注销的 JSONL sink。默认只写明确列出的元数据，正文需显式开启。 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { z } from 'zod';
import { dirname } from 'node:path';
import { definePlugin } from '../../sdk/index.js';
import type { Telemetry, TelemetryEvent } from '../../sdk/runtime-capabilities.js';

export interface JsonlTelemetryOptions { path: string; includeBodies?: boolean; onError?: (error: unknown) => void }
export function redactedEvent(event: Readonly<TelemetryEvent>): Record<string, unknown> {
  switch (event.type) {
    case 'model_request': return { type: event.type, requestId: event.requestId, runId: event.runId, toolCallId: event.toolCallId, toolRequestId: event.toolRequestId, purpose: event.purpose, provider: event.provider, model: event.request.model, messageCount: event.request.messages.length, toolCount: event.request.tools.length };
    case 'model_usage': return { type: event.type, requestId: event.requestId, runId: event.runId, toolCallId: event.toolCallId, toolRequestId: event.toolRequestId, purpose: event.purpose, usage: event.usage };
    case 'text_delta': case 'thinking_delta': case 'notice': return { type: event.type, characters: event.text.length };
    case 'assistant_message': return { type: event.type, blockCount: event.message.content.length };
    case 'tool_call': return { type: event.type, toolUseId: event.toolUse.id, toolName: event.toolUse.name };
    case 'tool_execution': return { type: event.type, runId: event.runId, toolCallId: event.toolCallId, requestId: event.requestId, sessionId: event.sessionId, toolName: event.toolName, toolVersion: event.toolVersion, phase: event.phase, policyId: event.policyId, policyVersion: event.policyVersion, configRevision: event.configRevision, policyRevision: event.policyRevision, inputHash: event.inputHash, durationMs: event.durationMs, decision: event.decision, reasonCode: event.reasonCode };
    case 'tool_result': return { type: event.type, toolUseId: event.toolUseId, toolName: event.name, isError: event.result.isError === true };
    case 'permission_decision': return { type: event.type, runId: event.runId, requestId: event.requestId, toolUseId: event.toolUseId, toolName: event.toolName, phase: event.phase, decision: { kind: event.decision.kind, source: event.decision.source, reasonCode: event.decision.reasonCode, judge: event.decision.judge } };
    case 'permission_request': return { type: event.type, runId: event.request.runId, requestId: event.request.requestId, toolRequestId: event.request.toolRequestId, toolUseId: event.request.toolUseId, toolName: event.request.toolName, decisionSource: event.request.decisionSource };
    case 'turn_end': return { type: event.type, stopReason: event.stopReason, usage: event.usage };
    case 'loop_end': return { type: event.type, reason: event.reason, turns: event.turns, usage: event.usage };
    case 'compacted': return { type: event.type, beforeMessages: event.beforeMessages, afterMessages: event.afterMessages };
    case 'error': return { type: event.type, errorName: event.error.name };
    case 'session_saved': return { type: event.type, id: event.id, trimmed: event.trimmed };
    case 'session_restored': return { type: event.type, id: event.id, model: event.model, messageCount: event.messages.length };
  }
}
export function createJsonlTelemetry(options: JsonlTelemetryOptions): Telemetry {
  let active = true;
  // 文件只在第一次事件发生时创建；setup 回滚不留下空日志文件。
  let initialized = false;
  return {
    onEvent(event) {
      if (!active) return;
      try {
        if (!initialized) { mkdirSync(dirname(options.path), { recursive: true }); initialized = true; }
        const value = options.includeBodies ? event : redactedEvent(event);
        appendFileSync(options.path, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`);
      } catch (error) { if (options.onError) options.onError(error); else throw error; }
    },
    dispose() { active = false; },
  };
}
export function createTelemetryJsonlPlugin(options: JsonlTelemetryOptions) {
  return definePlugin({
    manifest: { id: 'agentlab.telemetry-jsonl', version: '1.0.0', apiVersion: 1, configVersion: 1 },
    config: { schema: z.object({ includeBodies: z.boolean().default(false) }).passthrough(), ownedFields: ['includeBodies'], defaults: { includeBodies: options.includeBodies ?? false }, applyMode: 'new-session' },
    setup(ctx) {
      const telemetry = createJsonlTelemetry({ ...options, includeBodies: ctx.config.value.includeBodies === true });
      ctx.onDispose(() => telemetry.dispose?.());
      ctx.provide.telemetry('jsonl', telemetry);
    },
  });
}
