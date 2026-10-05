/**
 * 调试日志：把 EventBus 上的所有事件落盘为 JSONL。
 *
 * 每个会话一个文件：<cwd>/.agentlab/logs/session-<时间戳>.jsonl
 * 排查"agent 为什么没反应"时，先看这个文件 —— 模型到底回了什么、
 * 工具执行结果、权限决策、loop 结束原因，全在里面。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent, EventBus } from './events.js';

const EVENT_TYPES: AgentEvent['type'][] = [
  'model_request',
  'model_usage',
  'text_delta',
  'thinking_delta',
  'assistant_message',
  'tool_call',
  'tool_result',
  'permission_request',
  'turn_end',
  'notice',
  'loop_end',
  'compacted',
  'error',
  'session_saved',
  'session_restored',
];

export function attachDebugLogger(events: EventBus, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, '');

  const write = (event: AgentEvent) => {
    // permission_request 带 resolve 函数，不能直接序列化
    const safe = event.type === 'permission_request'
      ? { type: event.type, request: event.request }
      : event.type === 'session_restored'
        ? { type: event.type, id: event.id, title: event.title, messageCount: event.messages.length }
        : event;
    try {
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...safe })}\n`);
    } catch {
      // 日志失败不阻断主流程
    }
  };

  for (const type of EVENT_TYPES) {
    events.on(type, write as (e: AgentEvent) => void);
  }
  return path;
}
