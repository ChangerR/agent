import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PluginConfigStore, ConfigConflictError } from '../src/runtime/config-store.js';
import { loadConfig } from '../src/core/config.js';
const dirs: string[] = [];
const dir = () => { const p = mkdtempSync(join(tmpdir(), 'plugin-config-')); dirs.push(p); return p; };
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
describe('插件配置保存和旧配置兼容', () => {
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
