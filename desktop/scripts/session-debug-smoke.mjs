/** 实际 Electron 学习页面验收；只运行专用离线演示，隔离 HOME 与 userData。 */
import { _electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, readdir, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { captureWindow } from './electron-capture.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(repo, 'desktop/.validation/session-debug');
const root = await mkdtemp(join(tmpdir(), 'agentlab-debug-ui-')),
  home = join(root, 'home'),
  userData = join(root, 'app');
for (const path of [home, userData, out]) await mkdir(path, { recursive: true });
const dist = join(repo, 'desktop/dist'),
  entry = join(root, 'entry.cjs');
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
  OPENAI_API_KEY: 'fictional-unused',
  ANTHROPIC_API_KEY: 'fictional-unused',
  AGENTLAB_DEMO_KEY: 'fictional-debug-only',
};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const errors = [],
  passed = [];
const snapshot = () => page.evaluate(() => window.agentlab.snapshot());
const openSettings = () => page.getByRole('button', { name: '打开应用设置', exact: true }).click();
const openDebug = async () => {
  await openSettings();
  await page.getByRole('button', { name: '打开会话调试', exact: true }).click();
};
async function launch() {
  app = await _electron.launch({
    executablePath: createRequire(import.meta.url)('electron'),
    args: [entry],
    cwd: repo,
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await openSettings();
  await page
    .locator('.settings-developer-tools')
    .getByRole('button', { name: '离线演示', exact: true })
    .click();
  await expect.poll(async () => (await snapshot()).runtime?.phase).toBe('就绪');
}
try {
  await launch();
  await page
    .getByLabel('输入任务', { exact: true })
    .fill('读取并写入演示文件，学习过程。API_KEY=sk-fixture-secret-123456789');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await snapshot()).runtime?.approvals.length).toBe(1);
  await expect(page.locator('.activity-group[open]')).toHaveCount(1);
  passed.push('轮次未结束时执行组保持展开');
  await openDebug();
  await expect(page.getByRole('main', { name: '会话调试页面', exact: true })).toBeVisible();
  await expect(page.getByText('有工具正在等待你的审批。', { exact: false })).toBeVisible();
  await page.locator('.debug-request').first().click();
  await page.getByRole('tab', { name: 'Agent 上下文', exact: true }).click();
  await expect(page.getByText('系统指令 · System', { exact: true })).toBeVisible();
  assert.equal((await snapshot()).runtime.approvals.length, 1);
  passed.push('执行中可查看请求，查看不触发审批');
  await page
    .getByRole('dialog', { name: 'API 调用详情', exact: true })
    .getByRole('button', { name: '返回会话处理', exact: true })
    .click();
  await page.getByRole('button', { name: '仅允许本次', exact: true }).click();
  await expect.poll(async () => (await snapshot()).runtime?.busy).toBe(false);
  const before = (await snapshot()).runtime;
  assert.equal(before.debug.totalRequests, 3);
  assert.equal(before.debug.toolCalls, 2);
  assert.equal(before.debug.approvals, 1);
  await expect(page.locator('.activity-group')).toHaveCount(2);
  await expect(page.locator('.activity-group[open]')).toHaveCount(0);
  await expect(page.locator('.activity-group > summary').first()).toContainText('1 步');
  passed.push('执行完成后工具与思考记录自动折叠');
  await openDebug();
  await page.locator('.debug-request').first().click();
  await page.getByRole('tab', { name: '模型返回', exact: true }).click();
  await expect(page.getByText('回复正文', { exact: true })).toBeVisible();
  await expect(page.locator('.debug-tab-content')).toContainText('演示完成');
  await captureWindow(app, page, join(out, 'response.png'));
  await page.getByRole('button', { name: '关闭调用详情', exact: true }).click();
  await page.locator('.debug-request').nth(1).click();
  await page.getByRole('tab', { name: '工具与审批', exact: true }).click();
  await expect(page.locator('.debug-tab-content')).toContainText('工具执行管线');
  await page.locator('.debug-tab-content details').first().locator(':scope > summary').click();
  await captureWindow(app, page, join(out, 'tool-pipeline.png'));
  passed.push('三次模型请求、两次工具和一次审批完整关联');
  await page.getByRole('tab', { name: 'Agent 上下文', exact: true }).click();
  await page
    .locator('.debug-section')
    .filter({ hasText: '消息历史' })
    .locator('.debug-message')
    .first()
    .locator('summary')
    .click();
  assert.ok(!(await page.locator('.debug-screen').innerText()).includes('sk-fixture-secret'));
  passed.push('请求详情带格式，敏感字段不进入调试显示');
  for (const [name, width, height, zoom] of [
    ['desktop', 1440, 960, 1],
    ['narrow', 800, 700, 1],
    ['zoom125', 900, 700, 1.25],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(size.width, size.height);
        w.webContents.setZoomFactor(size.zoom);
      },
      { width, height, zoom },
    );
    await page.getByRole('tab', { name: '模型返回', exact: true }).scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    assert.ok(
      overflow.scroll <= overflow.width && overflow.body <= overflow.width,
      '页面不横向溢出',
    );
    await captureWindow(app, page, join(out, name + '.png'));
  }
  passed.push('桌面/窄窗/125%完整窗口与滚动');
  await page.getByRole('button', { name: '关闭调用详情', exact: true }).click();
  await page.getByRole('combobox', { name: '筛选状态', exact: true }).selectOption('error');
  await expect(page.locator('.debug-request')).toHaveCount(0);
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await expect(page.locator('.debug-request')).toHaveCount(3);
  await page.getByRole('combobox', { name: '调用排序', exact: true }).selectOption('oldest');
  await expect(page.locator('.debug-request').first()).toContainText('#1');
  await page.getByRole('button', { name: '重置', exact: true }).click();
  passed.push('日志表格筛选、重置和执行顺序排序');
  const report = join(out, 'session-report.md');
  await app.evaluate(
    ({ session }, path) =>
      session.defaultSession.on('will-download', (_event, item) => item.setSavePath(path)),
    report,
  );
  await page.getByRole('button', { name: '导出 Markdown 报告', exact: true }).click();
  await expect
    .poll(async () => {
      try {
        return (await readFile(report, 'utf8')).includes('完整会话时间线');
      } catch {
        return false;
      }
    })
    .toBe(true);
  const markdown = await readFile(report, 'utf8');
  assert.ok(markdown.includes('请求 3') && !markdown.includes('sk-fixture-secret-123456789'));
  passed.push('实际导出完整 Markdown 报告并脱敏');
  await app.close();
  app = undefined;
  await launch();
  assert.equal((await snapshot()).runtime.sessionId, before.sessionId);
  await openDebug();
  await expect(page.locator('.debug-request')).toHaveCount(3);
  await page.locator('.debug-request').first().click();
  await page.getByRole('tab', { name: '模型返回', exact: true }).click();
  await expect(page.locator('.debug-tab-content')).toContainText('演示完成');
  passed.push('关闭重开恢复原会话和请求详情，不重放工具');
  if (process.argv[2]) {
    // 可选夹具来自 api-transport.test 的真实 SDK + 内存 fetch，不接触任何外部服务。
    await app.close();
    app = undefined;
    const projects = join(userData, 'demo-home/.agentlab/state/projects');
    const directories = await readdir(projects);
    let target;
    for (const project of directories) {
      const path = join(projects, project, 'debug', before.sessionId + '.jsonl');
      try {
        await readFile(path);
        target = path;
        break;
      } catch {}
    }
    assert.ok(target, '隔离会话的调试文件存在');
    await appendFile(target, await readFile(resolve(process.argv[2])));
    await launch();
    await openDebug();
    await expect(page.locator('.debug-request')).toHaveCount(4);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1440, 960);
      w.webContents.setZoomFactor(1);
    });
    await captureWindow(app, page, join(out, 'api-log-table.png'));
    await page.getByRole('combobox', { name: '筛选供应商', exact: true }).selectOption('openai');
    await expect(page.locator('.debug-request')).toHaveCount(1);
    await page.locator('.debug-request').first().click();
    await expect(page.getByRole('dialog', { name: 'API 调用详情', exact: true })).toBeVisible();
    await expect(page.locator('.api-endpoint')).toContainText(
      'https://api.deepseek.com/chat/completions',
    );
    await expect(page.locator('.debug-tab-content')).toContainText('private prompt');
    await captureWindow(app, page, join(out, 'api-request.png'));
    await page.getByRole('tab', { name: 'API 响应', exact: true }).click();
    await expect(page.locator('.debug-tab-content')).toContainText('fixture answer');
    await expect(page.locator('.debug-tab-content')).toContainText('HTTP 200');
    await captureWindow(app, page, join(out, 'api-response.png'));
    passed.push('内存 SDK 夹具：实际 HTTP 地址、请求体、SSE JSON、供应商筛选与详情抽屉');
  }
  assert.deepEqual(errors, []);
  const result = { passed, errors, evidence: out };
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app)
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0 });
      })
      .catch(() => {});
  await app?.close();
}
