import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from 'electron';
import { desktopMenu, platformWindowOptions } from './platform.js';
import { delimiter, join, resolve } from 'node:path';
import { realpath, stat, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WorkerHost } from './worker-host.js';
import { ProjectCatalog } from './project-catalog.js';
import { resolveProjectRoot } from '../../src/core/paths.js';
import {
  actionSchema,
  PROTOCOL_VERSION,
  type DesktopState,
  type RuntimeSnapshot,
} from '../shared/protocol.js';

let window: BrowserWindow;
let host: WorkerHost | undefined;
let generation: string | undefined;
let transition = false;
let exiting = false;
let closing = false;
let quitting = false;
let settingsDirty = false;
let preferencesRaw: Record<string, unknown> = {};
let preferencesQueue: Promise<unknown> = Promise.resolve();
let themeQueue: Promise<unknown> = Promise.resolve();
let state: DesktopState = {
  version: PROTOCOL_VERSION,
  revision: 0,
  connecting: false,
  projects: [],
  platform: process.platform,
  theme: 'system',
};
const catalog = new ProjectCatalog();
const root = app.getAppPath();
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  } else {
    void app.whenReady().then(createWindow);
  }
});
const renderer = join(root, 'renderer', 'index.html');
const preferences = () => join(app.getPath('userData'), 'desktop-preferences.json');
function publish() {
  catalog.observe(state.runtime);
  state.projects = catalog.projects;
  state.revision++;
  if (window && !window.isDestroyed()) window.webContents.send('agentlab:state', state);
}
async function readPreferences() {
  try {
    const value = JSON.parse(await readFile(preferences(), 'utf8'));
    catalog.restore(value);
    preferencesRaw = value;
    if (['system', 'light', 'dark', 'blue'].includes(value.theme)) state.theme = value.theme;
    state.projects = catalog.projects;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      state.error = '桌面偏好读取失败；项目配置与会话未修改。';
  }
}
async function savePreferences(failure = '项目已打开，但项目列表与最近会话记录保存失败。') {
  catalog.observe(state.runtime);
  const contents = JSON.stringify({
    ...preferencesRaw,
    projects: catalog.projects,
    theme: state.theme,
  });
  const save = preferencesQueue.then(async () => {
    const temporary = preferences() + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, preferences());
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  });
  preferencesQueue = save.catch(() => {});
  try {
    await save;
    return true;
  } catch {
    state.error = failure;
    return false;
  }
}
async function start(path: string, demo = false, fresh = false) {
  if (transition) throw new Error('项目正在切换');
  if (state.runtime?.busy) throw new Error('请先停止当前任务并等待结算，再切换项目或会话。');
  const cwd = resolveProjectRoot(await realpath(resolve(path)));
  if (!(await stat(cwd)).isDirectory()) throw new Error('请选择项目文件夹');
  if (!fresh && state.runtime?.cwd === cwd && host && state.runtime.phase !== '进程中断') return;
  const lastSessionId = fresh ? undefined : catalog.get(cwd)?.lastSessionId;
  transition = true;
  state.connecting = true;
  state.error = undefined;
  publish();
  try {
    await host?.dispose();
    await savePreferences();
    host = undefined;
    state.runtime = undefined;
    const nextGeneration = randomUUID();
    generation = nextGeneration;
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = join(root, 'node') + delimiter + (env[pathKey] ?? '');
    if (demo) {
      const home = join(app.getPath('userData'), 'demo-home');
      await mkdir(home, { recursive: true });
      env.HOME = home;
      env.USERPROFILE = home;
      env.ANTHROPIC_API_KEY = 'demo-only-never-sent';
      env.OPENAI_API_KEY = 'demo-only-never-sent';
      env.AGENTLAB_DEMO_KEY = 'demo-only-never-sent';
      delete env.OPENAI_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    const node = join(root, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    host = new WorkerHost(
      node,
      join(root, 'worker', 'index.mjs'),
      cwd,
      env,
      (snapshot: RuntimeSnapshot) => {
        if (snapshot.generation !== generation) return;
        state.runtime = snapshot;
        state.connecting = false;
        publish();
      },
      () => {
        if (generation !== nextGeneration) return;
        state.error = 'Agent 进程中断。已保存会话可重新打开；不会自动重试工具。';
        state.connecting = false;
        if (state.runtime) {
          state.runtime.busy = false;
          state.runtime.approvals = [];
          state.runtime.interaction = undefined;
          state.runtime.phase = '进程中断';
        }
        publish();
      },
    );
    await host.request({ type: 'init', cwd, demo, generation: nextGeneration });
    catalog.open(cwd, demo);
    if (lastSessionId && state.runtime) {
      const snapshot = state.runtime as RuntimeSnapshot;
      try {
        await host.request({
          type: 'resume',
          generation: nextGeneration,
          sessionId: snapshot.sessionId,
          id: lastSessionId,
        });
      } catch {
        state.error = '上次会话无法恢复，已进入新会话；原会话文件保留在项目中。';
      }
    }
    await savePreferences();
  } catch (error) {
    state.error = error instanceof Error ? error.message : '打开项目失败';
    throw error;
  } finally {
    transition = false;
    state.connecting = false;
    publish();
  }
}
function authorized(event: Electron.IpcMainInvokeEvent) {
  if (
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame?.url !== pathToFileURL(renderer).href
  )
    throw new Error('不受信任的界面请求');
}
function register(channel: string, handler: (payload: unknown) => Promise<unknown>) {
  ipcMain.handle(channel, async (event, payload) => {
    authorized(event);
    try {
      return await handler(payload);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '桌面操作失败');
    }
  });
}
async function demo() {
  const path = join(app.getPath('userData'), 'demo-project');
  await mkdir(path, { recursive: true });
  try {
    await writeFile(
      join(path, 'README.md'),
      '# agentlab 离线演示\n\n此目录专用于 FakeProvider 演示。批准后会创建 demo-note.txt，不使用真实模型。\n',
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await start(path, true);
}
async function createWindow() {
  exiting = false;
  closing = false;
  window = new BrowserWindow({
    title: 'agentlab',
    ...platformWindowOptions(process.platform),
    backgroundColor:
      state.theme === 'dark' || (state.theme === 'system' && nativeTheme.shouldUseDarkColors)
        ? '#181b20'
        : '#ffffff',
    webPreferences: {
      preload: join(root, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on('will-prevent-unload', (event) => {
    if (exiting) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(renderer).href) event.preventDefault();
  });
  window.webContents.on('render-process-gone', () => {
    void host?.dispose().catch(() => {
      state.error = '界面中断后，Agent 关闭尚未确认。';
    });
  });
  window.on('close', (event) => {
    if (exiting) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      if (settingsDirty) {
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          buttons: ['放弃更改并关闭', '取消'],
          defaultId: 1,
          cancelId: 1,
          message: '设置有未保存更改。关闭窗口会放弃草稿。',
        });
        if (result.response !== 0) {
          quitting = false;
          return;
        }
      }
      if (state.runtime?.busy) {
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          buttons: ['停止任务并退出', '取消'],
          defaultId: 1,
          cancelId: 1,
          message: '任务仍在运行。停止后等待会话保存，再退出？',
        });
        if (result.response !== 0) {
          quitting = false;
          return;
        }
      }
      state.connecting = true;
      publish();
      try {
        await host?.dispose();
        await savePreferences();
        host = undefined;
        generation = undefined;
        state.runtime = undefined;
        state.connecting = false;
        settingsDirty = false;
        exiting = true;
        window.close();
      } catch {
        quitting = false;
        state.connecting = false;
        state.error = '退出时保存或清理失败。窗口已保留，请检查文件权限和会话冲突后重试。';
        publish();
        await dialog.showMessageBox(window, { type: 'error', message: state.error });
      }
    })().finally(() => {
      closing = false;
    });
  });
  await window.loadFile(renderer);
}
app
  .whenReady()
  .then(async () => {
    await readPreferences();
    register('agentlab:snapshot', async () => state);
    register('agentlab:theme', async (payload) => {
      if (typeof payload !== 'string' || !['system', 'light', 'dark', 'blue'].includes(payload))
        throw new Error('无效主题。');
      const save = themeQueue.then(async () => {
        const previous = state.theme;
        state.theme = payload as NonNullable<DesktopState['theme']>;
        const failure = '主题偏好保存失败，请检查应用数据目录的写入权限后重试。';
        if (!(await savePreferences(failure))) {
          state.theme = previous;
          publish();
          throw new Error(failure);
        }
        if (state.error === failure) state.error = undefined;
        publish();
      });
      themeQueue = save.catch(() => {});
      await save;
    });
    register('agentlab:pick-project', async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: '打开 agentlab 项目',
        properties: ['openDirectory'],
      });
      if (!selection.canceled && selection.filePaths[0]) await start(selection.filePaths[0]);
    });
    register('agentlab:pick-directory', async () => {
      const selection = await dialog.showOpenDialog(window, {
        title: '选择配置中的目录（保存后仍由后端验证）',
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return undefined;
      const path = await realpath(selection.filePaths[0]);
      if (!(await stat(path)).isDirectory()) throw new Error('请选择目录。');
      return path;
    });
    register('agentlab:open-project', async (payload) => {
      const project = typeof payload === 'string' ? catalog.get(payload) : undefined;
      if (!project) throw new Error('项目不在列表中，请重新选择文件夹。');
      await start(project.path, project.demo);
    });
    register('agentlab:demo', async () => demo());
    register('agentlab:new-session', async () => {
      if (!state.runtime) throw new Error('请先打开项目');
      await start(state.runtime.cwd, state.runtime.demo, true);
    });
    register('agentlab:request', async (payload) => {
      if (transition || !host) throw new Error('请先打开项目');
      await host.request(actionSchema.parse(payload));
    });
    register('agentlab:settings-dirty', async (payload) => {
      if (typeof payload !== 'boolean') throw new Error('无效状态');
      settingsDirty = payload;
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        desktopMenu(process.platform, (target) => {
          if (window && !window.isDestroyed()) {
            window.show();
            window.webContents.send('agentlab:navigate', target);
          }
        }),
      ),
    );
    await createWindow();
    if (process.argv.includes('--demo')) await demo();
    app.on('activate', () => {
      if (!window || window.isDestroyed()) void createWindow();
      else {
        window.show();
        window.focus();
      }
    });
  })
  .catch(() => {
    dialog.showErrorBox('agentlab', '桌面启动失败，请检查运行时文件是否完整。');
    app.exit(1);
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitting) app.quit();
  else exiting = false;
});
app.on('before-quit', (event) => {
  quitting = true;
  if (!exiting && window && !window.isDestroyed()) {
    event.preventDefault();
    window.close();
  }
});
