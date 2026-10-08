import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
it('实际宿主只读审批观察者不算 responder；无交互端立即返回 approval_required', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plugin-observer-'));
  let observed = 0;
  const plugin = definePlugin({ manifest: { id: 'test.permission-observer', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.events.on('permission_request', event => { observed++; expect('resolve' in event).toBe(false); });
  } });
  const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: { provider: 'fake', permissionMode: 'ask' } });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try { expect(await agent.invokeTool('write_file', { path: 'blocked.txt', content: 'blocked' }, controller.signal)).toMatchObject({ isError: true, content: expect.stringContaining('approval_required') }); }
    finally { clearTimeout(timer); }
    expect(agent.tools.get('write_file')).not.toHaveProperty('execute');
    expect(agent.tools).not.toHaveProperty('register');
    expect(agent.plugins.get('tool', 'write_file')).not.toHaveProperty('implementation');
    expect(agent.plugins).not.toHaveProperty('load');
    // 没有 responder 时无需制造一个永远无法结算的请求。
    expect(observed).toBeLessThanOrEqual(1);
  } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
it('工具依赖只提供描述，不存在绕过统一门的 execute 句柄', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plugin-dependency-'));
  const plugin = definePlugin({ manifest: { id: 'test.tool-dependency', version: '1.0.0', apiVersion: 1, requires: { 'agentlab.local-tools': '^1.0.0' } }, setup(ctx) {
    const tool = ctx.dependencies.get('agentlab.local-tools').get('tool', 'write_file');
    expect(tool).not.toHaveProperty('execute');
    expect(ctx.dependencies.get('agentlab.local-tools').list('tool').every(r => !('execute' in r.implementation))).toBe(true);
  } });
  const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: { provider: 'fake' } });
  try { expect(agent.plugins.frozen).toBe(true); } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

it('结构化命令参数保留 JSON 字符串内的连续空白', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'plugin-command-json-'));
  const agent = await createAgent(cwd, { autoSaveSessions: false, config: { provider: 'fake' }, plugins: [definePlugin({ manifest: { id: 'test.echo-json', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.command('echo-json', { description: 'echo JSON', handler: input => ({ type: 'data', data: input }) }); } })] });
  try { expect(await agent.dispatchCommand('/echo-json {"message":"a  b"}')).toEqual({ type: 'data', data: { message: 'a  b' } }); }
  finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
