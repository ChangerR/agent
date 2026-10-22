import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopController } from '../desktop/worker/controller.js';
import { actionSchema } from '../desktop/shared/protocol.js';
import { createAgent, type Agent } from '../src/index.js';
import { desktopMenu, platformWindowOptions } from '../desktop/main/platform.js';

let root: string, cwd: string, home: string, controller: DesktopController, agent: Agent;
const latest = () => controller.snapshot!;
const send = (action: Record<string, unknown>) =>
  controller.handle({ ...action, generation: latest().generation, sessionId: latest().sessionId });
const readSettings = (sectionId = 'configuration-connection', scope = 'project') =>
  send({ type: 'settings-read', sectionId, scope });
const commit = (value: unknown, editorId = latest().settingsEditor!.id) =>
  send({ type: 'settings-commit', editorId, json: JSON.stringify(value) });
const file = () => join(cwd, 'agent.config.json');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-settings-'));
  cwd = join(root, '中文 project');
  home = join(root, 'home');
  await mkdir(cwd);
  await writeFile(join(cwd, 'README.md'), '# Settings demo');
  await mkdir(home);
  await mkdir(join(home, '.agent'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  controller = new DesktopController(
    () => {},
    async (cwd, options) => {
      agent = await createAgent(cwd, options);
      return agent;
    },
  );
  await controller.initialize(cwd, true, randomUUID());
});
afterEach(async () => {
  await controller.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('App 设置协议 / worker 与真实 runtime', () => {
  it('只读打开不写默认；保存用户层不复制项目层、当前运行值不被启动默认覆盖', async () => {
    await readSettings();
    expect(latest().settingsEditor!.value).toEqual({});
    await expect(access(file())).rejects.toThrow();
    await writeFile(
      file(),
      JSON.stringify({ provider: 'fake', model: 'project-model', unknown: true }),
    );
    await readSettings('configuration-connection', 'global');
    expect(latest().settingsEditor!.value).toEqual({});
    await commit({ provider: 'fake', model: 'global-model' });
    expect(latest().settingsEditor!.saved).toBe(true);
    expect(JSON.parse(await readFile(join(home, '.agent/config.json'), 'utf8'))).toEqual({
      provider: 'fake',
      model: 'global-model',
    });
    expect(JSON.parse(await readFile(file(), 'utf8')).unknown).toBe(true);
    expect(latest().model).toBe('fake-desktop');
    expect(latest().mode).toBe('ask');
  });
  it('输入校验与 CAS 失败返回脱敏反馈；修复后重新读取才能提交', async () => {
    await writeFile(file(), JSON.stringify({ model: 'original', future: true }));
    await readSettings();
    const old = latest().settingsEditor!.id;
    await commit({ apiKeyEnv: 'private-value-not-a-variable' });
    expect(latest().settingsEditor!.error).toContain('验证或保存失败');
    expect(JSON.stringify(latest())).not.toContain('private-value-not-a-variable');
    await writeFile(file(), JSON.stringify({ model: 'external', future: true }));
    await commit({ model: 'new' }, old);
    expect(latest().settingsEditor!.error).toContain('配置已变化');
    expect(JSON.parse(await readFile(file(), 'utf8')).model).toBe('external');
    await readSettings();
    await commit({ model: 'new' });
    expect(latest().settingsEditor!.saved).toBe(true);
  });
  it('协议拒绝任意路径、额外字段、旧 token 与跨会话提交', async () => {
    await readSettings();
    const id = latest().settingsEditor!.id;
    expect(() =>
      actionSchema.parse({
        type: 'settings-commit',
        generation: latest().generation,
        sessionId: latest().sessionId,
        editorId: id,
        json: '{}',
        path: '/tmp/arbitrary.json',
      }),
    ).toThrow();
    await expect(
      controller.handle({
        type: 'settings-commit',
        generation: randomUUID(),
        sessionId: latest().sessionId,
        editorId: id,
        json: '{}',
      }),
    ).rejects.toThrow('会话已变化');
    await readSettings('configuration-budgets');
    await expect(commit({ model: 'stale' }, id)).rejects.toThrow('过期');
    await commit({ maxTurns: 5 });
    const used = latest().settingsEditor!.id;
    await commit({ maxTurns: 6 }, used);
    await expect(commit({ maxTurns: 7 }, used)).rejects.toThrow('过期');
    await expect(readSettings('unregistered')).rejects.toThrow();
    await expect(readSettings('policy-deterministic-config', 'global')).rejects.toThrow();
  });
  it('配置中的未知秘密不会进入 DTO；重置保存保留未知及嵌套字段', async () => {
    await writeFile(
      file(),
      JSON.stringify({
        apiKey: 'private-root',
        cache: { enabled: false, future: { token: 'private-nested' } },
        unrelated: 4,
      }),
    );
    await readSettings('configuration-budgets');
    expect(JSON.stringify(latest())).not.toContain('private-');
    await commit({});
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      apiKey: 'private-root',
      cache: { future: { token: 'private-nested' } },
      unrelated: 4,
    });
  });
  it('符号链接目标不被设置覆盖；关闭编辑不会保存', async () => {
    const target = join(root, 'outside.json');
    await writeFile(target, '{"model":"outside"}');
    await symlink(target, file());
    await expect(readSettings()).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('{"model":"outside"}');
    await rm(file());
    await readSettings();
    const id = latest().settingsEditor!.id;
    await send({ type: 'settings-close' });
    await expect(commit({ model: 'late' }, id)).rejects.toThrow('过期');
    await expect(access(file())).rejects.toThrow();
  });
  it('已有审批不会由设置操作批准，任务运行期间禁止编辑', async () => {
    await send({ type: 'submit', text: '演示审批', invocationId: randomUUID() });
    await vi.waitFor(() => expect(latest().approvals).toHaveLength(1));
    const pending = latest().approvals[0].id;
    await expect(readSettings('configuration-permissions')).rejects.toThrow('结算');
    expect(latest().approvals[0].id).toBe(pending);
    await expect(access(join(cwd, 'demo-note.txt'))).rejects.toThrow();
    await send({ type: 'approve', approvalId: pending, allow: false });
    await vi.waitFor(() => expect(latest().busy).toBe(false));
  });
  it('异步校验时关闭宿主会取消草稿，不在关闭后写入', async () => {
    await readSettings();
    const section = agent.settings.find((item) => item.id === 'configuration-connection')!.section;
    let release!: () => void;
    const original = section.draft!;
    section.draft = (value, signal, scope) =>
      new Promise((resolve, reject) => {
        release = () => {
          void Promise.resolve()
            .then(() => original(value, signal, scope))
            .then(resolve, reject);
        };
      });
    const operation = commit({ model: 'late' });
    await vi.waitFor(() => expect(release).toBeDefined());
    const disposal = controller.dispose();
    release();
    await operation;
    await disposal;
    await expect(access(file())).rejects.toThrow();
  });
});

it('macOS 使用原生交通灯、菜单与系统编辑 / 缩放快捷键', () => {
  expect(platformWindowOptions('darwin')).toMatchObject({
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
  });
  expect(platformWindowOptions('linux').titleBarStyle).toBeUndefined();
  const navigate = vi.fn();
  const menu = desktopMenu('darwin', navigate);
  const appMenu = menu[0].submenu as import('electron').MenuItemConstructorOptions[];
  const settings = appMenu.find((item) => item.accelerator === 'CmdOrCtrl+,')!;
  (settings.click as () => void)();
  expect(navigate).toHaveBeenCalledWith('settings');
  expect(JSON.stringify(menu)).toContain('zoomIn');
  expect(JSON.stringify(menu)).toContain('copy');
});
