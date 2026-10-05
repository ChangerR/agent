/**
 * 装配冒烟测试：createAgent 全插件加载（不触网）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent, type Agent } from '../src/index.js';

let tmp: string;
let agent: Agent | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-boot-'));
});

afterEach(async () => {
  await agent?.dispose();
  agent = undefined;
  await rm(tmp, { recursive: true, force: true });
});

describe('createAgent', () => {
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
export default { name: 'cleanup-test', register() { return async () => {
await writeFile(new URL('./disposed.txt', import.meta.url), 'released');
}; } };`);
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake', plugins: ['plugin.mjs'] }));
    agent = await createAgent(tmp);
    const first = agent.dispose();
    expect(agent.dispose()).toBe(first);
    await first;
    expect(await readFile(join(tmp, 'disposed.txt'), 'utf8')).toBe('released');
    await expect(agent.loop.run('again')).rejects.toThrow('disposed');
  });

  it('装配在插件加载后失败时仍释放插件', async () => {
    await writeFile(join(tmp, 'plugin.mjs'), `import { writeFile } from 'node:fs/promises';
export default { name: 'rollback-test', register() { return () => writeFile(new URL('./rollback.txt', import.meta.url), 'released'); } };`);
    await writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake', plugins: ['plugin.mjs'] }));
    await writeFile(join(tmp, 'models.json'), '{invalid');
    await expect(createAgent(tmp)).rejects.toThrow();
    expect(await readFile(join(tmp, 'rollback.txt'), 'utf8')).toBe('released');
  });
});
