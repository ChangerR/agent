/** 真实 Electron 快速配置验收；独立 HOME/userData、固定假 key，不发送模型请求。 */
import { _electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { captureWindow } from './electron-capture.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(repo, 'desktop/.validation/model-setup');
const root = await mkdtemp(join(tmpdir(), 'agentlab-quick-model-ui-'));
const home = join(root, 'home'),
  userData = join(root, 'app'),
  dist = join(repo, 'desktop/dist');
for (const path of [home, userData, out]) await mkdir(path, { recursive: true });
const entry = join(root, 'entry.cjs');
await writeFile(
  entry,
  `const { app } = require('electron');
app.setPath('userData', ${JSON.stringify(userData)});
app.setAppPath(${JSON.stringify(dist)});
globalThis.fetch = () => { throw new Error('Test forbids model requests'); };
require(${JSON.stringify(join(dist, 'main/index.cjs'))});
`,
);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ANTHROPIC_API_KEY: 'fictional-unused',
  OPENAI_API_KEY: 'fictional-unused',
  DEEPSEEK_API_KEY: 'fictional-unused',
  MOONSHOT_API_KEY: 'fictional-unused',
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [],
  passed = [];
const readConfig = async () =>
  JSON.parse(await readFile(join(home, '.agentlab/config.json'), 'utf8'));
async function launch() {
  app = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [entry],
    cwd: repo,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await expect(page.getByRole('region', { name: '快速模型配置', exact: true })).toBeVisible();
  await expect(page.getByLabel('模型 API Key', { exact: true })).toBeEnabled();
}
try {
  await launch();
  const quick = () => page.getByRole('region', { name: '快速模型配置', exact: true });
  await expect(page.getByLabel('API 端点', { exact: true })).toHaveCount(0);
  await page.getByLabel('模型 API Key', { exact: true }).fill('fictional-deepseek-key');
  await quick().getByRole('button', { name: '保存并设为默认', exact: true }).click();
  await expect(quick().getByText('已保存。', { exact: false })).toBeVisible();
  assert.equal((await readConfig()).model, 'deepseek-flash');
  await expect(page.getByLabel('模型 API Key', { exact: true })).toHaveValue('');
  passed.push('DeepSeek 只填 key 一次保存');
  await captureWindow(app, page, join(out, 'deepseek.png'));
  await quick().getByRole('button', { name: 'Kimi 官方', exact: false }).click();
  await page.getByLabel('模型 API Key', { exact: true }).fill('fictional-kimi-key');
  await quick().getByRole('button', { name: '保存并设为默认', exact: true }).click();
  await expect(quick().getByText('已保存。', { exact: false })).toBeVisible();
  assert.equal((await readConfig()).model, 'kimi-k3.1-pro');
  passed.push('Kimi 自动模型及中国站默认');
  await quick().getByRole('button', { name: 'DeepSeek 官方', exact: false }).click();
  await expect(quick().getByText('已加密保存', { exact: true })).toBeVisible();
  await quick().getByRole('button', { name: '保存并设为默认', exact: true }).click();
  await expect(quick().getByText('已保存。', { exact: false })).toBeVisible();
  assert.equal((await readConfig()).model, 'deepseek-flash');
  passed.push('切回已配置服务不重填 key');
  await quick().getByRole('button', { name: '自定义服务', exact: false }).click();
  await page.getByLabel('API 端点', { exact: true }).fill('http://127.0.0.1:12345/v1');
  await page.getByLabel('API 协议', { exact: true }).selectOption('openai');
  await page.getByLabel('模型 ID', { exact: true }).fill('fictional-custom-model');
  await page.getByLabel('模型 API Key', { exact: true }).fill('fictional-custom-key');
  await quick().getByRole('button', { name: '保存并设为默认', exact: true }).click();
  await expect(quick().getByText('已保存。', { exact: false })).toBeVisible();
  assert.equal((await readConfig()).model, 'fictional-custom-model');
  passed.push('自定义端点/协议/模型/key 同页保存');
  for (const [name, width, height, zoom] of [
    ['desktop', 1200, 900, 1],
    ['narrow', 800, 700, 1],
    ['zoom125', 900, 700, 1.25],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(size.width, size.height);
        window.webContents.setZoomFactor(size.zoom);
      },
      { width, height, zoom },
    );
    for (const label of ['API 端点', 'API 协议', '模型 ID', '模型 API Key']) {
      const field = page.getByLabel(label, { exact: true });
      await field.scrollIntoViewIfNeeded();
      const box = await field.boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(
        box &&
          box.x >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y >= 0 &&
          box.y + box.height <= viewport.height,
        label + ' 完整可见',
      );
    }
    await captureWindow(app, page, join(out, name + '.png'));
  }
  passed.push('桌面/窄窗/125% 控件可见');
  const configText = await readFile(join(home, '.agentlab/config.json'), 'utf8');
  const vaultText = await readFile(join(home, '.agentlab/credentials.enc.json'), 'utf8');
  for (const key of ['fictional-deepseek-key', 'fictional-kimi-key', 'fictional-custom-key']) {
    assert.ok(!configText.includes(key) && !vaultText.includes(key));
    assert.ok(!(await page.locator('body').innerText()).includes(key));
  }
  await app.close();
  app = undefined;
  await launch();
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('fictional-custom-model');
  await expect(quick().getByText('已加密保存', { exact: true })).toBeVisible();
  passed.push('重启恢复配置，文件与页面不泄漏密钥');
  await page
    .getByRole('button', { name: '高级设置：连接、模型目录与环境变量', exact: true })
    .click();
  await expect(page.getByLabel('默认模型', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '← 返回简单配置', exact: true }).click();
  await expect(quick()).toBeVisible();
  const beforeCancel = await readConfig();
  await page.getByLabel('模型 API Key', { exact: true }).fill('fictional-cancelled-key');
  await page.getByLabel('模型 API Key', { exact: true }).press('Escape');
  await expect(page.getByLabel('模型 API Key', { exact: true })).toHaveValue('');
  assert.deepEqual(await readConfig(), beforeCancel);
  passed.push('高级入口保留，Esc 放弃不写入');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed, errors, evidence: out }, null, 2));
} finally {
  await app?.close();
}
