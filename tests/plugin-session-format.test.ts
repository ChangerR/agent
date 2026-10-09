import { mkdtempProject } from './helpers/project.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSession, listSessions, latestSessionId, saveSessionVersioned, sessionPath, deleteSessionVersioned } from '../src/builtin/session-file/implementation.js';
import type { SessionFile } from '../src/core/session/types.js';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtempProject(join(tmpdir(), 'session-format-')); dirs.push(cwd);
  const current: SessionFile = { schemaVersion: 2, runtime: { schemaVersion: 1 }, policy: { id: 'deterministic', version: '2.0.0', stateSchemaVersion: 1 }, pluginStates: {}, id: 'saved', title: 'original', revision: 4, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', cwd, provider: 'fake', endpointKey: 'default', model: 'fake', thinking: 'off', permissionMode: 'ask', sessionRules: { allow: [], ask: [], deny: [] }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, stats: { messages: 1, estimatedTokens: 1, runs: 0 }, messages: [{ role: 'user', content: 'original text' }] };
  const path = sessionPath(cwd, current.id); await fs.mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(`\t${JSON.stringify(current, null, 4)}\r\n  `); await fs.writeFile(path, bytes);
  return { cwd, current, path, bytes };
}
describe('单一会话格式与存储取消边界', () => {
  it.each([1, 3])('拒绝格式 %s 的读取、覆盖和删除，保留原始字节', async schemaVersion => {
    const f = await fixture();
    const bytes = Buffer.from(`\t${JSON.stringify({ ...f.current, schemaVersion }, null, 4)}\r\n`);
    await fs.writeFile(f.path, bytes);
    await expect(loadSession(f.cwd, 'saved')).rejects.toMatchObject({ code: 'unsupported_version' });
    expect(await listSessions(f.cwd)).toMatchObject({ sessions: [], broken: [{ id: 'saved', error: { code: 'unsupported_version' } }] });
    expect(await latestSessionId(f.cwd)).toBeUndefined();
    await expect(saveSessionVersioned(f.current)).rejects.toMatchObject({ code: 'unsupported_version' });
    await expect(deleteSessionVersioned(f.cwd, 'saved')).rejects.toMatchObject({ code: 'unsupported_version' });
    expect(await fs.readFile(f.path)).toEqual(bytes);
    expect(await fs.readdir(dirname(f.path))).toEqual(['saved.json']);
  });
  it.each(['runtime', 'policy', 'pluginStates', 'provider', 'endpointKey', 'revision'])('当前格式缺少 %s 时拒绝保存、读取和覆盖', async field => {
    const f = await fixture();
    const malformed = { ...f.current } as unknown as Record<string, unknown>;
    delete malformed[field];
    await expect(saveSessionVersioned(malformed as unknown as SessionFile)).rejects.toMatchObject({ code: 'invalid_schema' });
    expect(await fs.readFile(f.path)).toEqual(f.bytes);
    const bytes = Buffer.from(JSON.stringify(malformed)); await fs.writeFile(f.path, bytes);
    await expect(loadSession(f.cwd, 'saved')).rejects.toMatchObject({ code: 'invalid_schema' });
    await expect(saveSessionVersioned(f.current)).rejects.toMatchObject({ code: 'invalid_schema' });
    expect(await fs.readFile(f.path)).toEqual(bytes);
  });
  it.each(['allow', 'ask', 'deny'])('缺少 %s 规则数组拒绝加载和保存，不补写默认值', async kind => {
    const f = await fixture();
    const malformed = structuredClone(f.current);
    delete (malformed.sessionRules as unknown as Record<string, unknown>)[kind];
    await expect(saveSessionVersioned(malformed)).rejects.toMatchObject({ code: 'invalid_schema' });
    expect(await fs.readFile(f.path)).toEqual(f.bytes);
    const bytes = Buffer.from(JSON.stringify(malformed)); await fs.writeFile(f.path, bytes);
    await expect(loadSession(f.cwd, 'saved')).rejects.toMatchObject({ code: 'invalid_schema' });
    expect(await fs.readFile(f.path)).toEqual(bytes);
  });
  it('当前格式保存递增版本且仅写当前会话文件', async () => {
    const f = await fixture();
    const commit = await saveSessionVersioned(f.current);
    expect(commit.revision).toBe(5);
    expect((await loadSession(f.cwd, 'saved')).revision).toBe(5);
    await saveSessionVersioned({ ...f.current, revision: commit.revision, title: 'second save' });
    expect((await loadSession(f.cwd, 'saved')).revision).toBe(6);
    expect(await fs.readdir(dirname(f.path))).toEqual(['saved.json']);
  });
  it('提交前取消不改文件，rename 已提交后取消仍返回真实成功', async () => {
    const f = await fixture(); const before = new AbortController(); before.abort(new Error('cancel before'));
    await expect(saveSessionVersioned(f.current, {}, before.signal)).rejects.toThrow('cancel before');
    expect(await fs.readFile(f.path)).toEqual(f.bytes);
    const after = new AbortController(); const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(to) === f.path) after.abort(new Error('cancel after commit')); });
    await expect(saveSessionVersioned(f.current, {}, after.signal)).resolves.toMatchObject({ revision: 5 });
    const noDelete = new AbortController(); noDelete.abort();
    await expect(deleteSessionVersioned(f.cwd, 'saved', noDelete.signal)).rejects.toThrow();
    expect((await loadSession(f.cwd, 'saved')).revision).toBe(5);
  });
});
