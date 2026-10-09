import { mkdtempProject } from './helpers/project.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSession, saveSessionVersioned, sessionPath, deleteSessionVersioned } from '../src/builtin/session-file/implementation.js';
import type { SessionFile } from '../src/core/session/types.js';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtempProject(join(tmpdir(), 'session-v1-upgrade-')); dirs.push(cwd);
  const legacy: SessionFile = { schemaVersion: 1, id: 'legacy', title: 'original', revision: 4, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', cwd, provider: 'fake', endpointKey: 'default', model: 'fake', thinking: 'off', permissionMode: 'ask', sessionRules: { allow: [], ask: [], deny: [] }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, stats: { messages: 1, estimatedTokens: 1, runs: 0 }, messages: [{ role: 'user', content: 'original text' }] };
  const path = sessionPath(cwd, legacy.id); await fs.mkdir(dirname(path), { recursive: true });
  const bytes = Buffer.from(`\t${JSON.stringify(legacy, null, 4)}\r\n  `); await fs.writeFile(path, bytes);
  const next: SessionFile = { ...legacy, schemaVersion: 2, runtime: { schemaVersion: 1 }, policy: { id: 'legacy-v1', version: '1.0.0', stateSchemaVersion: 1 }, pluginStates: {} };
  return { cwd, legacy, next, path, bytes };
}
describe('v1 升级备份与存储取消边界', () => {
  it('升级前在同一锁内保留原始字节，后续保存不覆盖首次备份', async () => {
    const f = await fixture(); const commit = await saveSessionVersioned(f.next);
    expect(await fs.readFile(`${f.path}.v1.bak`)).toEqual(f.bytes);
    expect((await loadSession(f.cwd, 'legacy')).schemaVersion).toBe(2);
    await saveSessionVersioned({ ...f.next, revision: commit.revision, title: 'second save' });
    expect(await fs.readFile(`${f.path}.v1.bak`)).toEqual(f.bytes);
    // 模拟用户从备份恢复 v1 后再迁移；仍不覆盖首次原始备份。
    await fs.writeFile(f.path, JSON.stringify({ ...f.legacy, title: 'restored v1' }));
    await saveSessionVersioned(f.next);
    expect(await fs.readFile(`${f.path}.v1.bak`)).toEqual(f.bytes);
  });
  it('备份失败或既有备份损坏时，v1 原文件保持字节不变', async () => {
    const f = await fixture(); await fs.mkdir(`${f.path}.v1.bak`);
    await expect(saveSessionVersioned(f.next)).rejects.toThrow();
    expect(await fs.readFile(f.path)).toEqual(f.bytes);
    await fs.rm(`${f.path}.v1.bak`, { recursive: true }); await fs.writeFile(`${f.path}.v1.bak`, '{broken');
    await expect(saveSessionVersioned(f.next)).rejects.toThrow(); expect(await fs.readFile(f.path)).toEqual(f.bytes);
  });
  it('其他会话的有效 v1 备份不能充当原文件的迁移保护', async () => {
    const f = await fixture();
    for (const patch of [{ id: 'different-session' }, { cwd: `${f.cwd}/different` }, { provider: 'different-provider' }, { endpointKey: 'different-endpoint' }, { createdAt: '2000-01-01' }]) {
      await fs.writeFile(`${f.path}.v1.bak`, JSON.stringify({ ...f.legacy, ...patch }));
      await expect(saveSessionVersioned(f.next)).rejects.toMatchObject({ code: 'conflict' });
      expect(await fs.readFile(f.path)).toEqual(f.bytes);
    }
  });
  it('提交前取消不改文件，rename 已提交后取消仍返回真实成功', async () => {
    const f = await fixture(); const before = new AbortController(); before.abort(new Error('cancel before'));
    await expect(saveSessionVersioned(f.next, {}, before.signal)).rejects.toThrow('cancel before');
    expect(await fs.readFile(f.path)).toEqual(f.bytes);
    const after = new AbortController(); const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { await rename(from, to); if (String(to) === f.path) after.abort(new Error('cancel after commit')); });
    await expect(saveSessionVersioned(f.next, {}, after.signal)).resolves.toMatchObject({ revision: 5 });
    expect((await loadSession(f.cwd, 'legacy')).schemaVersion).toBe(2);
    const noDelete = new AbortController(); noDelete.abort();
    await expect(deleteSessionVersioned(f.cwd, 'legacy', noDelete.signal)).rejects.toThrow();
    expect((await loadSession(f.cwd, 'legacy')).revision).toBe(5);
  });
});
