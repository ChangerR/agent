/** 权限设置跨真实 CLI 进程重启验证；隔离 HOME，只使用 fake provider。 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPermissionSettings,
  type PermissionSettingsPicker,
} from '../src/builtin/policy/tui.js';
import { createAgent, type Agent } from './helpers/trusted-agent.js';

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
  mkdirSync(join(home, '.agentlab'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  globalPath = join(home, '.agentlab', 'config.json');
  projectPath = join(project, 'agent.config.json');
  json(globalPath, { provider: 'fake' });
  json(projectPath, {});
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.unstubAllEnvs();
  rmSync(fixture, { recursive: true, force: true });
});

async function runCli(command = '/permissions', cwd = project) {
  // 不继承运行机器的凭据、配置注入或真实服务端点。
  const { stdout } = await exec(
    process.execPath,
    ['--import', tsxLoader, cliPath, '--command', command, '--json'],
    {
      cwd,
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH },
      timeout: 10000,
    },
  );
  return JSON.parse(stdout);
}

async function editor() {
  const agent = await createAgent(project);
  agents.push(agent);
  let picker!: PermissionSettingsPicker;
  const settings = createPermissionSettings({
    agent,
    showPicker: (value) => {
      picker = value;
    },
    showInput: vi.fn(),
    showDetails: vi.fn(),
    notify: vi.fn(),
    onModeChange: vi.fn(),
  });
  const pick = (value: string) => {
    expect(
      picker.items.some((item) => item.value === value),
      `Missing ${value} in ${picker.title}`,
    ).toBe(true);
    picker.onPick(value);
  };
  return {
    agent,
    settings,
    pick,
    get picker() {
      return picker;
    },
  };
}

describe('权限模式自动保存后跨进程重启', () => {
  it('帮助与无参数选择说明全局自动保存，不执行额外确认', async () => {
    const h = await editor();
    expect(h.agent.commands.list().find((command) => command.id === 'mode')?.description).toContain(
      '自动保存',
    );
    expect(await h.agent.dispatchCommand('/mode')).toMatchObject({
      type: 'interaction',
      prompt: '选择全局权限模式 · 自动保存并应用',
    });
    expect(h.agent.permission.mode).toBe('ask');
    expect(readFileSync(projectPath, 'utf8')).toBe('{}');
  });

  it('/mode auto 保存到全局，新进程为 auto，项目不变', async () => {
    const projectBefore = readFileSync(projectPath, 'utf8');
    expect(await runCli('/mode auto')).toMatchObject({
      type: 'text',
      text: expect.stringContaining('已保存到全局配置'),
    });
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore);
    expect(JSON.parse(readFileSync(globalPath, 'utf8')).permissionMode).toBe('auto');
    expect(await runCli()).toMatchObject({ type: 'data', data: { mode: 'auto' } });
  });

  it('headless yolo 直接保存并应用，无二次确认', async () => {
    const h = await editor();
    expect(await h.agent.dispatchCommand('/mode yolo')).toMatchObject({ type: 'text' });
    expect(h.agent.permission.mode).toBe('yolo');
    expect(await runCli()).toMatchObject({ data: { mode: 'yolo' } });
  });

  it('headless 模式选择只调用一次交互，取消不写，外部冲突不改当前模式', async () => {
    const h = await editor();
    const interact = vi.fn(async () => 'auto');
    await h.agent.dispatchCommand('/mode', { interact });
    expect(interact).toHaveBeenCalledOnce();
    expect(h.agent.permission.mode).toBe('auto');
    const before = readFileSync(globalPath, 'utf8');
    await h.agent.dispatchCommand('/mode', { interact: async () => undefined });
    expect(readFileSync(globalPath, 'utf8')).toBe(before);
    await expect(
      h.agent.dispatchCommand('/mode', {
        interact: async () => {
          json(globalPath, { permissionMode: 'ask' });
          return 'yolo';
        },
      }),
    ).rejects.toThrow(/其他程序修改|当前会话已变化/);
    expect(h.agent.permission.mode).toBe('ask');
    expect(JSON.parse(readFileSync(globalPath, 'utf8')).permissionMode).toBe('ask');
  });

  it('headless 选择期间会话模式变化使回调失效', async () => {
    const h = await editor();
    await expect(
      h.agent.dispatchCommand('/mode', {
        interact: async () => {
          h.agent.permission.setMode('yolo');
          return 'auto';
        },
      }),
    ).rejects.toThrow(/会话已变化/);
    expect(h.agent.permission.mode).toBe('yolo');
    expect(JSON.parse(readFileSync(globalPath, 'utf8')).permissionMode).toBe('yolo');
  });

  it('模式控制器提交后抛错，headless 准确报告已保存但未应用', async () => {
    const h = await editor();
    vi.spyOn(h.agent.permission, 'setMode').mockImplementation(() => {
      throw new Error('private detail');
    });
    await expect(h.agent.dispatchCommand('/mode auto')).rejects.toThrow(
      '已保存，但当前策略应用失败',
    );
    expect(JSON.parse(readFileSync(globalPath, 'utf8')).permissionMode).toBe('auto');
    expect(h.agent.permission.mode).toBe('auto');
  });

  it('本项目直接选 auto 后立即生效，子目录重启仍为 auto，其他项目同样为 auto', async () => {
    const h = await editor();
    h.settings.open();
    h.pick('mode');
    h.pick('auto');
    expect(h.agent.permission.mode).toBe('auto');
    const nested = join(project, 'src', 'nested');
    mkdirSync(nested, { recursive: true });
    expect(await runCli('/permissions', nested)).toMatchObject({ data: { mode: 'auto' } });
    const other = join(fixture, 'other-project');
    mkdirSync(join(other, '.git'), { recursive: true });
    expect(await runCli('/permissions', other)).toMatchObject({ data: { mode: 'auto' } });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({
      provider: 'fake',
      permissionMode: 'auto',
    });
  });

  it('项目旧 ask 不影响全局 auto，当前与重启都采用全局值', async () => {
    json(projectPath, { permissionMode: 'ask' });
    const projectBefore = readFileSync(projectPath, 'utf8');
    const h = await editor();
    h.settings.open();
    h.pick('global');
    h.pick('mode');
    h.pick('auto');
    expect(readFileSync(projectPath, 'utf8')).toBe(projectBefore);
    expect(h.agent.permission.mode).toBe('auto');
    expect(await runCli()).toMatchObject({ data: { mode: 'auto' } });
    expect(JSON.parse(readFileSync(globalPath, 'utf8'))).toEqual({
      provider: 'fake',
      permissionMode: 'auto',
    });
  });

  it('已打开的其他项目在下一次权限检查时也使用最新全局模式', async () => {
    const other = join(fixture, 'other');
    mkdirSync(join(other, '.git'), { recursive: true });
    const a = await createAgent(other);
    agents.push(a);
    expect(a.permission.mode).toBe('ask');
    await runCli('/mode auto');
    expect(a.permission.mode).toBe('auto');
  });
});
