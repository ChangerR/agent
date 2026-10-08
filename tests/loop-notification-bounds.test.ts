import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../src/core/loop.js';
import { HookRunner } from '../src/core/hooks.js';
import { EventBus } from '../src/core/events.js';
import { ToolRegistry } from '../src/core/registry.js';
import { ContextManager } from '../src/core/context/manager.js';
import { PermissionEngine } from '../src/builtin/policy-legacy/engine.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';

describe('loop notification boundaries', () => {
  it.each(['UserPromptSubmit', 'TurnEnd'] as const)('%s timeout cannot hang an otherwise successful run', async (point) => {
    const hooks = new HookRunner(); hooks.register(point, () => new Promise(() => {}));
    const loop = new AgentLoop({ hooks, events: new EventBus(), tools: new ToolRegistry(),
      context: new ContextManager({ compactThreshold: 10000 }), provider: new FakeProvider([textResponse('done')]),
      permission: new PermissionEngine({ mode: 'auto', rules: { allow: [], ask: [], deny: [] } }),
      model: 'fake', systemPrompt: '', maxTurns: 2, cwd: process.cwd(), capabilityTimeoutMs: 5 });
    expect((await loop.run('hello')).reason).toBe('completed'); expect(loop.running).toBe(false);
  });

  it('cancel in a stuck post-tool observer returns the successful result once and settles the run', async () => {
    const hooks = new HookRunner(); const tools = new ToolRegistry(); let executions = 0;
    tools.register({ name: 'test', description: 'test', risk: 'read', inputSchema: {}, execute: async () => { executions++; return { content: 'side effect done' }; } });
    const loop = new AgentLoop({ hooks, events: new EventBus(), tools,
      context: new ContextManager({ compactThreshold: 10000 }), provider: new FakeProvider([toolUseResponse([{ id: 't', name: 'test', input: {} }])]),
      permission: new PermissionEngine({ mode: 'auto', rules: { allow: [], ask: [], deny: [] } }),
      model: 'fake', systemPrompt: '', maxTurns: 2, cwd: process.cwd() });
    hooks.register('PostToolUse', () => { loop.abort_current(); return new Promise(() => {}); });
    expect((await loop.run('hello')).reason).toBe('aborted'); expect(loop.running).toBe(false); expect(executions).toBe(1);
    expect(JSON.stringify(loop.getMessages().at(-1))).toContain('side effect done');
  });

  it('uncooperative execution reports bounded shutdown fault without faking completion or retrying', async () => {
    const hooks = new HookRunner(); const tools = new ToolRegistry(); let finish!: (value: { content: string }) => void;
    const execute = vi.fn(() => new Promise<{ content: string }>((resolve) => { finish = resolve; }));
    tools.register({ name: 'test', description: 'test', risk: 'read', inputSchema: {}, execute });
    const events = new EventBus(); const results = vi.fn(); events.on('tool_result', results);
    const loop = new AgentLoop({ hooks, events, tools,
      context: new ContextManager({ compactThreshold: 10000 }), provider: new FakeProvider([toolUseResponse([{ id: 't', name: 'test', input: {} }])]),
      permission: new PermissionEngine({ mode: 'auto', rules: { allow: [], ask: [], deny: [] } }),
      model: 'fake', systemPrompt: '', maxTurns: 2, cwd: process.cwd(), shutdownTimeoutMs: 5 });
    const run = loop.run('hello'); await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await expect(loop.dispose()).rejects.toMatchObject({ code: 'shutdown_timeout' });
    expect(loop.hasPendingActivity).toBe(true); expect(results).not.toHaveBeenCalled(); expect(execute).toHaveBeenCalledTimes(1);
    finish({ content: 'actual late result' });
    expect((await run).reason).toBe('aborted'); await loop.whenSettled();
    expect(loop.hasPendingActivity).toBe(false); expect(results).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loop.getMessages().at(-1))).toContain('actual late result');
    await expect(loop.dispose()).resolves.toBeUndefined();
  });
});
