/** 权限设置跨真实 CLI 进程重启验证；隔离 HOME，只使用 fake provider。 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionSettings, type PermissionSettingsPicker } from '../src/cli/permission-settings.js';
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

describe('权限模式跨进程重启', () => {
  it('命令帮助与无参数选择明确标注会话范围和默认设置的保存入口', async () => {
    const h = await editor();
    expect(h.agent.commands.list().find(command => command.id === 'mode')?.description)
      .toBe('切换本次会话权限模式；启动默认请在 /permissions 本项目/全局设置中 Save');
    expect(await h.agent.dispatchCommand('/mode')).toMatchObject({ type: 'interaction', prompt: '选择本次会话权限模式' });
    expect(h.agent.permission.mode).toBe('ask');
  });

  it('/mode auto 只改变该进程的会话，不静默写入项目或全局默认', async () => {
    const globalBefore = readFileSync(globalPath, 'utf8');
    const projectBefore = readFileSync(projectPath, 'utf8');
    expect(await runCli('/mode auto')).toEqual({ type: 'text', text: '本次会话权限模式: auto。如需作为启动默认，请在 /permissions 的本项目或全局默认设置中 Save。' });
    expect(readFileSync(globalPath, 'utf8')).toBe(globalBefore);
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore);
    expect(await runCli()).toMatchObject({ type: 'data', data: { mode: 'ask' } });
  });

  it('全局草稿取消与放弃不落盘；明确 Save 后新进程使用 auto', async () => {
    const h = await editor();
    const before = readFileSync(globalPath, 'utf8');
    h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('auto');
    h.pick('save'); h.pick('cancel');
    expect(readFileSync(globalPath, 'utf8')).toBe(before);
    h.pick('back'); h.pick('confirm');
    expect(await runCli()).toMatchObject({ data: { mode: 'ask' } });
    h.pick('global'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('confirm');
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({ provider: 'fake', permissionMode: 'auto' });
    expect(readFileSync(projectPath, 'utf8')).toBe('{}');
    expect(h.agent.permission.mode).toBe('ask');
    await h.agent.dispose();
    expect(await runCli()).toMatchObject({ data: { mode: 'auto' } });
  });

  it('本项目 Save 在子目录重启仍生效，其他项目继续继承全局默认', async () => {
    const h = await editor();
    h.settings.open(); h.pick('project'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('confirm');
    expect(h.agent.permission.mode).toBe('ask');
    await h.agent.dispose();
    const nested = join(project, 'src', 'nested'); mkdirSync(nested, { recursive: true });
    expect(await runCli('/permissions', nested)).toMatchObject({ data: { mode: 'auto' } });
    const other = join(fixture, 'other-project'); mkdirSync(join(other, '.git'), { recursive: true });
    expect(await runCli('/permissions', other)).toMatchObject({ data: { mode: 'ask' } });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({ provider: 'fake' });
  });

  it.each(['legacy', 'namespace'])('全局 auto 被项目 %s ask 覆盖；项目明确恢复继承并 Save 后重启为 auto', async representation => {
    json(projectPath, representation === 'legacy' ? { permissionMode: 'ask' }
      : { pluginConfig: { 'agentlab.policy-legacy': { permissionMode: 'ask' } } });
    const projectBefore = readFileSync(projectPath, 'utf8');
    const h = await editor();
    h.settings.open(); h.pick('global'); h.pick('mode'); h.pick('auto'); h.pick('save'); h.pick('confirm');
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore);
    expect(await runCli()).toMatchObject({ data: { mode: 'ask' } });
    h.pick('back'); h.pick('project'); h.pick('mode'); h.pick('inherit'); h.pick('save'); h.pick('confirm');
    await h.agent.dispose();
    expect(await runCli()).toMatchObject({ data: { mode: 'auto' } });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({ provider: 'fake', permissionMode: 'auto' });
  });
});
