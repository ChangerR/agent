import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, chmodSync, statSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPermissionDraft, readPermissionConfig, readProjectPermissionConfig, saveProjectPermissionConfig, validatePermissionRule } from '../src/core/permission-config.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) };
});

const dirs: string[] = [];
const project = () => { const dir = mkdtempSync(join(tmpdir(), 'agent-permissions-config-')); dirs.push(dir); return { dir, path: join(dir, 'agent.config.json') }; };
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('权限配置的安全草稿保存', () => {
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
    expect(readdirSync(dir)).toEqual(['agent.config.json']);
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
    writeFileSync(`${path}.permissions.lock`, '');
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
    expect(readFileSync(path, 'utf8')).toBe('{ "permissionMode": "ask" }'); expect(readdirSync(dir)).toEqual(['agent.config.json']);
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error('SECRET IO DETAILS'); });
    expect(() => saveProjectPermissionConfig(snapshot, draft)).toThrow('草稿已保留');
    expect(readFileSync(path, 'utf8')).toBe('{ "permissionMode": "ask" }'); expect(readdirSync(dir)).toEqual(['agent.config.json']);
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
