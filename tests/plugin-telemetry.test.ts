import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJsonlTelemetry } from '../src/builtin/telemetry-jsonl/index.js';
import { EventBus } from '../src/core/events.js';
import { PlanningError } from '../src/builtin/planning/errors.js';
import { observationSnapshot } from '../src/runtime/plugin-host.js';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});
async function path() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'agent-plugin-telemetry-'));
  dirs.push(dir);
  return join(dir, 'log.jsonl');
}
describe('telemetry-jsonl 脱敏与注销', () => {
  it('记录固定规划原因码，不记录原始错误正文或任意 SDK code', async () => {
    const target = await path();
    const telemetry = createJsonlTelemetry({ path: target });
    const error = new PlanningError('planning_invalid_response');
    error.message = 'SECRET_MODEL_RESPONSE';
    telemetry.onEvent(observationSnapshot({ type: 'error', error }));
    telemetry.onEvent(
      observationSnapshot({
        type: 'error',
        error: Object.assign(new Error('SECRET_SDK_ERROR'), { code: 'SECRET_KEY' }),
      }),
    );
    telemetry.onEvent(
      observationSnapshot({
        type: 'error',
        error: Object.assign(new Error('SECRET_SPOOF'), {
          name: 'PlanningError',
          code: 'SECRET_KEY',
        }),
      }),
    );
    const saved = await fs.readFile(target, 'utf8');
    expect(saved).not.toContain('SECRET');
    const events = saved
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      type: 'error',
      errorName: 'PlanningError',
      errorCode: 'planning_invalid_response',
    });
    expect(events[1]).not.toHaveProperty('errorCode');
    expect(events[2]).not.toHaveProperty('errorCode');
  });
  it('默认不记录模型正文、工具参数、审批原因和错误内容', async () => {
    const target = await path();
    const telemetry = createJsonlTelemetry({ path: target });
    telemetry.onEvent({
      type: 'model_request',
      requestId: 'request',
      purpose: 'agent',
      provider: 'fake',
      request: {
        model: 'fake',
        system: 'SECRET_SYSTEM',
        messages: [{ role: 'user', content: 'SECRET_USER' }],
        tools: [],
      },
    });
    telemetry.onEvent({
      type: 'tool_call',
      toolUse: { type: 'tool_use', id: 'tool', name: 'bash', input: { command: 'SECRET_COMMAND' } },
    });
    telemetry.onEvent({
      type: 'permission_decision',
      toolUseId: 'tool',
      toolName: 'bash',
      input: { token: 'SECRET_TOKEN' },
      phase: 'pipeline',
      denialScope: 'invocation',
      decision: {
        kind: 'deny',
        source: 'builtin',
        reasonCode: 'task_read_only',
        reason: 'SECRET_REASON',
      },
    });
    telemetry.onEvent({ type: 'error', error: new Error('SECRET_ERROR') });
    const saved = await fs.readFile(target, 'utf8');
    expect(saved).not.toContain('SECRET');
    expect(saved).toContain('request');
    expect(saved).toContain('bash');
    expect(saved).toContain('"denialScope":"invocation"');
    expect(saved).toContain('"reasonCode":"task_read_only"');
    await telemetry.dispose?.();
    telemetry.onEvent({ type: 'notice', text: 'after disposal' });
    expect(await fs.readFile(target, 'utf8')).toBe(saved);
  });
  it('完整正文只在显式选项开启，订阅可注销两次', async () => {
    const target = await path();
    const events = new EventBus();
    const telemetry = createJsonlTelemetry({ path: target, includeBodies: true });
    const off = events.onAll((event) => telemetry.onEvent(event as never));
    const subscription = {
      dispose() {
        off();
        void telemetry.dispose?.();
      },
    };
    events.emit({ type: 'notice', text: 'explicit body' });
    const saved = await fs.readFile(target, 'utf8');
    expect(saved).toContain('explicit body');
    subscription.dispose();
    subscription.dispose();
    events.emit({ type: 'notice', text: 'later' });
    expect(await fs.readFile(target, 'utf8')).toBe(saved);
  });
});
