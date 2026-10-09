import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/index.js';
import { createScopedConfigStores, PluginConfigStore } from '../src/runtime/config-store.js';

const dirs: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'agent-settings-scope-')); dirs.push(path); return path; };
const project = () => { const path = dir(); mkdirSync(join(path, '.git')); writeFileSync(join(path, '.git', 'HEAD'), 'ref: refs/heads/test\n'); return path; };
const signal = () => new AbortController().signal;
const write = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
let home: string;
beforeEach(() => { home = dir(); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home); });
afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe('设置的全局 / 项目原始层隔离', () => {
  it('路径诊断展示启动位置、canonical root和分层来源，不展示配置值或环境变量', async () => {
    const cwd = project(); const child = join(cwd, 'child'); mkdirSync(child);
    write(join(home, '.agent', 'config.json'), { provider: 'fake' });
    write(join(cwd, 'agent.config.json'), { model: 'do-not-display-config-value' });
    vi.stubEnv('SETTINGS_TEST_PRIVATE_VALUE', 'do-not-display-environment-value');
    const agent = await createAgent(child, { autoSaveSessions: false });
    try {
      const section = agent.settings.find(record => record.id === 'config-paths')!.section;
      expect(section.commit).toBeUndefined(); expect(section.draft).toBeUndefined();
      const value = await section.read!(signal());
      expect(value).toMatchObject({ precedence: ['default', 'global', 'project', 'session'], paths: { cwd: child, projectRoot: cwd, globalConfigPath: join(home, '.agent', 'config.json'), projectConfigPath: join(cwd, 'agent.config.json') }, sources: { model: { scope: 'project', directory: cwd }, provider: { scope: 'global' } } });
      expect(JSON.stringify(value)).not.toContain('do-not-display-config-value'); expect(JSON.stringify(value)).not.toContain('do-not-display-environment-value');
    } finally { await agent.dispose(); }
  });

  it('读取或放弃草稿不创建全局目录，仅commit创建并保存指定层', () => {
    const cwd = project(); const stores = createScopedConfigStores(cwd);
    const globalPath = join(home, '.agent', 'config.json'); const projectPath = join(cwd, 'agent.config.json');
    expect(stores.scopeTargets).toEqual([{ scope: 'project', path: projectPath }, { scope: 'global', path: globalPath }]);
    const base = stores.store('global').read('demo');
    expect(base.value).toEqual({}); expect(existsSync(join(home, '.agent'))).toBe(false);
    expect(() => stores.store('session')).toThrow(/仅支持/);
    stores.store('global').commit('demo', base, { provider: 'fake' }, { schema: { parse: value => value }, ownedFields: ['provider'] });
    expect(read(globalPath)).toEqual({ pluginConfig: { demo: { provider: 'fake' } } });
    expect(existsSync(projectPath)).toBe(false);
  });

  it('reviewer全局读取不带入项目值；各层草稿独立、跨层提交失败、省略字段恢复继承', async () => {
    const cwd = project(); const projectPath = join(cwd, 'agent.config.json'); const globalPath = join(home, '.agent', 'config.json');
    write(globalPath, { provider: 'fake', capabilities: { reviewer: 'model' }, pluginConfig: { 'agentlab.reviewer-model': { provider: 'fake', model: 'global-model', timeoutMs: 11000, future: { keep: true } } } });
    write(projectPath, { model: 'main-model', permissions: { allow: ['read_file(project-only.txt)'] }, pluginConfig: { 'agentlab.reviewer-model': { model: 'project-model', timeoutMs: 22000 } } });
    const originalProject = readFileSync(projectPath, 'utf8');
    let agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      const section = agent.settings.find(record => record.id === 'reviewer-model-config')!.section;
      expect(await section.read!(signal(), 'global')).toEqual({ provider: 'fake', model: 'global-model', timeoutMs: 11000, future: { keep: true } });
      expect(await section.read!(signal(), 'project')).toEqual({ model: 'project-model', timeoutMs: 22000 });
      const globalDraft = await section.draft!({ model: 'new-global' }, signal(), 'global');
      const projectDraft = await section.draft!({}, signal(), 'project');
      expect(() => section.commit!(globalDraft, signal(), 'project')).toThrow(/作用域/);
      await section.commit!(globalDraft, signal(), 'global');
      expect(readFileSync(projectPath, 'utf8')).toBe(originalProject);
      expect(read(globalPath).pluginConfig['agentlab.reviewer-model']).toEqual({ model: 'new-global', future: { keep: true } });
      expect(read(globalPath)).not.toHaveProperty('permissions');
      expect(agent.loop.getJudgeStatus()).toMatchObject({ model: 'project-model', providerSource: 'explicit' });
      await section.commit!(projectDraft, signal(), 'project');
      expect(read(projectPath).pluginConfig['agentlab.reviewer-model']).toEqual({});
      await agent.dispose(); agent = await createAgent(cwd, { autoSaveSessions: false });
      expect(agent.loop.getJudgeStatus()).toMatchObject({ model: 'new-global', providerSource: 'current' });
    } finally { await agent.dispose(); }
  });

  it('能力全局保存和删除不复制项目选择，取消和过期草稿不覆盖磁盘', async () => {
    const cwd = project(); const projectPath = join(cwd, 'agent.config.json'); const globalPath = join(home, '.agent', 'config.json');
    write(globalPath, { provider: 'fake', future: { keep: true } });
    write(projectPath, { capabilities: { reviewer: 'model' }, pluginConfig: { 'agentlab.policy': { writeRoots: [] } } });
    const originalProject = readFileSync(projectPath, 'utf8'); const originalGlobal = readFileSync(globalPath, 'utf8');
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      const section = agent.settings.find(record => record.id === 'capability-selection')!.section;
      expect(await section.read!(signal(), 'global')).toEqual({});
      expect(await section.read!(signal(), 'project')).toEqual({ reviewer: 'model' });
      const draft = await section.draft!({ reviewer: false }, signal(), 'global');
      expect(readFileSync(globalPath, 'utf8')).toBe(originalGlobal);
      expect(() => section.commit!(draft, signal(), 'project')).toThrow(/作用域/);
      await section.commit!(draft, signal(), 'global');
      expect(read(globalPath)).toEqual({ provider: 'fake', future: { keep: true }, capabilities: { reviewer: false } });
      expect(readFileSync(projectPath, 'utf8')).toBe(originalProject);
      expect(agent.plugins.selected('reviewer')?.id).toBe('model');
      await section.read!(signal(), 'global');
      const clear = await section.draft!({}, signal(), 'global'); await section.commit!(clear, signal(), 'global');
      expect(read(globalPath).capabilities).toEqual({});
      await section.read!(signal(), 'global');
      const stale = await section.draft!({ reviewer: false }, signal(), 'global');
      write(globalPath, { provider: 'fake', external: true });
      expect(() => section.commit!(stale, signal(), 'global')).toThrow(/配置已变化/);
      expect(read(globalPath)).toEqual({ provider: 'fake', external: true });
    } finally { await agent.dispose(); }
  });

  it('writeRoots设置和运行配置都拒绝全局授权', async () => {
    const cwd = project(); const globalPath = join(home, '.agent', 'config.json');
    const agent = await createAgent(cwd, { config: { provider: 'fake' }, autoSaveSessions: false });
    try {
      const section = agent.settings.find(record => record.id === 'policy-deterministic-config')!.section;
      expect(section.scopeTargets).toEqual([{ scope: 'project', path: join(cwd, 'agent.config.json') }]);
      expect(() => section.read!(signal(), 'global')).toThrow(/只支持本项目/);
      await expect(section.draft!({ writeRoots: ['.'] }, signal(), 'global')).rejects.toThrow(/只支持本项目/);
      await expect(section.commit!({}, signal(), 'global')).rejects.toThrow(/只支持本项目/);
    } finally { await agent.dispose(); }
    write(globalPath, { provider: 'fake', pluginConfig: { 'agentlab.policy': { writeRoots: ['.'] } } });
    await expect(createAgent(cwd, { autoSaveSessions: false })).rejects.toThrow(/not allowed in global scope/);
  });

  it('普通对象是parse-only schema的保存边界，失败不建目录', () => {
    const path = join(home, 'new-parent', 'config.json'); const store = new PluginConfigStore(path); const base = store.read('demo');
    expect(() => store.commit('demo', base, {}, { schema: { parse: () => new Date() } })).toThrow(/普通对象/);
    expect(existsSync(dirname(path))).toBe(false);
  });
  it('writeRoots 异步校验期间取消 draft/commit 均不写盘', async () => {
    const cwd = project(); const path = join(cwd, 'agent.config.json');
    const agent = await createAgent(cwd, { config: { provider: 'fake' }, autoSaveSessions: false });
    try {
      const section = agent.settings.find(record => record.id === 'policy-deterministic-config')!.section;
      await section.read!(signal(), 'project');
      const drafting = new AbortController();
      const cancelledDraft = section.draft!({ writeRoots: [] }, drafting.signal, 'project'); drafting.abort();
      await expect(cancelledDraft).rejects.toMatchObject({ name: 'AbortError' });
      expect(existsSync(path)).toBe(false);
      const draft = await section.draft!({ writeRoots: [] }, signal(), 'project');
      const saving = new AbortController();
      const cancelledSave = section.commit!(draft, saving.signal, 'project'); saving.abort();
      await expect(cancelledSave).rejects.toMatchObject({ name: 'AbortError' });
      expect(existsSync(path)).toBe(false);
    } finally { await agent.dispose(); }
  });

  it('writeRoots 异步草稿绑定最初快照，重新读取不能偷换 CAS 基线', async () => {
    const cwd = project(); const path = join(cwd, 'agent.config.json');
    write(path, { provider: 'fake' });
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      const section = agent.settings.find(record => record.id === 'policy-deterministic-config')!.section;
      await section.read!(signal(), 'project');
      const pending = section.draft!({ writeRoots: [] }, signal(), 'project');
      write(path, { provider: 'fake', external: true });
      await section.read!(signal(), 'project');
      const draft = await pending;
      await expect(section.commit!(draft, signal(), 'project')).rejects.toThrow(/配置已变化/);
      expect(read(path)).toEqual({ provider: 'fake', external: true });
    } finally { await agent.dispose(); }
  });

});
