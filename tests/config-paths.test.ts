/** 配置和状态使用临时用户目录；所有 runtime 都使用 fake provider，不访问网络。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, loadConfigWithSources } from '../src/core/config.js';
import { getGlobalConfigPath, resolveAgentPaths } from '../src/core/paths.js';
import { createAgent, sessionPath, saveSession, type Agent } from '../src/index.js';

const osFixture = vi.hoisted(() => ({ temporaryDirectory: undefined as string | undefined }));
vi.mock('node:os', async importOriginal => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, tmpdir: () => osFixture.temporaryDirectory ?? original.tmpdir() };
});

let fixture: string;
let home: string;
const agents: Agent[] = [];
function directory(path: string) { mkdirSync(path, { recursive: true }); return path; }
function json(path: string, value: unknown) { directory(dirname(path)); writeFileSync(path, JSON.stringify(value)); }
beforeEach(() => {
  osFixture.temporaryDirectory = undefined;
  fixture = mkdtempSync(join(tmpdir(), 'agent-paths-'));
  home = directory(join(fixture, 'home'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.dispose()));
  osFixture.temporaryDirectory = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});
async function runtime(cwd: string) {
  const agent = await createAgent(cwd, { autoSaveSessions: false }); agents.push(agent); return agent;
}

describe('统一项目身份和状态目录', () => {
  it.each(['directory', 'file'])('从任意子目录找到 Git 根（.git %s）', kind => {
    const project = directory(join(fixture, 'project'));
    const child = directory(join(project, 'src', 'nested'));
    if (kind === 'directory') directory(join(project, '.git'));
    else writeFileSync(join(project, '.git'), 'gitdir: /unused/worktree');
    json(join(project, 'agent.config.json'), { model: 'root-model' });
    const paths = resolveAgentPaths(child);
    expect(paths.projectRoot).toBe(project);
    expect(paths.cwd).toBe(child);
    expect(paths.projectId).toMatch(/^[a-f0-9]{64}$/);
    expect(paths.sessionsDir).toBe(join(home, '.agent', 'state', 'projects', paths.projectId, 'sessions'));
    expect(paths.logsDir).toBe(join(paths.projectStateDir, 'logs'));
    expect(resolveAgentPaths(project).projectId).toBe(paths.projectId);
    expect(loadConfig(child).model).toBe('root-model');
    expect(existsSync(paths.projectStateDir)).toBe(false);
  });
  it('非 Git 项目使用最近配置、package.json 或启动目录', () => {
    const project = directory(join(fixture, 'project'));
    const child = directory(join(project, 'nested', 'src'));
    expect(resolveAgentPaths(child).projectRoot).toBe(child);
    json(join(project, 'package.json'), {});
    expect(resolveAgentPaths(child).projectRoot).toBe(project);
    json(join(project, 'nested', 'agent.config.json'), {});
    expect(resolveAgentPaths(child).projectRoot).toBe(join(project, 'nested'));
  });
  it.each(['agent.config.json', 'package.json'])('内层 %s 边界不被外层 Git 吞掉', marker => {
    const outer = directory(join(fixture, 'outer')); directory(join(outer, '.git'));
    const inner = directory(join(outer, 'inner')); const child = directory(join(inner, 'src'));
    json(join(inner, marker), {});
    expect(resolveAgentPaths(child).projectRoot).toBe(inner);
    expect(resolveAgentPaths(outer).projectRoot).toBe(outer);
  });
  it.each(['home', 'tmp'])('上行不把 %s 目录的标记推断为子目录项目', kind => {
    const boundary = kind === 'home' ? home : directory(join(fixture, 'system-tmp'));
    if (kind === 'tmp') osFixture.temporaryDirectory = boundary;
    const child = directory(join(boundary, 'unrelated', 'working'));
    directory(join(boundary, '.git'));
    // 错误的祖先 JSON 不应被读取，也不能改变工作目录或模型。
    writeFileSync(join(boundary, 'agent.config.json'), '{not valid JSON');
    json(join(boundary, 'package.json'), {});
    expect(resolveAgentPaths(child).projectRoot).toBe(child);
    expect(loadConfig(child).model).toBe('claude-sonnet-4-5');
    // 显式在边界自身启动是调用方的选择。
    expect(resolveAgentPaths(boundary).projectRoot).toBe(boundary);
  });
  it('符号链接与真实路径共享身份，不同目录即使同名也相互隔离', () => {
    const project = directory(join(fixture, 'one', 'project'));
    const other = directory(join(fixture, 'two', 'project'));
    json(join(project, 'agent.config.json'), {});
    const linked = join(fixture, 'linked'); symlinkSync(project, linked, 'dir');
    expect(resolveAgentPaths(linked)).toEqual(resolveAgentPaths(project));
    expect(resolveAgentPaths(other).projectId).not.toBe(resolveAgentPaths(project).projectId);
  });
  it('导入模块后改变 HOME 仍使用新路径，不缓存旧的全局文件', () => {
    const project = directory(join(fixture, 'project'));
    json(getGlobalConfigPath(), { model: 'first' });
    expect(loadConfig(project).model).toBe('first');
    const nextHome = directory(join(fixture, 'next-home'));
    vi.stubEnv('HOME', nextHome); vi.stubEnv('USERPROFILE', nextHome);
    json(getGlobalConfigPath(), { model: 'second' });
    expect(getGlobalConfigPath()).toBe(join(nextHome, '.agent', 'config.json'));
    expect(loadConfig(project).model).toBe('second');
    expect(resolveAgentPaths(project).sessionsDir.startsWith(join(nextHome, '.agent'))).toBe(true);
  });
});

describe('配置层来源与相对路径', () => {
  it('默认模型/MCP 在用户目录，载入不创建配置或迁移项目旧文件', () => {
    const project = directory(join(fixture, 'project'));
    const old = join(project, '.agentlab', 'sessions', 'old.json'); json(old, { keep: true });
    const loaded = loadConfigWithSources(project);
    expect(loaded.config.modelsFile).toBe(join(home, '.agent', 'models.json'));
    expect(loaded.config.mcpConfig).toBe(join(home, '.agent', 'mcp.json'));
    expect(loaded.sources.modelsFile).toMatchObject({ scope: 'default', directory: join(home, '.agent') });
    expect(existsSync(loaded.paths.globalConfigPath)).toBe(false);
    expect(existsSync(loaded.paths.projectConfigPath)).toBe(false);
    expect(existsSync(loaded.paths.projectStateDir)).toBe(false);
    expect(readFileSync(old, 'utf8')).toBe('{"keep":true}');
  });
  it('各路径按声明层解析；项目数组替换，全局未覆盖路径继续指向全局', () => {
    const project = directory(join(fixture, 'project'));
    const child = directory(join(project, 'src'));
    const absolute = join(fixture, 'absolute-models.json');
    json(getGlobalConfigPath(), { provider: 'fake', model: 'global-model', modelsFile: absolute, mcpConfig: 'servers/global.json',
      pluginEntries: ['./plugins/global.mjs'], permissions: { allow: ['read_file'], deny: ['bash(rm *)'] },
      capabilities: { reviewer: false }, pluginConfig: { demo: { first: 1, keep: true } } });
    json(join(project, 'agent.config.json'), { model: 'project-model', pluginEntries: [{ entry: 'local.mjs', enabled: false }],
      permissions: { allow: ['glob'] }, pluginConfig: { demo: { first: 2 } } });
    const loaded = loadConfigWithSources(child);
    expect(loaded.config).toMatchObject({ model: 'project-model', modelsFile: absolute, mcpConfig: join(home, '.agent', 'servers', 'global.json'),
      pluginEntries: [{ entry: join(project, 'local.mjs'), enabled: false }],
      permissions: { allow: ['read_file', 'glob'], ask: [], deny: ['bash(rm *)'] }, capabilities: { reviewer: false }, pluginConfig: { demo: { first: 2, keep: true } } });
    expect(loaded.sources.pluginEntries).toMatchObject({ scope: 'project', path: join(project, 'agent.config.json') });
    expect(loaded.sources.permissions.contributors?.map(source => source.scope)).toEqual(['global', 'project']);
    const session = loadConfigWithSources(child, { modelsFile: 'override.json' });
    expect(session.config.modelsFile).toBe(join(project, 'override.json'));
    expect(session.sources.modelsFile.scope).toBe('session');
    const withOverride = loadConfigWithSources(child, { capabilities: { compactor: 'custom' }, pluginConfig: { demo: { third: 3 } } });
    expect(withOverride.config.capabilities).toEqual({ reviewer: false, compactor: 'custom' });
    expect(withOverride.config.pluginConfig.demo).toEqual({ first: 2, keep: true, third: 3 });
    expect(withOverride.sources.pluginConfig.contributors?.map(source => source.scope)).toEqual(['global', 'project', 'session']);
  });
  it('项目显式相对模型/MCP 覆盖全局配置，绝对入口保持绝对路径', () => {
    const project = directory(join(fixture, 'project')); const absolute = join(fixture, 'plugin.mjs');
    json(getGlobalConfigPath(), { modelsFile: 'global-models.json', mcpConfig: 'global-mcp.json' });
    json(join(project, 'agent.config.json'), { modelsFile: './local/models.json', mcpConfig: './local/mcp.json', pluginEntries: [absolute] });
    expect(loadConfig(project)).toMatchObject({ modelsFile: join(project, 'local', 'models.json'), mcpConfig: join(project, 'local', 'mcp.json'), pluginEntries: [absolute] });
  });
  it.each(['', 'project-judge'])('项目 judgeModel 覆盖全局且空值跟随主模型（%j）', value => {
    const project = directory(join(fixture, 'project'));
    json(getGlobalConfigPath(), { judgeModel: 'global-judge' });
    json(join(project, 'agent.config.json'), { judgeModel: value });
    expect(loadConfig(project).judgeModel).toBe(value);
    expect(loadConfigWithSources(project).sources.judgeModel.scope).toBe('project');
  });
});

describe('runtime 使用统一路径', () => {
  it('全局 plugins/models 真实加载；工具根、日志和会话跨子目录一致', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-09T00:00:00.000Z'));
    const project = directory(join(fixture, 'project'));
    const child = directory(join(project, 'src'));
    directory(join(project, '.git'));
    json(getGlobalConfigPath(), { provider: 'fake', model: 'fixture-model', modelsFile: './catalog.json', pluginEntries: ['./global-plugin.mjs'] });
    json(join(home, '.agent', 'catalog.json'), { 'fixture-model': { contextWindow: 10000, maxOutputTokens: 500 } });
    writeFileSync(join(home, '.agent', 'global-plugin.mjs'), 'export default { manifest: { id: "test.global-path", version: "1.0.0", apiVersion: 1 }, setup() {} };');
    const first = await runtime(child);
    expect(first.cwd).toBe(project); expect(first.paths.cwd).toBe(child);
    expect(first.modelInfo('fixture-model')).toEqual({ contextWindow: 10000, maxOutputTokens: 500 });
    expect(first.plugins.manifests.some(plugin => plugin.id === 'test.global-path')).toBe(true);
    expect(dirname(first.logPath)).toBe(first.paths.logsDir);
    await first.loop.run('hello'); await first.session.save();
    const path = sessionPath(project, first.session.id);
    expect(dirname(path)).toBe(first.paths.sessionsDir);
    expect(JSON.parse(readFileSync(path, 'utf8')).cwd).toBe(project);
    const second = await runtime(project);
    await expect(second.session.resume(first.session.id)).resolves.toMatchObject({ id: first.session.id });
    // 公共 SDK 保存的 cwd 也可以是同项目子目录或符号链接，恢复校验与存储身份一致。
    const file = JSON.parse(readFileSync(path, 'utf8'));
    await saveSession({ ...file, id: 'sdk-subdir', cwd: child, revision: 0 });
    await expect(second.session.resume('sdk-subdir')).resolves.toMatchObject({ id: 'sdk-subdir' });
    const alias = join(fixture, 'linked-project'); symlinkSync(project, alias, 'dir');
    await saveSession({ ...file, id: 'sdk-symlink', cwd: join(alias, 'src'), revision: 0 });
    await expect(second.session.resume('sdk-symlink')).resolves.toMatchObject({ id: 'sdk-symlink' });
    expect(second.logPath).not.toBe(first.logPath);
    expect(existsSync(join(project, '.agentlab'))).toBe(false);
    expect(existsSync(join(project, 'agent.config.json'))).toBe(false);
  });
});
