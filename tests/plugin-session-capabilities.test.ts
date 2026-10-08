import { describe, expect, it } from 'vitest';
import { SessionManager } from '../src/core/session/coordinator.js';
import { SessionError } from '../src/core/session/errors.js';
import { assertCompatibleEnvelope, validateSessionSnapshot } from '../src/core/session/envelope.js';
import type { SessionFile, SessionListing } from '../src/core/session/types.js';
import { EventBus } from '../src/core/events.js';
import { AgentLoop } from '../src/core/loop.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry } from '../src/core/registry.js';
import { PermissionEngine, parseRule } from '../src/builtin/policy-legacy/engine.js';
import { ContextManager } from '../src/core/context/coordinator.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import type { SessionStore, SaveSessionOptions } from '../src/sdk/index.js';

const policy = { id: 'legacy-v1', version: '1.0.0', stateSchemaVersion: 1 };
/** 测试用替代存储；同样实施版本比较和删除墓碑，完全不访问文件系统。 */
class MemoryStore implements SessionStore {
  files = new Map<string, SessionFile>();
  tombstones = new Map<string, number>();
  path(cwd: string, id: string): string { return `memory:${cwd}/${id}`; }
  async load(cwd: string, id: string): Promise<SessionFile> {
    const found = this.files.get(this.path(cwd, id));
    if (!found) throw new SessionError('not_found', id);
    return structuredClone(found);
  }
  async save(file: SessionFile, options: SaveSessionOptions = {}): Promise<{ path: string; revision: number }> {
    validateSessionSnapshot(file);
    const path = this.path(file.cwd, file.id);
    const existing = this.files.get(path);
    const deleted = this.tombstones.get(path);
    const current = existing?.revision ?? deleted ?? 0;
    const recreate = !existing && deleted !== undefined && options.recreate && (options.recreateRevision ?? (file.revision ?? 0) + 1) === current;
    if ((!recreate && (file.revision ?? 0) !== current) || (!existing && deleted !== undefined && !recreate)) throw new SessionError('conflict', 'stale');
    const revision = current + 1;
    this.files.set(path, structuredClone({ ...file, revision }));
    return { path, revision };
  }
  async list(cwd: string): Promise<SessionListing> {
    return { broken: [], sessions: [...this.files.values()].filter((file) => file.cwd === cwd).map((file) => ({ id: file.id, title: file.title, createdAt: file.createdAt, updatedAt: file.updatedAt, model: file.model, messageCount: file.messages.length, path: this.path(cwd, file.id) })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  }
  async delete(cwd: string, id: string): Promise<{ deleted: boolean; revision: number }> {
    const path = this.path(cwd, id);
    const existing = this.files.get(path);
    if (!existing) return { deleted: false, revision: this.tombstones.get(path) ?? 0 };
    const revision = (existing.revision ?? 0) + 1;
    this.files.delete(path); this.tombstones.set(path, revision);
    return { deleted: true, revision };
  }
  async latest(cwd: string): Promise<string | undefined> { return (await this.list(cwd)).sessions[0]?.id; }
}
function setup(store = new MemoryStore(), id = 'memory-session', persistenceTimeoutMs?: number) {
  const events = new EventBus();
  const permission = new PermissionEngine({ mode: 'ask', rules: { allow: [], ask: [], deny: [] } });
  const context = new ContextManager({ compactThreshold: 100000, compactor: { async compact(messages) { return messages; } } });
  const loop = new AgentLoop({ provider: new FakeProvider([textResponse('ok')]), model: 'fake', tools: new ToolRegistry(), permission, context, events, hooks: new HookRunner(), cwd: '/memory-project', systemPrompt: '', maxTurns: 2 });
  const session = new SessionManager({ loop, permission, events, cwd: '/memory-project', store, restoreRequirements: { policy }, autoSave: false, persistenceTimeoutMs, makeId: () => id, validateSessionRules(rules) { for (const rule of [...rules.allow, ...rules.ask, ...rules.deny]) parseRule(rule); } });
  return { loop, session, permission, events, store };
}
function file(patch: Partial<SessionFile> = {}): SessionFile {
  return { schemaVersion: 2, runtime: { schemaVersion: 1 }, policy, pluginStates: {}, id: 'import', title: 'saved', revision: 0, createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z', cwd: '/memory-project', provider: 'fake', endpointKey: 'default', model: 'fake', thinking: 'off', permissionMode: 'ask', sessionRules: { allow: [], ask: [], deny: [] }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, stats: { messages: 1, estimatedTokens: 1, runs: 0 }, messages: [{ role: 'user', content: 'saved input' }], ...patch };
}
describe('可替换的 SessionStore 与独立版本 envelope', () => {
  it('内存存储经相同协调器保存、恢复、CAS 和删除后显式重建', async () => {
    const first = setup();
    await first.loop.run('hello');
    const saved = await first.session.save();
    expect(saved?.path).toBe('memory:/memory-project/memory-session');
    expect((await first.store.load('/memory-project', first.session.id)).schemaVersion).toBe(2);
    const second = setup(first.store, 'other');
    await second.session.resume(first.session.id);
    expect(second.loop.getMessages()).toEqual(first.loop.getMessages());
    await first.session.save();
    await expect(second.session.save()).rejects.toMatchObject({ code: 'conflict' });
    await expect(second.session.flush()).rejects.toThrow();
    expect(await first.session.delete(first.session.id)).toBe(true);
    await first.session.save();
    expect((await first.store.load('/memory-project', first.session.id)).revision).toBe(4);
  });
  it('恢复并再保存保留未知可选插件状态及其 schemaVersion', async () => {
    const state = { schemaVersion: 72, data: { opaque: ['keep', { nested: true }] } };
    const item = setup();
    await item.store.save(file({ pluginStates: { 'future.optional': state } }));
    await item.session.resume('import');
    await item.session.save();
    expect((await item.store.load('/memory-project', 'import')).pluginStates).toEqual({ 'future.optional': state });
  });
  it('未知必需状态、缺失必需状态与 policy 版本不符都不能恢复', async () => {
    const item = setup();
    await item.loop.run('current history');
    const before = structuredClone(item.loop.getMessages());
    await item.store.save(file({ pluginStates: { 'security.required': { schemaVersion: 1, requiredForSafety: true, data: { allow: true } } } }));
    await expect(item.session.resume('import')).rejects.toMatchObject({ code: 'unsupported_version' });
    expect(item.loop.getMessages()).toEqual(before);
    expect(() => assertCompatibleEnvelope(file(), { policy, plugins: { required: { schemaVersion: 1, requiredForSafety: true } } })).toThrow('缺少');
    expect(() => assertCompatibleEnvelope(file({ policy: { ...policy, version: '2.0.0' } }), { policy })).toThrow('策略');
  });
  it('v2 缺少安全 envelope 字段不能因默认值获得权限', () => {
    for (const key of ['runtime', 'policy', 'pluginStates']) {
      const unsafe: Record<string, unknown> = { ...file() }; delete unsafe[key];
      expect(() => validateSessionSnapshot(unsafe)).toThrow();
    }
  });
  it('v1 保留 provider/endpoint/revision、模式和规则，且不隐式迁移到其他策略', async () => {
    const legacy = file({ schemaVersion: 1, runtime: undefined, policy: undefined, pluginStates: undefined, revision: 11, sessionRules: { allow: ['read_file'], ask: [], deny: [] } });
    const item = setup();
    item.store.files.set(item.store.path('/memory-project', 'import'), structuredClone(legacy));
    await item.session.resume('import');
    await item.session.save();
    const migrated = await item.store.load('/memory-project', 'import');
    expect(migrated).toMatchObject({ schemaVersion: 2, revision: 12, provider: 'fake', endpointKey: 'default', permissionMode: 'ask', sessionRules: legacy.sessionRules, policy });
    expect(() => assertCompatibleEnvelope(legacy, { policy: { ...policy, id: 'different-policy' } })).toThrow('legacy');
  });
  it('替代存储接收独立保存快照，无效提交结果不会推进内存版本', async () => {
    const item = setup(); await item.loop.run('hello');
    const original = item.store.save.bind(item.store);
    item.store.save = async (snapshot, options) => { const result = await original(snapshot, options); snapshot.id = 'mutated-by-plugin'; return result; };
    const saved = await item.session.save(); expect(saved?.id).toBe('memory-session');
    item.store.save = async () => ({ path: 'memory:invalid', revision: Number.NaN });
    await expect(item.session.save()).rejects.toMatchObject({ code: 'invalid_schema' });
    await expect(item.session.flush()).rejects.toThrow();
  });
  it('不合作保存超时明确报告结果未知，保留在途操作直到真实提交', async () => {
    const item = setup(new MemoryStore(), 'memory-session', 10); await item.loop.run('hello');
    const original = item.store.save.bind(item.store); let finish!: () => Promise<void>; let saves = 0;
    item.store.save = (snapshot, options) => { saves++; return new Promise(resolve => { finish = async () => { resolve(await original(snapshot, options)); }; }); };
    await expect(item.session.save()).rejects.toThrow('尚未确认');
    expect(item.session.hasPendingPersistence).toBe(true);
    await expect(item.session.finalize()).rejects.toThrow('退出时会话保存失败');
    expect(item.session.hasPendingPersistence).toBe(true); expect(saves).toBe(1);
    await finish(); await item.session.flush();
    expect(item.session.hasPendingPersistence).toBe(false);
    expect((await item.store.load('/memory-project', 'memory-session')).revision).toBe(1);
  });
  it('恢复等待取消后，迟到读取结果不会提交历史', async () => {
    const item = setup(new MemoryStore(), 'memory-session', 1000);
    let complete!: (file: SessionFile) => void;
    item.store.load = () => new Promise(resolve => { complete = resolve; });
    const cancellation = new AbortController();
    const resume = item.session.resume('import', { signal: cancellation.signal });
    await new Promise(resolve => setImmediate(resolve)); cancellation.abort(new Error('cancel restore'));
    await expect(resume).rejects.toThrow('cancel restore'); complete(file());
    await new Promise(resolve => setImmediate(resolve)); expect(item.loop.getMessages()).toEqual([]); expect(item.session.id).toBe('memory-session');
  });
  it('控制器 setter 先改状态再失败时，恢复原权限和历史', async () => {
    const item = setup();
    await item.loop.run('current');
    item.permission.setSessionRules({ allow: [], ask: [], deny: ['write_file'] });
    const before = structuredClone(item.loop.getMessages());
    await item.store.save(file({ sessionRules: { allow: ['read_file'], ask: [], deny: [] } }));
    const original = item.permission.setSessionRules.bind(item.permission);
    let fail = true;
    item.permission.setSessionRules = (rules) => { original(rules); if (fail) { fail = false; throw new Error('controller failed after mutation'); } };
    await expect(item.session.resume('import')).rejects.toThrow('controller failed');
    expect(item.loop.getMessages()).toEqual(before);
    expect(item.permission.getSessionRules()).toEqual({ allow: [], ask: [], deny: ['write_file'] });
    expect(item.session.id).toBe('memory-session');
  });
  it('不可编辑控制器在模式预检失败时不改历史或规则', async () => {
    const item = setup(); item.permission.setMode('auto');
    Object.assign(item.permission, { validateMode() { throw new Error('read-only controller'); } });
    await item.store.save(file({ permissionMode: 'ask' }));
    await expect(item.session.resume('import')).rejects.toThrow('read-only');
    expect(item.loop.getMessages()).toEqual([]);
    expect(item.permission.mode).toBe('auto');
  });
  it('替代存储返回未配对历史或不兼容 endpoint，当前状态不改变', async () => {
    const item = setup();
    const bad = file({ messages: [{ role: 'user', content: [{ type: 'tool_result', toolUseId: 'missing', content: 'bad' }] }] });
    item.store.files.set(item.store.path('/memory-project', 'import'), bad);
    await expect(item.session.resume('import')).rejects.toMatchObject({ code: 'invariant' });
    expect(item.loop.getMessages()).toEqual([]);
    item.store.files.set(item.store.path('/memory-project', 'import'), file({ endpointKey: 'different-endpoint' }));
    await expect(item.session.resume('import')).rejects.toMatchObject({ code: 'provider_mismatch' });
    expect(item.loop.getMessages()).toEqual([]);
  });
});
