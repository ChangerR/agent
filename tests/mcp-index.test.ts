import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { McpResultStore } from '../src/mcp/results.js';
import { resolveAgentPaths } from '../src/core/paths.js';
import { mkdtempProject } from './helpers/project.js';
import { createAgent } from '../src/index.js';

let cwd: string;
const stores: McpResultStore[] = [];
const store = (options: ConstructorParameters<typeof McpResultStore>[0] = 1024) => {
  const value = new McpResultStore(options);
  stores.push(value);
  return value;
};
const signal = () => new AbortController().signal;
const ctx = () => ({ cwd, signal: signal() });
const idOf = (text: string) => /result_id=([0-9a-f-]+)/.exec(text)![1];
beforeEach(async () => {
  cwd = await mkdtempProject(join(tmpdir(), 'mcp-index-'));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
  await rm(cwd, { recursive: true, force: true });
});

it('索引分页恢复 Unicode，续读200字符只读取局部正文，不再每页读全文件', async () => {
  const full = '中😀line\n'.repeat(60000);
  const s = store();
  const id = idOf((await s.retain({ content: full }, ctx())).content);
  const probe = await open(join(cwd, 'probe'), 'w+');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.read;
  await probe.close();
  let bytes = 0;
  const spy = vi.spyOn(prototype, 'read').mockImplementation(async function (
    this: any,
    ...args: any[]
  ) {
    const result = await original.apply(this, args);
    bytes += result.bytesRead;
    return result;
  });
  try {
    const reader = s.reader();
    const points = Array.from(full);
    for (const offset of [0, 100, 2047, 2048, 99999]) {
      const value = await reader.execute({ result_id: id, offset, limit: 100 }, ctx());
      expect(value.content.split('\n[MCP result')[0]).toBe(
        points.slice(offset, offset + 100).join(''),
      );
    }
  } finally {
    spy.mockRestore();
  }
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(Buffer.byteLength(full) / 8);
});

it('旧版本全文首次续读流式建立索引，之后保持原结果ID', async () => {
  const directory = join(resolveAgentPaths(cwd).projectStateDir, 'mcp-results');
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  await writeFile(join(directory, `${id}.txt`), '😀旧结果'.repeat(3000));
  const page = await store().reader().execute({ result_id: id, offset: 2047, limit: 20 }, ctx());
  expect(page.content).toContain(id);
  expect((await readdir(directory)).includes(`${id}.index.json`)).toBe(true);
});

it('检索跨分页边界的字面量、返回真实码点偏移，搜索预算耗尽可继续', async () => {
  const s = store({ maxInlineChars: 1024, maxSearchChars: 8192 });
  const text = '😀'.repeat(8191) + 'NEEDLE' + '中'.repeat(9000) + 'NEEDLE';
  const id = idOf((await s.retain({ content: text }, ctx())).content);
  const first = JSON.parse(
    (await s.searcher().execute({ result_id: id, query: 'NEEDLE', max_matches: 1 }, ctx())).content,
  );
  expect(first.matches[0].offset).toBe(8191);
  let offset = first.next_offset;
  const offsets: number[] = [];
  while (offset !== null) {
    const page = JSON.parse(
      (await s.searcher().execute({ result_id: id, query: 'NEEDLE', offset }, ctx())).content,
    );
    offsets.push(...page.matches.map((m: any) => m.offset));
    expect(page.next_offset === null || page.next_offset > offset).toBe(true);
    offset = page.next_offset;
  }
  expect(offsets).toEqual([8191 + 6 + 9000]);
});

it('动态预览/读页/搜索都有界，不改写原预览，不重复远端操作', async () => {
  const s = store();
  const content = '😀重要限制：仅云端\n'.repeat(1000);
  const preview = await s.retain({ content }, { ...ctx(), resultBudgetTokens: 180 });
  expect(Array.from(preview.content).length).toBeLessThanOrEqual(1024);
  const before = preview.content;
  const id = idOf(before);
  const page = await s
    .reader()
    .execute({ result_id: id, limit: 700 }, { ...ctx(), resultBudgetTokens: 180 });
  const found = await s
    .searcher()
    .execute(
      { result_id: id, query: '仅云端', max_matches: 20 },
      { ...ctx(), resultBudgetTokens: 180 },
    );
  expect(Array.from(page.content).length).toBeLessThan(1024);
  expect(Array.from(found.content).length).toBeLessThan(1024);
  expect(JSON.parse(found.content).next_offset).toBeGreaterThan(0);
  expect(preview.content).toBe(before);
});

it('可选内容去重仅限项目，跨项目读取和检索均拒绝', async () => {
  const s = store({ maxInlineChars: 1024, deduplicate: true });
  const text = 'same'.repeat(1000);
  const a = idOf((await s.retain({ content: text }, ctx())).content);
  const b = idOf((await s.retain({ content: text }, ctx())).content);
  expect(a).toBe(b);
  const other = await mkdtempProject(join(tmpdir(), 'mcp-scope-'));
  try {
    await expect(
      s.reader().execute({ result_id: a }, { cwd: other, signal: signal() }),
    ).rejects.toThrow();
    await expect(
      s.searcher().execute({ result_id: a, query: 'same' }, { cwd: other, signal: signal() }),
    ).rejects.toThrow();
    const c = idOf((await s.retain({ content: text }, { cwd: other, signal: signal() })).content);
    expect(c).not.toBe(a);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

it('容量/过期清理保护活跃租约及保存会话，引用解除后回收，损坏引用扫描则停止清理', async () => {
  const s = store({ maxInlineChars: 1024, maxStoredBytes: 1, maxAgeDays: 1 });
  const id = idOf((await s.retain({ content: 'x'.repeat(5000) }, ctx())).content);
  const future = Date.now() + 40 * 86400000;
  expect((await s.cleanup(cwd, signal(), future)).removed).toBe(0);
  expect((await s.cleanup(cwd, signal(), future)).overCapacity).toBe(true);
  const paths = resolveAgentPaths(cwd);
  await mkdir(paths.sessionsDir, { recursive: true });
  const sessionPath = join(paths.sessionsDir, 'fixture.json');
  await writeFile(sessionPath, JSON.stringify({ messages: [{ content: `Full result_id=${id}` }] }));
  await s.close();
  const reader = store({ maxInlineChars: 1024, maxStoredBytes: 1, maxAgeDays: 1 });
  expect((await reader.cleanup(cwd, signal(), future)).removed).toBe(0);
  await writeFile(sessionPath, '{invalid');
  expect((await reader.cleanup(cwd, signal(), future)).blocked).toBe('reference_scan_incomplete');
  await rm(sessionPath);
  expect((await reader.cleanup(cwd, signal(), future)).removed).toBe(1);
  await expect(reader.reader().execute({ result_id: id }, ctx())).rejects.toThrow();
});

it('真实会话保存/恢复后，远端不在线仍可续读；历史引用阻止过期清理', async () => {
  const s = store(1024);
  const full = 'RESTORE 中😀\n'.repeat(1000);
  const preview = await s.retain({ content: full }, ctx());
  const id = idOf(preview.content);
  const options = {
    config: { provider: 'fake', model: 'offline', disabledPlugins: ['agentlab.planning'] },
  };
  const first = await createAgent(cwd, options);
  let sessionId: string;
  try {
    await first.loop.run(preview.content);
    await first.session.save();
    sessionId = first.session.id;
  } finally {
    await first.dispose();
    await s.close();
  }
  const second = await createAgent(cwd, options);
  try {
    await second.session.resume(sessionId!);
    expect(JSON.stringify(second.loop.getMessages())).toContain(id);
    const tool = second.tools.get('mcp_read_result');
    expect(tool).toBeDefined();
    second.events.on('permission_request', ({ resolve }) => resolve({ allow: true }));
    const page = await second.invokeTool('mcp_read_result', {
      result_id: id,
      offset: 1,
      limit: 20,
    });
    expect(page.content.split('\n[MCP result')[0]).toBe(Array.from(full).slice(1, 21).join(''));
    const gc = store({ maxInlineChars: 1024, maxStoredBytes: 1, maxAgeDays: 1 });
    expect((await gc.cleanup(cwd, signal(), Date.now() + 40 * 86400000)).removed).toBe(0);
  } finally {
    await second.dispose();
  }
});
