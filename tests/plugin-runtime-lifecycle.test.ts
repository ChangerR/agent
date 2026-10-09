import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAgent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
import { fileSessionStore } from '../src/builtin/session-file/index.js';
it('未结束的实际工具调用令退出报告故障，真实结束前不释放插件', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plugin-shutdown-'));
  let finish!: (value: { content: string }) => void; let started = false; let disposed = 0;
  const plugin = definePlugin({ manifest: { id: 'test.pending-tool', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.onDispose(() => { disposed++; });
    ctx.provide.tool('pending-tool', { name: 'pending-tool', description: 'pending', risk: 'read', inputSchema: { type: 'object' }, execute() { started = true; return new Promise(resolve => { finish = resolve; }); } });
  } });
  const agent = await createAgent(cwd, { plugins: [plugin], config: { provider: 'fake', permissionMode: 'auto' }, autoSaveSessions: false, lifecycleTimeoutMs: 10 });
  const invocation = agent.invokeTool('pending-tool', {});
  try {
    await vi.waitFor(() => expect(started).toBe(true));
    await expect(agent.dispose()).rejects.toThrow('resources retained');
    expect(disposed).toBe(0);
    await expect(agent.dispatchCommand('/help')).rejects.toThrow('disposed');
    finish({ content: 'actually completed' }); await invocation;
    await vi.waitFor(() => expect(disposed).toBe(1));
  } finally { finish?.({ content: 'cleanup' }); await invocation.catch(() => {}); await rm(cwd, { recursive: true, force: true }); }
});
it('未确认的持久化仍占用 store，实际提交结束后才清理，不重复写入', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plugin-store-shutdown-'));
  let finish!: (value: { path: string; revision: number }) => void; let saves = 0; let disposed = 0;
  const plugin = definePlugin({ manifest: { id: 'test.pending-store', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.onDispose(() => { disposed++; });
    ctx.provide.sessionStore('pending-store', { ...fileSessionStore, save() { saves++; return new Promise(resolve => { finish = resolve; }); } });
  } });
  const agent = await createAgent(cwd, { plugins: [plugin], config: { provider: 'fake', capabilities: { sessionStore: 'pending-store' } }, autoSaveSessions: false, lifecycleTimeoutMs: 10 });
  try {
    await agent.loop.run('hello');
    await expect(agent.session.save()).rejects.toThrow();
    await expect(agent.dispose()).rejects.toThrow();
    expect(disposed).toBe(0); expect(saves).toBe(1);
    finish({ path: 'memory:committed', revision: 1 });
    await vi.waitFor(() => expect(disposed).toBe(1)); expect(saves).toBe(1);
  } finally { finish?.({ path: 'memory:committed', revision: 1 }); await agent.session.whenPersistenceSettled(); await rm(cwd, { recursive: true, force: true }); }
});
