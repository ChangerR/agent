import { writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginConfigStore, ConfigConflictError } from '../src/runtime/config-store.js';
import { loadConfig } from '../src/core/config.js';
import { createAgent } from '../src/index.js';
import { mkdtempProjectSync } from './helpers/project.js';
const dirs: string[] = [];
const dir = () => { const p = mkdtempProjectSync(join(tmpdir(), 'plugin-config-')); dirs.push(p); return p; };
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
describe('插件配置保存和旧配置兼容', () => {
  it('仅有 parse 的 schema 通过 ownedFields 删除可选字段，保留未知字段和其他命名空间', () => {
    const path = join(dir(), 'agent.config.json');
    writeFileSync(path, JSON.stringify({ unknownRoot: true, capabilities: { reviewer: 'model-v2' }, pluginConfig: {
      demo: { provider: 'fixed', count: 1, future: { keep: ['unknown'] } }, another: { provider: 'unchanged' },
    } }));
    const store = new PluginConfigStore(path); const base = store.read('demo'); const stale = store.read('demo');
    const definition = {
      schema: { parse(raw: unknown) { const value = raw as { count: number; provider?: string }; return { count: value.count, ...(value.provider === undefined ? {} : { provider: value.provider }) }; } },
      ownedFields: ['provider', 'count'],
    };
    const saved = store.commit('demo', base, { count: 2 }, definition);
    expect(saved.value).toEqual({ count: 2, future: { keep: ['unknown'] } });
    expect(store.read('demo').value).toEqual(saved.value);
    const expected = { unknownRoot: true, capabilities: { reviewer: 'model-v2' }, pluginConfig: { demo: saved.value, another: { provider: 'unchanged' } } };
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
    expect(() => store.commit('demo', stale, { count: 3, provider: 'stale' }, definition)).toThrow(ConfigConflictError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
  });
  it('未声明 ownedFields 的旧配置提交保留补丁语义', () => {
    const path = join(dir(), 'agent.config.json'); writeFileSync(path, JSON.stringify({ pluginConfig: { demo: { count: 1, provider: 'fixed' } } }));
    const store = new PluginConfigStore(path);
    expect(store.commit('demo', store.read('demo'), { count: 2 }).value).toEqual({ count: 2, provider: 'fixed' });
  });
  it('ownedFields 中的 undefined 从快照和文件删除，schema 默认值仍保存', () => {
    const path = join(dir(), 'agent.config.json'); writeFileSync(path, JSON.stringify({ pluginConfig: { demo: { provider: 'fixed', count: 1, future: true } } }));
    const store = new PluginConfigStore(path);
    const saved = store.commit('demo', store.read('demo'), {}, {
      schema: { parse() { return { provider: undefined, count: 7 }; } }, ownedFields: ['provider', 'count'],
    });
    expect(saved.value).toEqual({ count: 7, future: true }); expect(saved.value).not.toHaveProperty('provider');
    expect(store.read('demo').value).toEqual(saved.value);
  });
  it('严格 reviewer 保存删除 provider/model 后重新打开及重启都保持继承', async () => {
    const cwd = dir(); const path = join(cwd, 'agent.config.json'); const signal = new AbortController().signal;
    writeFileSync(path, JSON.stringify({ provider: 'fake', model: 'main-model', capabilities: { reviewer: 'model-v2' }, pluginConfig: {
      'agentlab.reviewer-strict': { provider: 'fake', model: 'fixed-model', future: { keep: true } }, another: { untouched: true },
    } }));
    let agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      const section = agent.settings.find(entry => entry.id === 'reviewer-strict-config')!.section;
      const value = await section.read!(signal) as Record<string, unknown>;
      expect(value).toMatchObject({ provider: 'fake', model: 'fixed-model' });
      delete value.provider; delete value.model;
      const draft = await section.draft!(value, signal); await section.commit!(draft, signal);
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      expect(raw.pluginConfig['agentlab.reviewer-strict']).not.toHaveProperty('provider');
      expect(raw.pluginConfig['agentlab.reviewer-strict']).not.toHaveProperty('model');
      expect(raw.pluginConfig).toMatchObject({ 'agentlab.reviewer-strict': { future: { keep: true } }, another: { untouched: true } });
      const reopened = await section.read!(signal);
      expect(reopened).not.toHaveProperty('provider'); expect(reopened).not.toHaveProperty('model');
      expect(agent.loop.getJudgeStatus()).toMatchObject({ providerSource: 'explicit', model: 'fixed-model' });
      await agent.dispose(); agent = await createAgent(cwd, { autoSaveSessions: false });
      expect(agent.loop.getJudgeStatus()).toMatchObject({ provider: 'fake', providerSource: 'current', model: 'main-model', source: 'current' });
    } finally { await agent.dispose(); }
  });
  it('草稿独立、CAS 冲突保留原文件和未知字段', () => {
    const path = join(dir(), 'agent.config.json');
    writeFileSync(path, JSON.stringify({ unrelated: { keep: true }, pluginConfig: { demo: { count: 1 }, another: { keep: 2 } } }));
    const store = new PluginConfigStore(path); const a = store.read('demo'); const b = store.read('demo');
    const saved = store.commit('demo', a, { count: 2 }, { schema: z.object({ count: z.number().int() }) });
    expect(saved.revision).not.toBe(a.revision);
    expect(() => store.commit('demo', b, { count: 3 })).toThrow(ConfigConflictError);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ unrelated: { keep: true }, pluginConfig: { demo: { count: 2 }, another: { keep: 2 } } });
  });
  it('schema 失败不写入，敏感字段只接受引用', () => {
    const path = join(dir(), 'agent.config.json'); writeFileSync(path, '{}');
    const store = new PluginConfigStore(path); const base = store.read('demo');
    expect(() => store.commit('demo', base, { count: 'bad' }, { schema: z.object({ count: z.number() }) })).toThrow();
    expect(() => store.commit('demo', base, { key: 'plaintext' }, { sensitiveFields: ['key'] })).toThrow();
    store.commit('demo', base, { key: 'env:TEST_KEY' }, { sensitiveFields: ['key'] });
    expect(readFileSync(path, 'utf8')).not.toContain('plaintext');
  });
  it('符号链接配置被拒绝，原目标不变', () => {
    const cwd = dir(); const target = join(cwd, 'target.json'); const path = join(cwd, 'agent.config.json');
    writeFileSync(target, '{}'); symlinkSync(target, path);
    expect(() => new PluginConfigStore(path).read('demo')).toThrow(/普通文件/);
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });
  it.each([undefined, '', 'fixed-model'])('judgeModel 三态在新旧命名空间之间保持 %j', value => {
    const cwd = dir(); writeFileSync(join(cwd, 'agent.config.json'), JSON.stringify({ pluginConfig: { 'agentlab.reviewer-model': { judgeModel: value } } }));
    expect(loadConfig(cwd).judgeModel).toBe(value);
  });
  it('新旧值冲突明确报错，启动不改文件', () => {
    const cwd = dir(); const path = join(cwd, 'agent.config.json'); const source = JSON.stringify({ judgeModel: 'old', pluginConfig: { 'agentlab.reviewer-model': { judgeModel: 'new' } } }); writeFileSync(path, source);
    expect(() => loadConfig(cwd)).toThrow(/Configuration conflict/); expect(readFileSync(path, 'utf8')).toBe(source);
  });
});
