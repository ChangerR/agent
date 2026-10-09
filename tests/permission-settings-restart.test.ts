/** 权限设置跨真实 CLI 进程重启验证；隔离 HOME，只使用 fake provider。 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionSettings, type PermissionSettingsPicker } from '../src/builtin/policy/tui.js';
import { createAgent, type Agent } from '../src/index.js';

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const tsxLoader = createRequire(import.meta.url).resolve('tsx');
let fixture: string;
let home: string;
let project: string;
let globalPath: string;
let projectPath: string;
const agents: Agent[] = [];
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'agent-permission-restart-'));
  home = join(fixture, 'home');
  project = join(fixture, 'project');
  mkdirSync(join(home, '.agent'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  globalPath = join(home, '.agent', 'config.json');
  projectPath = join(project, 'agent.config.json');
  json(globalPath, { provider: 'fake' });
  json(projectPath, {});
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.dispose()));
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

async function runCli(command = '/permissions', cwd = project) {
  // 不继承运行机器的凭据、配置注入或真实服务端点。
  const { stdout } = await exec(process.execPath, ['--import', tsxLoader, cliPath, '--command', command, '--json'], {
    cwd, env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH }, timeout: 10000,
  });
  return JSON.parse(stdout);
}

async function editor() {
  const agent = await createAgent(project);
  agents.push(agent);
  let picker!: PermissionSettingsPicker;
  const settings = createPermissionSettings({ agent,
    showPicker: value => { picker = value; },
    showInput: vi.fn(), showDetails: vi.fn(), notify: vi.fn(), onModeChange: vi.fn(),
  });
  const pick = (value: string) => {
    expect(picker.items.some(item => item.value === value), `Missing ${value} in ${picker.title}`).toBe(true);
    picker.onPick(value);
  };
  return { agent, settings, pick, get picker() { return picker; } };
}

describe('权限模式自动保存后跨进程重启', () => {
  it('帮助与无参数选择说明本项目自动保存，不执行额外确认', async () => {
    const h = await editor();
    expect(h.agent.commands.list().find(command => command.id === 'mode')?.description).toContain('自动保存');
    expect(await h.agent.dispatchCommand('/mode')).toMatchObject({ type: 'interaction', prompt: '选择本项目权限模式 · 自动保存并应用' });
    expect(h.agent.permission.mode).toBe('ask'); expect(readFileSync(projectPath, 'utf8')).toBe('{}');
  });

  it('/mode auto 保存到项目，新进程为 auto，全局不变', async () => {
    const globalBefore = readFileSync(globalPath, 'utf8');
    expect(await runCli('/mode auto')).toMatchObject({ type: 'text', text: expect.stringContaining('已保存本项目') });
    expect(readFileSync(globalPath, 'utf8')).toBe(globalBefore);
    expect(JSON.parse(readFileSync(projectPath, 'utf8')).permissionMode).toBe('auto');
    expect(await runCli()).toMatchObject({ type: 'data', data: { mode: 'auto' } });
  });

  it('headless yolo 直接保存并应用，无二次确认', async () => {
    const h = await editor(); expect(await h.agent.dispatchCommand('/mode yolo')).toMatchObject({ type: 'text' });
    expect(h.agent.permission.mode).toBe('yolo'); expect(await runCli()).toMatchObject({ data: { mode: 'yolo' } });
  });

  it('headless 模式选择只调用一次交互，取消不写，外部冲突不改当前模式', async () => {
    const h = await editor(); const interact = vi.fn(async () => 'auto'); await h.agent.dispatchCommand('/mode', { interact });
    expect(interact).toHaveBeenCalledOnce(); expect(h.agent.permission.mode).toBe('auto');
    const before = readFileSync(projectPath, 'utf8'); await h.agent.dispatchCommand('/mode', { interact: async () => undefined });
    expect(readFileSync(projectPath, 'utf8')).toBe(before);
    await expect(h.agent.dispatchCommand('/mode', { interact: async () => { json(projectPath, { permissionMode: 'ask' }); return 'yolo'; } })).rejects.toThrow(/其他程序修改/);
    expect(h.agent.permission.mode).toBe('auto'); expect(JSON.parse(readFileSync(projectPath, 'utf8')).permissionMode).toBe('ask');
  });

  it('headless 选择期间会话模式变化使回调失效', async () => {
    const h = await editor(); const before = readFileSync(projectPath, 'utf8');
    await expect(h.agent.dispatchCommand('/mode', { interact: async () => { h.agent.permission.setMode('yolo'); return 'auto'; } })).rejects.toThrow(/会话已变化/);
    expect(h.agent.permission.mode).toBe('yolo'); expect(readFileSync(projectPath, 'utf8')).toBe(before);
  });

  it('模式控制器提交后抛错，headless 准确报告已保存但未应用', async () => {
    const h = await editor(); vi.spyOn(h.agent.permission, 'setMode').mockImplementation(() => { throw new Error('private detail'); });
    await expect(h.agent.dispatchCommand('/mode auto')).rejects.toThrow('已保存，但当前策略应用失败');
    expect(JSON.parse(readFileSync(projectPath, 'utf8')).permissionMode).toBe('auto'); expect(h.agent.permission.mode).toBe('ask');
  });

  it('本项目直接选 auto 后立即生效，子目录重启仍为 auto，其他项目保持 ask', async () => {
    const h = await editor(); h.settings.open(); h.pick('mode'); h.pick('auto');
    expect(h.agent.permission.mode).toBe('auto');
    const nested = join(project, 'src', 'nested'); mkdirSync(nested, { recursive: true });
    expect(await runCli('/permissions', nested)).toMatchObject({ data: { mode: 'auto' } });
    const other = join(fixture, 'other-project'); mkdirSync(join(other, '.git'), { recursive: true });
    expect(await runCli('/permissions', other)).toMatchObject({ data: { mode: 'ask' } });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({ provider: 'fake' });
  });

  it('全局 auto 被项目 ask 覆盖，项目恢复继承后立即与重启一致', async () => {
    json(projectPath, { permissionMode: 'ask' });
    const projectBefore = readFileSync(projectPath, 'utf8'); const h = await editor();
    h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('auto');
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore); expect(h.agent.permission.mode).toBe('ask');
    expect(await runCli()).toMatchObject({ data: { mode: 'ask' } });
    h.pick('back'); h.pick('mode'); h.pick('inherit'); expect(h.agent.permission.mode).toBe('auto');
    expect(await runCli()).toMatchObject({ data: { mode: 'auto' } });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({ provider: 'fake', permissionMode: 'auto' });
  });
});
