import { mkdtempProject } from './helpers/project.js';
/**
 * 装配冒烟测试：createAgent 全插件加载（不触网）。
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createAgent, loadSession, type Agent } from '../src/index.js';

let tmp: string;
let agent: Agent | undefined;

beforeEach(async () => {
  tmp = await mkdtempProject(join(tmpdir(), 'agentlab-boot-'));
});

afterEach(async () => {
  await agent?.dispose();
  agent = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe('createAgent', () => {
  it('退出保存最后一次 model / think / mode 设置，无需再发消息', async () => {
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
    agent = await createAgent(tmp);
    await agent.loop.run('hello');
    const id = agent.session.id;
    agent.loop.setModel('final-model');
    agent.loop.setThinking('high');
    agent.permission.setMode('auto');
    await agent.dispose();
    expect(await loadSession(tmp, id)).toMatchObject({ model: 'final-model', thinking: 'high', permissionMode: 'auto' });
  });

  it('退出保存失败仍释放插件，并向调用方报告聚合错误', async () => {
    await writeFile(join(tmp, 'plugin.mjs'), `import { writeFile } from 'node:fs/promises';
export default { manifest: { id: 'cleanup', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.onDispose(async () => {
await writeFile(new URL('./cleanup.txt', import.meta.url), 'released'); throw new Error('cleanup failure');
}); } };`);
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake', pluginEntries: ['plugin.mjs'] }));
    agent = await createAgent(tmp);
    await agent.loop.run('hello');
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    try {
      const failure = await agent.dispose().catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(2);
      expect(await readFile(join(tmp, 'cleanup.txt'), 'utf8')).toBe('released');
    } finally { vi.restoreAllMocks(); agent = undefined; }
  });

  it('明确禁用自动保存时退出也不写会话', async () => {
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
    agent = await createAgent(tmp, { autoSaveSessions: false });
    await agent.loop.run('hello');
    await agent.dispose();
    await expect(fs.access(agent.paths.sessionsDir)).rejects.toThrow();
  });
  it('保存 endpoint 指纹，不保存 URL 中的凭证或配置密钥', async () => {
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake', baseURL: 'https://user:secret@example.test/v1?token=private' }));
    agent = await createAgent(tmp);
    await agent.loop.run('hello');
    await agent.session.flush();
    const file = await agent.session.save();
    const text = await readFile(file!.path, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ provider: 'fake', endpointKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    for (const value of ['secret', 'private', 'example.test', 'apiKey']) expect(text).not.toContain(value);
  });
  it('装配全部内置能力：providers / tools / 权限引擎 / loop', async () => {
    agent = await createAgent(tmp);
    expect(agent.providers.list().map((p) => p.name).sort()).toEqual(['anthropic', 'fake', 'openai']);
    const toolNames = agent.tools.list().map((t) => t.name);
    for (const expected of ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'use_skill']) {
      expect(toolNames).toContain(expected);
    }
    expect(agent.permission.mode).toBe('ask');
    expect(agent.loop.model).toBe('claude-sonnet-4-5');
  });

  it('Agent dispose 等待插件清理、可重复调用，关闭后不能再运行', async () => {
    await writeFile(join(tmp, 'plugin.mjs'), `import { writeFile } from 'node:fs/promises';
export default { manifest: { id: 'cleanup-test', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.onDispose(async () => {
await writeFile(new URL('./disposed.txt', import.meta.url), 'released');
}); } };`);
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake', pluginEntries: ['plugin.mjs'] }));
    agent = await createAgent(tmp);
    const first = agent.dispose();
    expect(agent.dispose()).toBe(first);
    await first;
    expect(await readFile(join(tmp, 'disposed.txt'), 'utf8')).toBe('released');
    await expect(agent.loop.run('again')).rejects.toThrow('disposed');
  });

  it('装配在插件加载后失败时仍释放插件', async () => {
    await writeFile(join(tmp, 'plugin.mjs'), `import { writeFile } from 'node:fs/promises';
export default { manifest: { id: 'rollback-test', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.onDispose(() => writeFile(new URL('./rollback.txt', import.meta.url), 'released')); } };`);
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake', pluginEntries: ['plugin.mjs'] }));
    // 清单/配置预校验现在在 setup 前完成；选中不存在的 provider 在组装阶段失败。
    const config = JSON.parse(await readFile(join(tmp, 'agent.config.json'), 'utf8'));
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ ...config, provider: 'missing-provider' }));
    await expect(createAgent(tmp)).rejects.toThrow();
    expect(await readFile(join(tmp, 'rollback.txt'), 'utf8')).toBe('released');
  });
});
