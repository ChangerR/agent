import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, chmodSync, statSync, symlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPermissionDraft, readPermissionConfig, readProjectPermissionConfig, readGlobalPermissionConfig, savePermissionConfig, saveProjectPermissionConfig, validatePermissionRule } from '../src/core/permission-config.js';

import { PluginConfigStore } from '../src/runtime/config-store.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

const dirs: string[] = [];
const project = () => { const dir = mkdtempSync(join(tmpdir(), 'agent-permissions-config-')); dirs.push(dir); mkdirSync(join(dir, '.git')); return { dir, path: join(dir, 'agent.config.json') }; };
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('权限配置的安全草稿保存', () => {
  it('全局读取不创建目录；明确提交才创建0700目录/0600文件，不提升未编辑的默认值', () => {
    const { dir } = project(); const path = join(dir, 'home', '.agent', 'config.json');
    const snapshot = readGlobalPermissionConfig(path);
    expect(snapshot).toMatchObject({ scope: 'global', exists: false, permissionMode: undefined, judgeModel: undefined });
    expect(existsSync(join(dir, 'home'))).toBe(false);
    const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'auto';
    expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('范围不匹配');
    const saved = savePermissionConfig(snapshot, draft);
    expect(saved.scope).toBe('global');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissionMode: 'auto' });
    expect(statSync(join(dir, 'home', '.agent')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('项目草稿从规范项目根读取，子目录和符号链接入口写回同一配置', () => {
    const { dir, path } = project(); const nested = join(dir, 'src', 'nested'); mkdirSync(nested, { recursive: true });
    const alias = join(dir, 'alias'); symlinkSync(nested, alias);
    writeFileSync(path, '{"permissionMode":"ask"}');
    const snapshot = readProjectPermissionConfig(alias);
    expect(snapshot.path).toBe(path);
    const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'auto'; savePermissionConfig(snapshot, draft);
    expect(JSON.parse(readFileSync(path, 'utf8')).permissionMode).toBe('auto');
    expect(existsSync(join(nested, 'agent.config.json'))).toBe(false);
  });

  it('namespace别名按原始层编辑并保留未知字段，optional删除不留下旧值', () => {
    const { path } = project();
    writeFileSync(path, JSON.stringify({ custom: { keep: true }, pluginConfig: {
      'agentlab.policy-legacy': { permissionMode: 'yolo', permissions: { allow: ['glob'], custom: 'keep-rule-metadata' }, unknown: 7 },
      'agentlab.reviewer-model': { judgeModel: 'reviewer', unknown: true },
      'agentlab.policy-deterministic-v2': { writeRoots: ['build'] },
    } }));
    const snapshot = readGlobalPermissionConfig(path);
    expect(snapshot).toMatchObject({ permissionMode: 'yolo', judgeModel: 'reviewer', permissions: { allow: ['glob'] } });
    expect(JSON.stringify(snapshot)).not.toContain('writeRoots');
    const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'ask'; draft.judgeModel = undefined; draft.permissions.deny.push('bash(rm *)');
    const saved = savePermissionConfig(snapshot, draft);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw).not.toHaveProperty('permissionMode'); expect(raw).not.toHaveProperty('permissions'); expect(raw).not.toHaveProperty('judgeModel');
    expect(raw.pluginConfig['agentlab.policy-legacy']).toMatchObject({ permissionMode: 'ask', permissions: { allow: ['glob'], deny: ['bash(rm *)'], custom: 'keep-rule-metadata' }, unknown: 7 });
    expect(raw.pluginConfig['agentlab.reviewer-model']).toEqual({ unknown: true });
    expect(raw.pluginConfig['agentlab.policy-deterministic-v2']).toEqual({ writeRoots: ['build'] });
    expect(raw.custom).toEqual({ keep: true });
    expect(readGlobalPermissionConfig(path).permissionMode).toBe(saved.permissionMode);
  });

  it('同值新旧别名同步编辑或删除；冲突和无效namespace值拒绝读取', () => {
    const { path } = project();
    writeFileSync(path, JSON.stringify({ permissionMode: 'auto', judgeModel: 'reviewer', pluginConfig: {
      'agentlab.policy-legacy': { permissionMode: 'auto' }, 'agentlab.reviewer-model': { judgeModel: 'reviewer' },
    } }));
    const snapshot = readGlobalPermissionConfig(path); const draft = copyPermissionDraft(snapshot);
    draft.permissionMode = 'ask'; draft.judgeModel = undefined; savePermissionConfig(snapshot, draft);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.permissionMode).toBe('ask'); expect(raw.pluginConfig['agentlab.policy-legacy'].permissionMode).toBe('ask');
    expect(raw).not.toHaveProperty('judgeModel'); expect(raw.pluginConfig['agentlab.reviewer-model']).not.toHaveProperty('judgeModel');
    raw.pluginConfig['agentlab.policy-legacy'].permissionMode = 'yolo'; writeFileSync(path, JSON.stringify(raw));
    expect(() => readGlobalPermissionConfig(path)).toThrow('有效');
    writeFileSync(path, JSON.stringify({ pluginConfig: { 'agentlab.policy-legacy': { permissions: { allow: ['invalid rule'] } } } }));
    expect(() => readGlobalPermissionConfig(path)).toThrow('有效');
    writeFileSync(path, JSON.stringify({ pluginConfig: { 'agentlab.policy-legacy': { permissionMode: null } } }));
    expect(() => readGlobalPermissionConfig(path)).toThrow('有效');
  });

  it('相同权限别名允许字段顺序不同；只改全局mode不补写空默认规则', () => {
    const { path } = project();
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['read_file'], deny: ['bash'] }, pluginConfig: {
      'agentlab.policy-legacy': { permissions: { deny: ['bash'], allow: ['read_file'] } },
    } }));
    const snapshot = readGlobalPermissionConfig(path); const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'auto';
    savePermissionConfig(snapshot, draft);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.permissions).toEqual({ allow: ['read_file'], deny: ['bash'] });
    expect(raw.pluginConfig['agentlab.policy-legacy'].permissions).toEqual({ allow: ['read_file'], deny: ['bash'] });
    expect(raw).not.toHaveProperty('judgeModel');
  });

  it('已提交全局快照不与旧草稿共享数组，后续mode保存不能带入旧草稿的额外规则', () => {
    const { path } = project(); writeFileSync(path, '{}');
    const first = readGlobalPermissionConfig(path); const draft = copyPermissionDraft(first); draft.permissions.allow.push('glob');
    const saved = savePermissionConfig(first, draft);
    draft.permissions.allow.push('write_file');
    const second = copyPermissionDraft(saved); second.permissionMode = 'auto'; savePermissionConfig(saved, second);
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions.allow).toEqual(['glob']);
  });

  it('权限与插件编辑器使用同一保存锁，并拒绝对方提交后的陈旧快照', () => {
    const { path } = project(); writeFileSync(path, '{}');
    const permissions = readGlobalPermissionConfig(path); const draft = copyPermissionDraft(permissions); draft.permissionMode = 'auto';
    const store = new PluginConfigStore(path); const plugin = store.read('test');
    writeFileSync(`${path}.settings.lock`, '');
    expect(() => savePermissionConfig(permissions, draft)).toThrow('保存锁');
    expect(() => store.commit('test', plugin, { enabled: true })).toThrow('保存');
    rmSync(`${path}.settings.lock`);
    store.commit('test', plugin, { enabled: true });
    expect(() => savePermissionConfig(permissions, draft)).toThrow('其他程序修改');
    const newerPlugin = store.read('test');
    savePermissionConfig(readGlobalPermissionConfig(path), draft);
    expect(() => store.commit('test', newerPlugin, { enabled: false })).toThrow('变化');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ permissionMode: 'auto', pluginConfig: { test: { enabled: true } } });
  });

  it('保留未知顶层/嵌套字段、已有权限和文件模式，只写明确的草稿字段', () => {
    const { dir, path } = project();
    writeFileSync(path, JSON.stringify({ permissionMode: 'ask', baseURL: 'https://example.invalid', customSecret: 'never-display-me', custom: { enabled: true }, permissions: { allow: ['read_file'], customPolicy: { v: 3 } } }));
    chmodSync(path, 0o640);
    const snapshot = readProjectPermissionConfig(dir);
    expect(JSON.stringify(snapshot)).not.toContain('never-display-me');
    const draft = copyPermissionDraft(snapshot);
    draft.permissionMode = 'auto'; draft.judgeModel = 'review-model'; draft.permissions.deny.push('bash(rm *)');
    const saved = saveProjectPermissionConfig(snapshot, draft);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw).toMatchObject({ permissionMode: 'auto', judgeModel: 'review-model', customSecret: 'never-display-me', custom: { enabled: true }, permissions: { allow: ['read_file'], deny: ['bash(rm *)'], customPolicy: { v: 3 } } });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(saved.permissionMode).toBe('auto');
    expect(snapshot.permissionMode).toBe('ask');
    expect(readdirSync(dir).filter(name => name !== '.git')).toEqual(['agent.config.json']);
    const second = copyPermissionDraft(saved); second.permissionMode = 'yolo';
    expect(saveProjectPermissionConfig(saved, second).permissionMode).toBe('yolo');
  });

  it('新文件默认 0600，删除项目覆盖表示继承，空审批模型可明确关闭', () => {
    const { dir, path } = project(); const snapshot = readProjectPermissionConfig(dir);
    expect(snapshot.exists).toBe(false);
    const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'auto'; draft.judgeModel = '';
    const saved = saveProjectPermissionConfig(snapshot, draft);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const next = copyPermissionDraft(saved); next.permissionMode = undefined; next.judgeModel = undefined;
    saveProjectPermissionConfig(saved, next);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ permissions: { allow: [], ask: [], deny: [] } });
  });

  it('检测外部字节变更、文件新建、删除与另一保存锁，不覆盖外部文件', () => {
    const { dir, path } = project(); writeFileSync(path, '{}');
    const snapshot = readProjectPermissionConfig(dir); const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'yolo';
    writeFileSync(path, '{ "provider": "fake" }');
    expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('其他程序修改');
    expect(readFileSync(path, 'utf8')).toBe('{ "provider": "fake" }');
    rmSync(path); expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('其他程序修改');
    const missing = readProjectPermissionConfig(dir); writeFileSync(path, '{}');
    expect(() => saveProjectPermissionConfig(missing, draft)).toThrow('其他程序修改');
    writeFileSync(`${path}.settings.lock`, '');
    expect(() => saveProjectPermissionConfig(readProjectPermissionConfig(dir), draft)).toThrow('保存锁');
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });

  it('拒绝符号链接、非普通文件与含秘密的无效 JSON，错误不会泄漏内容', () => {
    const { dir, path } = project(); const target = join(dir, 'target'); writeFileSync(target, '{}'); symlinkSync(target, path);
    expect(() => readProjectPermissionConfig(dir)).toThrow('不是普通文件'); rmSync(path); mkdirSync(path);
    expect(() => readProjectPermissionConfig(dir)).toThrow('不是普通文件'); rmSync(path, { recursive: true });
    writeFileSync(path, '{"secret":"sensitive-secret-value" INVALID}');
    try { readProjectPermissionConfig(dir); throw new Error('unexpected'); } catch (error) { expect(String(error)).not.toContain('sensitive-secret-value'); expect(String(error)).toContain('有效'); }
    writeFileSync(path, '[]'); expect(() => readPermissionConfig(path)).toThrow('有效');
  });

  it('rename 或 fsync 失败时原始字节不变，清理临时文件/锁，保留可重试的草稿', () => {
    const { dir, path } = project(); writeFileSync(path, '{ "permissionMode": "ask" }');
    const snapshot = readProjectPermissionConfig(dir); const draft = copyPermissionDraft(snapshot); draft.permissionMode = 'auto';
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('SECRET IO DETAILS'); });
    expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('草稿已保留');
    expect(readFileSync(path, 'utf8')).toBe('{ "permissionMode": "ask" }'); expect(readdirSync(dir).filter(name => name !== '.git')).toEqual(['agent.config.json']);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('SECRET IO DETAILS'); });
    expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('草稿已保留');
    expect(readFileSync(path, 'utf8')).toBe('{ "permissionMode": "ask" }'); expect(readdirSync(dir).filter(name => name !== '.git')).toEqual(['agent.config.json']);
    expect(saveProjectPermissionConfig(snapshot, draft).permissionMode).toBe('auto');
  });

  it('提交前重新校验，不接受无效规则或空文本/控制序列', () => {
    const { dir, path } = project(); writeFileSync(path, '{}'); const snapshot = readProjectPermissionConfig(dir); const draft = copyPermissionDraft(snapshot);
    expect(validatePermissionRule('bash(="npm test")')).toBeUndefined();
    expect(validatePermissionRule('  ')).toBeTruthy(); expect(validatePermissionRule('read_file\x1b[2J')).toBeTruthy();
    draft.permissions.allow.push('invalid rule'); expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('规则无效');
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });
});
