import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpClientManager } from '../src/mcp/plugin.js';
import { McpResultStore } from '../src/mcp/results.js';
import { resolveAgentPaths } from '../src/core/paths.js';
import { mkdtempProject } from './helpers/project.js';
import { ToolRegistry } from '../src/core/registry.js';
import { AgentLoop } from '../src/core/loop.js';
import { ContextManager } from '../src/core/context/coordinator.js';
import { SummaryCompactor } from '../src/builtin/compaction-summary/implementation.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';

let cwd: string;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  cwd = await mkdtempProject(join(tmpdir(), 'mcp-results-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const resultId = (text: string) => /result_id=([0-9a-f-]+)/.exec(text)![1];

describe('MCP 首次结果限额与续读', () => {
  it('保留完整 Unicode、首尾、错误标志，按页恢复所有内容且不重做远端操作', async () => {
    const full = 'HEAD\n' + '中😀文\n'.repeat(800) + 'TAIL';
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: full }],
      isError: true,
    }));
    const client = {
      listTools: async () => ({ tools: [{ name: 'large', inputSchema: { type: 'object' } }] }),
      callTool,
    } as unknown as Client;
    const manager = new McpClientManager({ maxInlineChars: 1024 });
    const [tool] = await manager.bridgeTools('test', client);
    const preview = await tool.execute({}, { cwd, signal: signal() });
    expect(Array.from(preview.content).length).toBeLessThanOrEqual(1024);
    expect(preview.content).toContain('HEAD');
    expect(preview.content).toContain('TAIL');
    expect(preview.isError).toBe(true);
    const id = resultId(preview.content);
    // 新 manager 仍可恢复同一项目的结果，不依赖原 client 或进程内正文缓存。
    const reader = new McpClientManager({ maxInlineChars: 1024 }).resultReader();
    let restored = '';
    let offset = 0;
    while (offset < Array.from(full).length) {
      const page = await reader.execute(
        { result_id: id, offset, limit: 500 },
        { cwd, signal: signal() },
      );
      expect(Array.from(page.content).length).toBeLessThanOrEqual(1024);
      restored += page.content.slice(0, page.content.lastIndexOf('\n[MCP result'));
      offset = Math.min(Array.from(full).length, offset + 500);
    }
    expect(restored).toBe(full);
    expect(callTool).toHaveBeenCalledTimes(1);
    await expect(
      reader.execute({ result_id: '../secret' }, { cwd, signal: signal() }),
    ).rejects.toThrow('invalid_mcp_result_page');
    const other = await mkdtempProject(join(tmpdir(), 'mcp-other-'));
    try {
      await expect(
        reader.execute({ result_id: id }, { cwd: other, signal: signal() }),
      ).rejects.toThrow();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('续读走唯一权限门，已发送的短结果不会被后续分页改写', async () => {
    const store = new McpResultStore(1024);
    const initial = await store.retain(
      { content: 'HEAD' + 'x'.repeat(3000) + 'TAIL' },
      { cwd, signal: signal() },
    );
    const tools = new ToolRegistry();
    tools.register(store.reader());
    const denied = new AgentLoop({
      cwd,
      provider: new FakeProvider([]),
      model: 'fake',
      tools,
      hooks: new HookRunner(),
      events: new EventBus(),
      context: new ContextManager({ compactor: new SummaryCompactor(), compactThreshold: 10000 }),
      policy: { decide: () => ({ kind: 'deny', source: 'config', reason: 'reader denied' }) },
      systemPrompt: '',
      maxTurns: 2,
    });
    expect(
      (await denied.invokeTool('mcp_read_result', { result_id: resultId(initial.content) }))
        .isError,
    ).toBe(true);
    await denied.dispose();
    const provider = new FakeProvider([
      toolUseResponse([
        {
          id: 'page',
          name: 'mcp_read_result',
          input: { result_id: resultId(initial.content), limit: 500 },
        },
      ]),
      textResponse('done'),
      textResponse('next'),
    ]);
    const loop = new AgentLoop({
      cwd,
      provider,
      model: 'fake',
      tools,
      hooks: new HookRunner(),
      events: new EventBus(),
      context: new ContextManager({ compactor: new SummaryCompactor(), compactThreshold: 10000 }),
      policy: {
        decide: () => ({ kind: 'allow', source: 'config', reason: 'fixture authorizes read' }),
      },
      systemPrompt: '',
      maxTurns: 3,
    });
    expect((await loop.run(initial.content)).reason).toBe('completed');
    const prior = structuredClone(provider.requests[1].messages);
    await loop.run('continue');
    expect(provider.requests[2].messages.slice(0, prior.length)).toEqual(prior);
    expect(provider.requests[2].messages[0].content).toBe(initial.content);
    await loop.dispose();
  });

  it('拒绝链接文件和结果目录，保存失败不会返回无界正文', async () => {
    const store = new McpResultStore(1024);
    const preview = await store.retain({ content: 'x'.repeat(3000) }, { cwd, signal: signal() });
    const directory = join(resolveAgentPaths(cwd).projectStateDir, 'mcp-results');
    const id = '00000000-0000-4000-8000-000000000000';
    const target = join(cwd, 'private-fixture.txt');
    await writeFile(target, 'fixture');
    await link(target, join(directory, `${id}.txt`));
    await expect(
      store.reader().execute({ result_id: id }, { cwd, signal: signal() }),
    ).rejects.toThrow('unsafe_result_file');
    await rm(join(directory, `${id}.txt`));
    if (process.platform !== 'win32') {
      await symlink(target, join(directory, `${id}.txt`));
      await expect(
        store.reader().execute({ result_id: id }, { cwd, signal: signal() }),
      ).rejects.toThrow();
      await rm(directory, { recursive: true });
      await symlink(cwd, directory);
      const failed = await store.retain(
        { content: 'unbounded'.repeat(1000) },
        { cwd, signal: signal() },
      );
      expect(failed.isError).toBe(true);
      expect(failed.content).toContain('不要自动重复');
      expect(failed.content.length).toBeLessThan(1024);
    }
    expect(resultId(preview.content)).toMatch(/[0-9a-f-]+/);
  });
});
