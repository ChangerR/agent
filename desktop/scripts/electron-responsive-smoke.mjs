/** 聚焦真实 Electron 的窄窗/125%回归：完整窗口、控件边界和实际点击。无外部请求。 */
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { captureWindow } from './electron-capture.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? join(repo, 'docs/evidence/ui-redesign/responsive'));
const root = await mkdtemp(join(tmpdir(), 'agentlab-responsive-')),
  home = join(root, 'home'),
  project = join(root, 'project');
for (const path of [join(home, '.agentlab'), join(project, '.git'), out])
  await mkdir(path, { recursive: true });
await writeFile(
  join(home, '.agentlab/config.json'),
  JSON.stringify({
    provider: 'fake',
    model: 'offline-model',
    pluginConfig: { 'agentlab.planning': { mode: 'off' } },
  }),
);
await writeFile(
  join(project, 'agent.config.json'),
  JSON.stringify({
    provider: 'fake',
    capabilities: { reviewer: false },
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
let app, page;
const states = [],
  errors = [];
const snapshot = () => page.evaluate(() => window.agentlab.snapshot());
async function bounds(locator, name) {
  await expect(locator, name + ' visible').toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.press('Escape');
  const box = await locator.boundingBox(),
    viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(
    box && box.x >= -0.5 && box.x + box.width <= viewport.width + 0.5,
    name + ' complete horizontal bounds',
  );
  assert.ok(
    box.y >= -0.5 && box.y + box.height <= viewport.height + 0.5,
    name + ' complete vertical bounds after scroll',
  );
  const hit = await locator.evaluate((e) => {
    const r = e.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return target === e || e.contains(target);
  });
  assert.ok(hit, name + ' unobstructed actual hit');
  return { name, ...box };
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
  await page.waitForURL(pathToFileURL(join(repo, 'desktop/dist/renderer/index.html')).href, {
    waitUntil: 'domcontentloaded',
  });
  await expect.poll(async () => !!(await snapshot()).globalSettings).toBe(true);
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await expect(page.locator('.configuration-editor form')).toBeVisible();
  // 通过真正目录 IPC 打开隔离项目，使全局/项目作用域都能实际切换。
  await page.getByRole('button', { name: '显示侧栏', exact: true }).click();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, project);
  await page.getByRole('button', { name: '添加本地项目', exact: true }).click();
  await expect.poll(async () => (await snapshot()).runtime?.phase).toBe('就绪');
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
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
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => innerWidth)) - width / zoom))
      .toBeLessThanOrEqual(1);
    const area = page.locator('.configuration-scroll');
    await area.evaluate((e) => {
      e.scrollTop = 0;
    });
    const metadata = await captureWindow(app, page, join(out, name + '-full-window.png'));
    const cdp = await page.screenshot();
    metadata.legacyCDPPixels = { width: cdp.readUInt32BE(16), height: cdp.readUInt32BE(20) };
    const grid = await page
      .locator('.primary-model-fields')
      .evaluate((e) => getComputedStyle(e).gridTemplateColumns);
    const rows = [];
    if (name === 'zoom125') {
      rows.push(
        await bounds(
          page.getByRole('combobox', { name: '设置页面', exact: true }),
          'page selector',
        ),
      );
      rows.push(
        await bounds(page.getByRole('textbox', { name: '查找设置页面', exact: true }), 'search'),
      );
      await page.getByRole('textbox', { name: '查找设置页面', exact: true }).fill('模型');
      await page.getByRole('textbox', { name: '查找设置页面', exact: true }).fill('');
    }
    rows.push(
      await bounds(page.getByRole('combobox', { name: '配置作用域', exact: true }), 'scope'),
    );
    for (const label of ['服务连接', '默认模型', '思考等级'])
      rows.push(await bounds(page.getByLabel(label, { exact: true }), label));
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    assert.ok(
      overflow.scrollWidth <= overflow.width && overflow.bodyWidth <= overflow.width,
      'no horizontal document overflow',
    );
    states.push({ name, ...metadata, grid, controls: rows, overflow });
    await writeFile(
      join(out, 'result.json'),
      JSON.stringify({ status: 'checking', states, errors }, null, 2) + '\n',
    );
    if (name === 'zoom125')
      assert.equal(
        grid.trim().split(/\s+/).length,
        1,
        '125% narrow primary fields must be one column',
      );
    if (name === 'desktop')
      assert.equal(grid.trim().split(/\s+/).length, 2, 'normal desktop retains two columns');
    await area.evaluate((e) => {
      e.scrollTop = 0;
    });
    await captureWindow(app, page, join(out, name + '-full-window.png'));
  }
  const model = page.getByLabel('默认模型', { exact: true });
  await model.fill('offline-responsive-model');
  await bounds(page.getByRole('button', { name: '保存更改', exact: true }), 'save');
  await expect
    .poll(async () => JSON.parse(await readFile(join(home, '.agentlab/config.json'), 'utf8')).model)
    .toBe('offline-responsive-model');
  await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
  await expect.poll(async () => (await snapshot()).runtime.settingsEditor?.scope).toBe('project');
  await bounds(page.getByRole('combobox', { name: '配置作用域', exact: true }), 'project scope');
  await bounds(page.getByLabel('默认模型', { exact: true }), 'project inherited model');
  await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('global');
  await expect
    .poll(async () => (await snapshot()).globalSettings.settingsEditor?.scope)
    .toBe('global');
  await page.locator('.configuration-scroll').evaluate((e) => {
    e.scrollTop = 0;
  });
  await captureWindow(app, page, join(out, 'zoom125-full-window.png'));
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        platform: process.platform,
        nativeMac: false,
        actualEntry: 'run.mjs',
        actualIPCWorkerFilesystem: true,
        states,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'PASS native Electron desktop/narrow/125%, complete window capture, all control bounds/clicks, scope switching and global save',
  );
} catch (error) {
  await writeFile(join(out, 'failure.txt'), String(error) + '\n');
  throw error;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
