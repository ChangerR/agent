/** 真正Electron整页设置验收：独立结构、返回状态与IPC保存。仅隔离HOME和FakeProvider。 */
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { captureWindow } from './electron-capture.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? join(repo, 'docs/evidence/fullpage-settings/electron'));
const root = await mkdtemp(join(tmpdir(), 'agentlab-fullpage-')),
  home = join(root, 'home');
await mkdir(join(home, '.agentlab'), { recursive: true });
await mkdir(out, { recursive: true });
const config = join(home, '.agentlab/config.json');
await writeFile(
  config,
  JSON.stringify({
    provider: 'fake',
    model: 'fake-desktop',
    maxTurns: 12,
    future: { preserve: 'fixture' },
    pluginConfig: { 'agentlab.planning': { mode: 'off' } },
  }),
);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'",
  wrapper = join(root, 'run.sh');
await writeFile(
  wrapper,
  '#!/bin/sh\nexec ' +
    quote(process.execPath) +
    ' ' +
    quote(join(repo, 'desktop/scripts/run.mjs')) +
    ' "$@"\n',
);
await chmod(wrapper, 0o700);
const env = {
  PATH: process.env.PATH,
  DISPLAY: process.env.DISPLAY,
  XAUTHORITY: process.env.XAUTHORITY,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_DATA_HOME: join(root, 'share'),
  LANG: 'C.UTF-8',
  NO_AT_BRIDGE: '1',
};
let app,
  page,
  step = 'launch',
  acceptLeave = false;
const passed = [],
  errors = [],
  layouts = [];
let dialogs = 0;
const snapshot = () => page.evaluate(() => window.agentlab.snapshot());
const back = () => page.getByRole('button', { name: '返回工作区', exact: true }).click();
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function check(name, run) {
  step = name;
  await run();
  passed.push(name);
  console.log('PASS ' + name);
}
async function independent() {
  await expect(page.getByRole('main', { name: '独立设置页面', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '显示侧栏', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '收起侧栏', exact: true })).toHaveCount(0);
  await expect(page.locator('.app')).toBeHidden();
  await expect(page.locator('.app')).toHaveAttribute('inert', '');
  const data = await page.evaluate(() => {
    const area = document.querySelector('.settings-screen'),
      r = area.getBoundingClientRect();
    return {
      embedded: !!area.closest('.app,.workspace'),
      oldShellChildren: area.querySelectorAll('.workspace,.sidebar,.heading,.conversation').length,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      innerWidth,
      innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.equal(data.embedded, false);
  assert.equal(data.oldShellChildren, 0);
  assert.equal(data.x, 0);
  assert.equal(data.y, 0);
  assert.equal(data.width, data.innerWidth);
  assert.equal(data.height, data.innerHeight);
  assert.ok(data.scrollWidth <= data.innerWidth);
  return data;
}
async function section(id) {
  const s = await snapshot(),
    item = s.globalSettings.settings.find((s) => s.id === id);
  const mobile = page.getByRole('combobox', { name: '设置页面', exact: true });
  if (await mobile.isVisible()) await mobile.selectOption(id);
  else {
    const button = page
      .locator('.configuration-nav')
      .getByRole('button', { name: item.title, exact: true });
    if (!(await button.isVisible())) await page.locator('.settings-advanced-nav > summary').click();
    await button.click();
  }
  await expect
    .poll(async () => (await snapshot()).globalSettings.settingsEditor?.sectionId)
    .toBe(id);
  await expect(page.locator('.configuration-editor form')).toBeVisible();
}
async function menu() {
  const accelerator = await app.evaluate(({ Menu }) => {
    const walk = (items) => items.flatMap((i) => [i, ...(i.submenu ? walk(i.submenu.items) : [])]);
    const item = walk(Menu.getApplicationMenu().items).find((i) => i.label === '设置…');
    item.click();
    return item.accelerator;
  });
  assert.equal(accelerator, 'CmdOrCtrl+,');
  await independent();
}
async function saveGlobal(value) {
  await section('configuration-budgets');
  await page.getByLabel('最大轮数', { exact: true }).fill(String(value));
  await page.getByRole('button', { name: '保存更改', exact: true }).click();
  await expect.poll(async () => (await json(config)).maxTurns).toBe(value);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
}
async function theme(value) {
  const control = page.locator('.settings-appearance select[aria-label="设置界面主题"]');
  await control.selectOption(value);
  await expect(page.locator('html')).toHaveAttribute('data-theme', value);
}
try {
  app = await _electron.launch({
    executablePath: wrapper,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    cwd: repo,
    env,
    timeout: 60000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => {
    dialogs++;
    void (acceptLeave ? d.accept() : d.dismiss());
  });
  await page.waitForURL(pathToFileURL(join(repo, 'desktop/dist/renderer/index.html')).href, {
    waitUntil: 'domcontentloaded',
  });
  await expect.poll(async () => !!(await snapshot()).globalSettings).toBe(true);
  await check('无项目独立整页、默认全局、菜单重复打开保留设置草稿、取消离开', async () => {
    await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await independent();
    assert.equal((await snapshot()).runtime, undefined);
    await expect(page.locator('.settings-scope-bar')).toHaveCount(0);
    await expect(page.locator('.settings-preferences,.settings-quick')).toHaveCount(0);
    await section('configuration-budgets');
    await page.getByLabel('最大轮数', { exact: true }).fill('40');
    const count = dialogs;
    await menu();
    await menu();
    assert.equal(dialogs, count);
    await expect(page.getByLabel('最大轮数', { exact: true })).toHaveValue('40');
    await back();
    assert.equal(dialogs, count + 1);
    await independent();
    await expect(page.getByLabel('最大轮数', { exact: true })).toHaveValue('40');
    assert.equal((await json(config)).maxTurns, 12);
  });
  await check('无项目真实IPC保存后返回原项目页，不创建运行时、不丢未知字段', async () => {
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect.poll(async () => (await json(config)).maxTurns).toBe(40);
    await back();
    await expect(page.locator('.projects-page')).toBeVisible();
    assert.equal((await snapshot()).runtime, undefined);
    assert.deepEqual((await json(config)).future, { preserve: 'fixture' });
  });
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await page
    .locator('.settings-developer-tools')
    .getByRole('button', { name: '离线演示', exact: true })
    .click();
  await expect(page.getByLabel('输入任务', { exact: true })).toBeEnabled();
  await page.getByLabel('输入任务', { exact: true }).fill('演示 Markdown 排版');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect(page.locator('.markdown table')).toBeVisible();
  await expect.poll(async () => (await snapshot()).runtime.busy).toBe(false);
  await page.getByRole('button', { name: '收起或显示检查栏', exact: true }).click();
  await page.getByRole('button', { name: '执行记录', exact: true }).click();
  const draft = '这是不能丢失的未发送草稿\n第二行内容';
  await page.getByLabel('输入任务', { exact: true }).fill(draft);
  await page.locator('.conversation').evaluate((e) => {
    e.scrollTop = 120;
  });
  await expect
    .poll(() => page.locator('.conversation').evaluate((e) => e.scrollTop))
    .toBeGreaterThan(0);
  await page.getByLabel('输入任务', { exact: true }).evaluate((e) => {
    window.__retainedComposer = e;
    e.setSelectionRange(3, 8);
  });
  const before = (await snapshot()).runtime,
    scroll = await page.locator('.conversation').evaluate((e) => e.scrollTop);
  await captureWindow(app, page, join(out, 'chat-before-settings.png'));
  async function restored() {
    await expect(page.getByLabel('输入任务', { exact: true })).toHaveValue(draft);
    assert.equal(
      await page
        .getByLabel('输入任务', { exact: true })
        .evaluate((e) => e === window.__retainedComposer),
      true,
    );
    const runtime = (await snapshot()).runtime;
    assert.equal(runtime.sessionId, before.sessionId);
    assert.equal(runtime.generation, before.generation);
    assert.equal(runtime.cwd, before.cwd);
    assert.equal(runtime.rows.length, before.rows.length);
    await expect(page.locator('.tabs button.active')).toHaveText('执行记录');
    await expect
      .poll(() => page.locator('.conversation').evaluate((e) => e.scrollTop))
      .toBe(scroll);
  }
  await check('聊天整页进入/返回恢复相同会话、输入DOM、草稿、光标焦点、滚动与检查栏', async () => {
    await menu();
    await expect(page.locator('.settings-scope-bar')).toHaveCount(0);
    await expect(page.locator('.settings-preferences,.settings-quick')).toHaveCount(0);
    await back();
    await restored();
    await expect(page.getByLabel('输入任务', { exact: true })).toBeFocused();
    assert.deepEqual(
      await page
        .getByLabel('输入任务', { exact: true })
        .evaluate((e) => [e.selectionStart, e.selectionEnd]),
      [3, 8],
    );
    await captureWindow(app, page, join(out, 'chat-after-return.png'));
  });
  await check('聊天草稿不受设置取消/确认放弃及保存后返回影响', async () => {
    await menu();
    await section('configuration-budgets');
    await page.getByLabel('最大轮数', { exact: true }).fill('51');
    await back();
    await independent();
    assert.equal((await json(config)).maxTurns, 40);
    acceptLeave = true;
    await back();
    acceptLeave = false;
    await restored();
    assert.equal((await json(config)).maxTurns, 40);
    await menu();
    await saveGlobal(52);
    await back();
    await restored();
  });
  await check('全局字段可保存和清除本层设置，不露出原项目导航', async () => {
    await menu();
    await section('configuration-budgets');
    await independent();
    await page.getByLabel('最大轮数', { exact: true }).fill('7');
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect.poll(async () => (await json(config)).maxTurns).toBe(7);
    await page.locator('.settings-advanced > summary').click();
    await page.getByRole('button', { name: '清除此节的本层覆盖', exact: true }).click();
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect.poll(async () => (await json(config)).maxTurns === undefined).toBe(true);
    await back();
    await restored();
  });
  await check('整页桌面/窄窗/125%实际像素、完整原生截图和主题切换', async () => {
    await menu();
    for (const [name, width, height, zoom] of [
      ['desktop', 1440, 960, 1],
      ['narrow', 900, 700, 1],
      ['zoom125', 900, 700, 1.25],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, s) => {
          const w = BrowserWindow.getAllWindows()[0];
          w.setSize(s.width, s.height);
          w.webContents.setZoomFactor(s.zoom);
        },
        { width, height, zoom },
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(width / zoom));
      const structure = await independent();
      for (const name of ['返回工作区', '设置界面主题', '查找设置页面']) {
        const control =
          name === '返回工作区'
            ? page.getByRole('button', { name, exact: true })
            : name === '设置界面主题'
              ? page.locator('.settings-appearance').getByRole('combobox', { name, exact: true })
              : page.getByRole('textbox', { name, exact: true });
        const b = await control.boundingBox();
        assert.ok(
          b.x >= 0 &&
            b.x + b.width <= structure.innerWidth + 1 &&
            b.y >= 0 &&
            b.y + b.height <= structure.innerHeight + 1,
        );
      }
      await theme('light');
      await page.locator('.configuration-scroll').evaluate((e) => {
        e.scrollTop = 0;
      });
      const image = await captureWindow(app, page, join(out, name + '-settings.png'));
      layouts.push({ name, structure, ...image });
      if (name === 'desktop') {
        await theme('dark');
        await captureWindow(app, page, join(out, 'desktop-settings-dark.png'));
        await theme('light');
      }
      if (name === 'zoom125') {
        await theme('dark');
        await captureWindow(app, page, join(out, 'zoom125-settings-dark.png'));
        await theme('light');
      }
    }
    await back();
    await expect(page.getByLabel('输入任务', { exact: true })).toHaveValue(draft);
    assert.equal((await snapshot()).runtime.sessionId, before.sessionId);
  });
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        entry: 'run.mjs',
        platform: process.platform,
        nativeMac: false,
        realIPCWorkerFilesystem: true,
        paidRequests: 0,
        dialogs,
        passed,
        layouts,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
} catch (error) {
  await writeFile(
    join(out, 'result.json'),
    JSON.stringify({ status: 'failed', step, passed, error: String(error), errors }, null, 2) +
      '\n',
  );
  if (page) await captureWindow(app, page, join(out, 'failure.png')).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
