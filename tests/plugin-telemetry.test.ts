import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonlTelemetry } from '../src/builtin/telemetry-jsonl/index.js';
import { attachDisposableDebugLogger } from '../src/core/debug-log.js';
import { EventBus } from '../src/core/events.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true }))); });
async function path() { const dir = await fs.mkdtemp(join(tmpdir(), 'agent-plugin-telemetry-')); dirs.push(dir); return join(dir, 'log.jsonl'); }
describe('telemetry-jsonl 脱敏与注销', () => {
  it('默认不记录模型正文、工具参数、审批原因和错误内容', async () => {
    const target = await path(); const telemetry = createJsonlTelemetry({ path: target });
    telemetry.onEvent({ type: 'model_request', requestId: 'request', purpose: 'agent', provider: 'fake', request: { model: 'fake', system: 'SECRET_SYSTEM', messages: [{ role: 'user', content: 'SECRET_USER' }], tools: [] } });
    telemetry.onEvent({ type: 'tool_call', toolUse: { type: 'tool_use', id: 'tool', name: 'bash', input: { command: 'SECRET_COMMAND' } } });
    telemetry.onEvent({ type: 'permission_decision', toolUseId: 'tool', toolName: 'bash', input: { token: 'SECRET_TOKEN' }, phase: 'pipeline', decision: { kind: 'ask', source: 'mode', reason: 'SECRET_REASON' } });
    telemetry.onEvent({ type: 'error', error: new Error('SECRET_ERROR') });
    const saved = await fs.readFile(target, 'utf8');
    expect(saved).not.toContain('SECRET');
    expect(saved).toContain('request'); expect(saved).toContain('bash');
    await telemetry.dispose?.();
    telemetry.onEvent({ type: 'notice', text: 'after disposal' });
    expect(await fs.readFile(target, 'utf8')).toBe(saved);
  });
  it('完整正文只在显式选项开启，兼容订阅可注销两次', async () => {
    const target = await path(); const events = new EventBus();
    const subscription = attachDisposableDebugLogger(events, target, { includeBodies: true });
    events.emit({ type: 'notice', text: 'explicit body' });
    const saved = await fs.readFile(target, 'utf8'); expect(saved).toContain('explicit body');
    subscription.dispose(); subscription.dispose(); events.emit({ type: 'notice', text: 'later' });
    expect(await fs.readFile(target, 'utf8')).toBe(saved);
  });
});
