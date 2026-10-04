/**
 * 装配冒烟测试：createAgent 全插件加载（不触网）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/index.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-boot-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('createAgent', () => {
  it('装配全部内置能力：providers / tools / 权限引擎 / loop', async () => {
    const agent = await createAgent(tmp);
    expect(agent.providers.list().map((p) => p.name).sort()).toEqual(['anthropic', 'fake', 'openai']);
    const toolNames = agent.tools.list().map((t) => t.name);
    for (const expected of ['read_file', 'write_file', 'edit_file', 'bash', 'glob', 'grep', 'use_skill']) {
      expect(toolNames).toContain(expected);
    }
    expect(agent.permission.mode).toBe('ask');
    expect(agent.loop.model).toBe('claude-sonnet-4-5');
  });
});
