/** 真正的 Electron / Secret Service / IPC / worker / 文件验收。仅本地 HTTP 假服务。 */
import { _electron, expect } from '@playwright/test';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  access,
  rename,
  rm,
  readdir,
} from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] ?? join(repo, 'docs/evidence/global-settings'));
if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS)
  throw new Error(
    '请在独立 dbus-run-session 与 Xvfb 内运行此 Linux 验收；不连接已有用户密钥服务。',
  );
const root = await mkdtemp(join(tmpdir(), 'agentlab-global-ui-')),
  home = join(root, 'home'),
  runtimeDir = join(root, 'run');
const projectA = join(root, 'project-one'),
  projectB = join(root, 'project-two');
for (const path of [home, runtimeDir, projectA, projectB, output])
  await mkdir(path, { recursive: true, mode: 0o700 });
await mkdir(join(projectA, '.git'));
await mkdir(join(projectB, '.git'));
const globalPath = join(home, '.agentlab', 'config.json'),
  vaultPath = join(home, '.agentlab', 'credentials.enc.json');
const fixtureKey = 'fictional-local-' + randomUUID(),
  model = 'local-offline-model';
const requests = [],
  passed = [],
  layout = [],
  pageErrors = [];
let app,
  page,
  step = 'bootstrap';
const keyring =
  process.env.AGENTLAB_TEST_KEYRING ??
  '/workspace/agent-secret-service/usr/bin/gnome-keyring-daemon';
const env = {
  PATH: process.env.PATH,
  DISPLAY: process.env.DISPLAY,
  XAUTHORITY: process.env.XAUTHORITY,
  DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  XDG_CURRENT_DESKTOP: 'GNOME',
  XDG_RUNTIME_DIR: runtimeDir,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local/share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  LANG: 'C.UTF-8',
  NO_AT_BRIDGE: '1',
  GTK_A11Y: 'none',
  GSETTINGS_BACKEND: 'memory',
};
const keyringProcess = spawn(
  keyring,
  [
    '--foreground',
    '--components=secrets',
    '--unlock',
    '--control-directory=' + join(runtimeDir, 'keyring'),
  ],
  {
    env: {
      ...env,
      LD_LIBRARY_PATH:
        process.env.AGENTLAB_TEST_KEYRING_LIB ??
        '/workspace/agent-secret-service/usr/lib/x86_64-linux-gnu',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  },
);
let keyringErrors = '';
keyringProcess.stderr.on('data', (b) => {
  keyringErrors += b.toString();
});
keyringProcess.stdin.end('isolated-test-keyring-password\n');
const exec = promisify(execFile);
// 仅更新本次 dbus-run-session 的激活环境，避免辅助进程使用宿主 HOME。
await exec(
  'dbus-update-activation-environment',
  [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
    'NO_AT_BRIDGE',
    'GTK_A11Y',
    'GSETTINGS_BACKEND',
  ],
  { env },
);
await expect
  .poll(async () => {
    try {
      const { stdout } = await exec(
        'dbus-send',
        [
          '--session',
          '--dest=org.freedesktop.DBus',
          '--type=method_call',
          '--print-reply',
          '/org/freedesktop/DBus',
          'org.freedesktop.DBus.NameHasOwner',
          'string:org.freedesktop.secrets',
        ],
        { env },
      );
      return stdout.includes('boolean true');
    } catch {
      return false;
    }
  })
  .toBe(true);
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = JSON.parse(body || '{}'),
    authorized = req.headers.authorization === 'Bearer ' + fixtureKey;
  requests.push({
    authorized,
    model: input.model,
    task: JSON.stringify(input.messages).includes('CHECK_AUTH'),
  });
  if (!authorized) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'local fixture unauthorized', type: 'authentication_error' },
      }),
    );
    return;
  }
  const planning = JSON.stringify(input.messages).includes('[agentlab planning');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = {
    id: 'local-fixture',
    object: 'chat.completion.chunk',
    model: input.model,
    choices: [
      {
        index: 0,
        delta: { content: planning ? 'null' : 'LOCAL_PROVIDER_OK' },
        finish_reason: null,
      },
    ],
  };
  res.end(
    'data: ' +
      JSON.stringify(event) +
      '\n\ndata: ' +
      JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'",
  wrapper = join(root, 'run-app.sh');
await writeFile(
  wrapper,
  '#!/bin/sh\nexec ' +
    quote(process.execPath) +
    ' ' +
    quote(join(repo, 'desktop/scripts/run.mjs')) +
    ' "$@"\n',
);
await chmod(wrapper, 0o700);
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const snapshot = () => page.evaluate(() => window.agentlab.snapshot());
const editor = () => page.locator('.configuration-editor'),
  form = () => editor().locator('form');
const field = (group, name) =>
  group.locator(
    ':scope > .configuration-field[data-field="' +
      name +
      '"], :scope > .primary-model-fields > .configuration-field[data-field="' +
      name +
      '"], :scope > .advanced-fields > .configuration-field[data-field="' +
      name +
      '"]',
  );
const rootFields = () => form().locator(':scope > fieldset');
async function showSidebar() {
  const toggle = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}
async function revealDetails(item) {
  // 通过真实 summary 点击展开，保持验收与键盘/指针交互一致。
  const parents = await item.locator('xpath=ancestor::details[not(@open)]').all();
  for (const detail of parents.reverse()) await detail.locator(':scope > summary').click();
}
async function override(group, name) {
  const row = field(group, name);
  await revealDetails(row);
  const check = row.locator(':scope > label > input[type=checkbox]');
  if (await check.count()) await check.check();
  return row;
}
async function launch(extra = []) {
  app = await _electron.launch({
    executablePath: wrapper,
    args: ['--no-sandbox', '--password-store=gnome-libsecret', ...extra],
    cwd: repo,
    env,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => void d.accept());
  await page.waitForURL(pathToFileURL(join(repo, 'desktop/dist/renderer/index.html')).href, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('button', { name: '打开应用设置', exact: true })).toBeVisible();
  await expect.poll(async () => !!(await snapshot()).globalSettings).toBe(true);
}
async function settings() {
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '配置作用域', exact: true })).toHaveValue(
    'global',
  );
}
async function section(id) {
  const state = await snapshot(),
    scope = await page.getByRole('combobox', { name: '配置作用域', exact: true }).inputValue(),
    context = scope === 'global' ? state.globalSettings : state.runtime;
  const item = context.settings.find((s) => s.id === id);
  assert.ok(item, 'registered section ' + id);
  const button = page
    .locator('.configuration-nav')
    .getByRole('button', { name: item.title, exact: true });
  if (await button.isVisible()) await button.click();
  else await page.getByRole('combobox', { name: '设置页面', exact: true }).selectOption(id);
  await expect
    .poll(async () => {
      const state = await snapshot();
      return (scope === 'global' ? state.globalSettings : state.runtime)?.settingsEditor?.sectionId;
    })
    .toBe(id);
  await expect(editor().getByText('正在读取设置…', { exact: true })).toHaveCount(0);
}
async function save() {
  const scope = await page.getByRole('combobox', { name: '配置作用域', exact: true }).inputValue(),
    state = await snapshot(),
    before = (scope === 'global' ? state.globalSettings : state.runtime).settingsEditor.id;
  await editor().getByRole('button', { name: '保存更改', exact: true }).click();
  await expect
    .poll(async () => {
      const s = await snapshot();
      const e = (scope === 'global' ? s.globalSettings : s.runtime).settingsEditor;
      return e.error || (e.id !== before && e.saved);
    })
    .toBe(true);
}
async function chooseProject(path) {
  await showSidebar();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, path);
  await page.getByRole('button', { name: '添加本地项目', exact: true }).click();
  await expect.poll(async () => (await snapshot()).runtime?.cwd).toBe(path);
  await expect.poll(async () => (await snapshot()).runtime?.phase).toBe('就绪');
}
async function send() {
  const before = requests.length;
  await page.getByLabel('输入任务', { exact: true }).fill('CHECK_AUTH');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.getByText('LOCAL_PROVIDER_OK', { exact: true }).last()).toBeVisible();
  await expect.poll(async () => (await snapshot()).runtime?.busy).toBe(false);
  assert.ok(requests.slice(before).some((r) => r.authorized && r.model === model && r.task));
}
async function check(name, run) {
  step = name;
  await run();
  passed.push(name);
  console.log('PASS ' + name);
}
async function screenshot(name, { top = true } = {}) {
  if (top)
    await editor().evaluate((e) => {
      e.scrollTop = 0;
    });
  await page.screenshot({ path: join(output, name) });
}
try {
  await check('无项目首次启动即可打开完整全局设置；读取不写默认或建立会话', async () => {
    await launch();
    await settings();
    const s = await snapshot();
    assert.equal(s.runtime, undefined);
    assert.equal(s.projects.length, 0);
    assert.ok(s.globalSettings.settings.length >= 18);
    await assert.rejects(access(globalPath));
    await screenshot('01-global-first-launch.png');
  });
  await check('全局 Provider 新增与 endpoint 配置；没有项目配置写入', async () => {
    await section('configuration-agentlab.provider-connections');
    const group = await override(rootFields(), 'connections'),
      map = group.locator(':scope > fieldset');
    await map.locator('.add-record').first().click();
    await map.getByRole('textbox', { name: '命名连接 名称 1', exact: true }).fill('cloud');
    const row = map.locator('.map-row');
    await row.locator('.union-editor > label > select').selectOption('0');
    const fields = row.locator('.union-editor > fieldset');
    const endpointRow = await override(fields, 'baseURL');
    await endpointRow.locator(':scope > input').fill(endpoint);
    await save();
    assert.equal(
      (await json(globalPath)).pluginConfig['agentlab.provider-connections'].connections.cloud
        .baseURL,
      endpoint,
    );
    await assert.rejects(access(join(projectA, 'agent.config.json')));
  });
  await check('UI 直接输入虚构 key，真实 gnome_libsecret 加密保存，读取和快照不泄露', async () => {
    const panel = page.getByRole('region', { name: '全局 API key', exact: true });
    if (await panel.getByRole('combobox', { name: '密钥所属 Provider', exact: true }).count())
      await panel
        .getByRole('combobox', { name: '密钥所属 Provider', exact: true })
        .selectOption('cloud');
    await panel.locator('.credential-security > summary').click();
    await expect(panel.getByText(/gnome_libsecret/)).toBeVisible();
    await panel.locator('.credential-security > summary').click();
    const input = panel.getByLabel('直接输入 API key', { exact: true });
    await input.fill(fixtureKey);
    await expect(input).toHaveAttribute('type', 'password');
    await panel.getByRole('button', { name: '保存 API key', exact: true }).click();
    await expect(panel.getByText('API key 已加密保存。', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
    assert.ok(!(await readFile(globalPath, 'utf8')).includes(fixtureKey));
    assert.ok(!(await readFile(vaultPath, 'utf8')).includes(fixtureKey));
    assert.ok(!JSON.stringify(await snapshot()).includes(fixtureKey));
    await screenshot('02-global-provider-key-saved.png');
  });
  await check('全局自定义模型规格与主任务默认值可在没有项目时保存', async () => {
    await section('configuration-model-catalog');
    const group = await override(rootFields(), 'catalog'),
      map = group.locator(':scope > fieldset');
    await map.locator('.add-record').first().click();
    await map.getByRole('textbox', { name: '模型目录 名称 1', exact: true }).fill(model);
    const fields = map.locator('.map-row > fieldset');
    for (const [name, value] of [
      ['contextWindow', '131072'],
      ['maxOutputTokens', '8192'],
    ])
      await (await override(fields, name)).locator(':scope > input').fill(value);
    await save();
    await section('configuration-connection');
    await (
      await override(rootFields(), 'provider')
    )
      .locator(':scope > select')
      .selectOption('cloud');
    await (await override(rootFields(), 'model')).locator(':scope > input').fill(model);
    await save();
    assert.equal((await json(globalPath)).provider, 'cloud');
    assert.equal((await snapshot()).runtime, undefined);
    await section('configuration-agentlab.planning');
    await (await override(rootFields(), 'mode')).locator(':scope > select').selectOption('off');
    await save();
  });
  await check(
    '打开两个不同项目，继承相同全局连接/模型/key，真实本地 Provider 请求采用',
    async () => {
      for (const path of [projectA, projectB]) {
        await chooseProject(path);
        const s = await snapshot();
        assert.equal(s.runtime.provider, 'cloud');
        assert.equal(s.runtime.model, model);
        assert.equal(s.runtime.sources.model, 'global');
        await assert.rejects(access(join(path, 'agent.config.json')));
        await send();
      }
    },
  );
  await check('项目覆盖必须显式选择，模型覆盖后可恢复全局继承', async () => {
    await settings();
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
    await expect
      .poll(async () => (await snapshot()).runtime?.settingsEditor?.scope)
      .toBe('project');
    await (
      await override(rootFields(), 'model')
    )
      .locator(':scope > input')
      .fill('project-only-model');
    await save();
    assert.equal((await json(join(projectB, 'agent.config.json'))).model, 'project-only-model');
    await field(rootFields(), 'model')
      .getByRole('button', { name: '恢复继承 model', exact: true })
      .click();
    await save();
    assert.equal((await json(join(projectB, 'agent.config.json'))).model, undefined);
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('global');
    await expect
      .poll(async () => (await snapshot()).globalSettings.settingsEditor?.scope)
      .toBe('global');
    await screenshot('03-global-inheritance.png');
  });
  await check('项目专用设置返回全局时回到有效全局页面', async () => {
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
    await section('configuration-project-environment');
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('global');
    await expect
      .poll(async () => (await snapshot()).globalSettings?.settingsEditor?.sectionId)
      .toBe('configuration-connection');
    await expect(
      editor().getByRole('heading', { name: '主任务与模型连接（启动默认值）', exact: true }),
    ).toBeVisible();
  });
  await check('真实保存冲突保留输入并显示失败，不覆盖其他写入', async () => {
    await section('configuration-budgets');
    await (await override(rootFields(), 'maxTurns')).locator(':scope > input').fill('77');
    const cfg = await json(globalPath);
    cfg.maxTurns = 66;
    await writeFile(globalPath, JSON.stringify(cfg));
    await editor().getByRole('button', { name: '保存更改', exact: true }).click();
    await expect(editor().getByRole('alert')).toBeVisible();
    assert.equal((await json(globalPath)).maxTurns, 66);
    await editor().getByRole('button', { name: '放弃更改', exact: true }).click();
    await editor().getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(editor().getByRole('alert')).toHaveCount(0);
  });
  await check('真实密钥写入失败提示且原 key 保留，密码输入不会进入快照', async () => {
    await section('configuration-agentlab.provider-connections');
    const panel = page.getByRole('region', { name: '全局 API key', exact: true });
    if (await panel.getByRole('combobox', { name: '密钥所属 Provider', exact: true }).count())
      await panel
        .getByRole('combobox', { name: '密钥所属 Provider', exact: true })
        .selectOption('cloud');
    await rename(vaultPath, vaultPath + '.held');
    await mkdir(vaultPath);
    await panel
      .getByLabel('直接输入 API key', { exact: true })
      .fill('another-fictional-unsaved-key');
    await panel.getByRole('button', { name: '保存 API key', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible();
    assert.ok(!JSON.stringify(await snapshot()).includes('another-fictional-unsaved-key'));
    await rm(vaultPath, { recursive: true });
    await rename(vaultPath + '.held', vaultPath);
    await panel.getByRole('button', { name: '取消输入', exact: true }).click();
  });
  await check('逐屏布局验收：正常、窄窗口与125%缩放，输入/按钮对齐且无横向溢出', async () => {
    const sections = [
      'configuration-connection',
      'configuration-agentlab.provider-connections',
      'configuration-model-catalog',
      'configuration-budgets',
      'configuration-permissions',
      'configuration-mcp-servers',
    ];
    for (const [name, width, height, zoom] of [
      ['normal', 1440, 960, 1],
      ['narrow', 900, 700, 1],
      ['zoom125', 900, 700, 1.25],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, { width, height, zoom }) => {
          const w = BrowserWindow.getAllWindows()[0];
          w.setSize(width, height);
          w.webContents.setZoomFactor(zoom);
        },
        { width, height, zoom },
      );
      // 使用真实 BrowserWindow 与 webContents 缩放；不叠加 Playwright 视口模拟。
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(width);
      if (await page.evaluate(() => innerWidth <= 650)) {
        const toggle = page.getByRole('button', { name: '收起侧栏', exact: true });
        if (await toggle.count()) await toggle.click();
      }
      for (const id of sections) {
        await section(id);
        const input = rootFields()
          .locator('input:not([type=hidden]):not([type=checkbox]):visible,select:visible')
          .first();
        const target = (await input.count()) ? input : rootFields().locator('.add-record').first();
        await target.scrollIntoViewIfNeeded();
        await target.click();
        await target.press('Escape');
        await target.scrollIntoViewIfNeeded();
        await target.evaluate((e) => {
          e.dataset.acceptanceControl = 'true';
        });
        const evidence = await page.evaluate(() => {
          const area = document.querySelector('.configuration-editor'),
            footer = area.querySelector('.configuration-actions'),
            buttons = [...footer.querySelectorAll('button')].map((e) => {
              const r = e.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            });
          return {
            css: { width: innerWidth, height: innerHeight },
            overflow: document.documentElement.scrollWidth > innerWidth,
            buttons,
            primaryControl: (() => {
              const e = area.querySelector('[data-acceptance-control]');
              const r = e.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === e,
              };
            })(),
            footer: (() => {
              const r = footer.getBoundingClientRect();
              return { y: r.y, height: r.height };
            })(),
          };
        });
        assert.equal(evidence.overflow, false);
        assert.ok(evidence.primaryControl.hit, '首个表单控件必须实际可点击');
        assert.ok(
          evidence.primaryControl.y >= 0 &&
            evidence.primaryControl.y + evidence.primaryControl.height < evidence.footer.y,
          '控件必须位于保存栏上方的可见区域',
        );
        assert.ok(
          evidence.footer.y >= 0 &&
            evidence.footer.y + evidence.footer.height <= evidence.css.height + 2,
        );
        assert.ok(
          evidence.buttons.every((b) => Math.abs(b.height - evidence.buttons[0].height) < 2),
        );
        layout.push({ name, id, ...evidence });
        await screenshot('layout-' + name + '-' + id + '.png', { top: false });
      }
    }
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.webContents.setZoomFactor(1);
      w.setSize(1440, 960);
    });

    const theme = page.locator('select[aria-label="设置界面主题"]');
    if (!(await theme.isVisible())) await revealDetails(theme);
    await theme.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await section('configuration-agentlab.provider-connections');
    await screenshot('06-dark-global-key.png');
    await theme.selectOption('light');
  });
  await check('关闭并重启 App 后全局配置和真实系统解密持久化，两个项目仍继承', async () => {
    await app.close();
    app = undefined;
    await launch();
    await settings();
    const panel = page.getByRole('region', { name: '全局 API key', exact: true });
    if (await panel.getByRole('combobox', { name: '密钥所属 Provider', exact: true }).count())
      await panel
        .getByRole('combobox', { name: '密钥所属 Provider', exact: true })
        .selectOption('cloud');
    await expect(panel.getByText('已配置', { exact: true })).toBeVisible();
    await screenshot('04-restarted-global-key-masked.png');
    for (const path of [projectA, projectB]) {
      await showSidebar();
      await page
        .getByRole('button', {
          name: '打开项目 ' + (path === projectA ? 'project-one' : 'project-two'),
          exact: true,
        })
        .click();
      await expect.poll(async () => (await snapshot()).runtime?.cwd).toBe(path);
      assert.equal((await snapshot()).runtime.model, model);
      await send();
    }
  });
  await check('UI 清除全局 key，密文删除、引用取消、重启不再读取旧 key', async () => {
    await settings();
    await section('configuration-agentlab.provider-connections');
    const panel = page.getByRole('region', { name: '全局 API key', exact: true });
    if (await panel.getByRole('combobox', { name: '密钥所属 Provider', exact: true }).count())
      await panel
        .getByRole('combobox', { name: '密钥所属 Provider', exact: true })
        .selectOption('cloud');
    await panel.getByRole('button', { name: '清除保存的 key', exact: true }).click();
    await expect(panel.getByText('API key 已清除。', { exact: true })).toBeVisible();
    assert.equal(Object.keys(await json(vaultPath)).length, 0);
    assert.equal(
      (await json(globalPath)).pluginConfig['agentlab.provider-connections'].connections.cloud
        .apiKeyRef,
      undefined,
    );
    await app.close();
    app = undefined;
    await launch();
    await settings();
    await section('configuration-agentlab.provider-connections');
    if (await page.getByRole('combobox', { name: '密钥所属 Provider', exact: true }).count())
      await page
        .getByRole('combobox', { name: '密钥所属 Provider', exact: true })
        .selectOption('cloud');
    await expect(page.getByLabel('直接输入 API key', { exact: true })).toHaveAttribute(
      'placeholder',
      '粘贴或输入 API key',
    );
  });
  async function assertNoPlaintext(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await assertNoPlaintext(file);
      else if (entry.isFile())
        assert.ok(
          !(await readFile(file)).includes(Buffer.from(fixtureKey)),
          '测试凭据不得进入普通文件/日志',
        );
    }
  }
  await assertNoPlaintext(home);
  await assertNoPlaintext(projectA);
  await assertNoPlaintext(projectB);
  const authorizedProofCount = requests.length;
  await check('清除后新运行时不再使用旧 key（仅向本地假服务发出未授权请求）', async () => {
    await chooseProject(projectA);
    await page.getByLabel('输入任务', { exact: true }).fill('CHECK_AUTH_AFTER_CLEAR');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect.poll(() => requests.length).toBeGreaterThan(authorizedProofCount);
    await expect.poll(async () => (await snapshot()).runtime?.busy).toBe(false);
    assert.ok(requests.slice(authorizedProofCount).every((r) => !r.authorized));
    assert.ok(!JSON.stringify(await snapshot()).includes(fixtureKey));
  });
  await check('真实 basic_text 后端拒绝 UI 和 IPC 保存，无明文降级', async () => {
    await app.close();
    app = undefined;
    await launch(['--password-store=basic']);
    await settings();
    await section('configuration-agentlab.provider-connections');
    const panel = page.getByRole('region', { name: '全局 API key', exact: true });
    if (await panel.getByRole('combobox', { name: '密钥所属 Provider', exact: true }).count())
      await panel
        .getByRole('combobox', { name: '密钥所属 Provider', exact: true })
        .selectOption('cloud');
    await expect(panel.getByLabel('直接输入 API key', { exact: true })).toBeDisabled();
    const before = await readFile(vaultPath, 'utf8');
    const rejected = await page.evaluate(async () => {
      const state = await window.agentlab.credentialStatus('cloud');
      if (state.available || state.backend !== 'basic_text') return 'wrong-backend';
      try {
        await window.agentlab.saveCredential(state.token, 'fictional-refused-key');
        return 'unexpected-write';
      } catch {
        return 'rejected';
      }
    });
    assert.equal(rejected, 'rejected');
    assert.equal(await readFile(vaultPath, 'utf8'), before);
    await screenshot('05-basic-text-refused.png');
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(requests.filter((r) => r.task).length >= 4);
  assert.ok(requests.slice(0, authorizedProofCount).every((r) => r.authorized));
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        platform: process.platform,
        macNativeTested: false,
        realEntry: 'run.mjs',
        realSafeStorage: 'gnome_libsecret with isolated GNOME Keyring/DBus',
        realIPCWorkerFilesystem: true,
        globalSections: (await snapshot()).globalSettings.settings.map(({ id, scopes }) => ({
          id,
          scopes,
        })),
        paidRequests: 0,
        plaintextLeakScan: 'passed across isolated HOME/config/state/logs/profile/projects',
        passed,
        requests,
        layout,
        pageErrors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('真实全局设置验收通过：' + passed.length + ' 场景。');
} catch (error) {
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        status: 'failed',
        failedStep: step,
        passed,
        requests,
        layout,
        pageErrors,
        error: error.message,
        macNativeTested: false,
      },
      null,
      2,
    ) + '\n',
  );
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app)
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      })
      .catch(() => {});
  await app?.close().catch(() => {});
  await new Promise((r) => server.close(r));
  keyringProcess.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
