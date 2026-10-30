/** 真实 React + 隔离 FakeProvider UI 验收；先运行 desktop:build / desktop:preview。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
const origin = process.env.AGENTLAB_UI_ORIGIN ?? 'http://127.0.0.1:4175';
const url = new URL(origin);
assert(
  url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password,
  'UI 验收只允许本机隔离预览',
);
const out = process.env.AGENTLAB_UI_EVIDENCE ?? '/tmp/agentlab-ui-evidence';
await mkdir(out, { recursive: true });
const executablePath =
  process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.screenshot({ path: join(out, 'projects-light.png'), fullPage: true });
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await page
    .locator('.settings-developer-tools')
    .getByRole('button', { name: '离线演示', exact: true })
    .click();
  await expect(page.getByLabel('输入任务', { exact: true })).toBeEnabled();
  await page.screenshot({ path: join(out, 'empty-chat-light.png'), fullPage: true });
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.getByRole('button', { name: '收起或显示检查栏', exact: true }).click();
  await expect(page.locator('.inspector')).toBeVisible();
  const resizer = page.getByRole('separator', { name: '调整检查面板宽度', exact: true });
  await resizer.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(resizer).toHaveAttribute('aria-valuenow', '400');
  await resizer.dblclick();
  await expect(resizer).toHaveAttribute('aria-valuenow', '380');
  const handle = await resizer.boundingBox();
  await page.mouse.move(handle.x + 4, handle.y + 180);
  await page.mouse.down();
  await page.mouse.move(handle.x - 36, handle.y + 180, { steps: 4 });
  await page.mouse.up();
  await expect(resizer).toHaveAttribute('aria-valuenow', '420');
  await resizer.dblclick();
  await expect(resizer).toHaveAttribute('aria-valuenow', '380');
  await page.screenshot({ path: join(out, 'inspector-light.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭检查面板', exact: true }).click();
  await expect(page.locator('.inspector')).toHaveCount(0);
  await page.getByRole('button', { name: '收起或显示检查栏', exact: true }).click();
  await expect(page.locator('.inspector')).toBeVisible();
  const thinking = page.getByRole('combobox', { name: '思考等级', exact: true });
  await thinking.selectOption('low');
  await expect(thinking).toHaveValue('low');
  const permission = page.getByRole('combobox', { name: '权限模式', exact: true });
  await permission.selectOption('auto');
  await expect(permission).toHaveValue('auto');
  const currentModel = page.getByRole('combobox', { name: '当前模型', exact: true });
  await expect(currentModel).toBeVisible();
  const current = await page.request.post(origin + '/api/snapshot', {
    data: '{}',
    headers: { 'Content-Type': 'application/json' },
  });
  const runtime = (await current.json()).runtime;
  assert.equal(runtime.thinking, 'low');
  assert.equal(runtime.mode, 'auto');
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await expect(page.locator('.settings-scope-bar')).toHaveCount(0);
  await expect(page.locator('.settings-preferences,.settings-quick')).toHaveCount(0);
  await page.getByRole('button', { name: '主任务与模型连接（启动默认值）', exact: true }).click();
  const model = 'cloud-ui-' + randomUUID().slice(0, 8);
  await page.getByLabel('默认模型', { exact: true }).fill(model);
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  let unexpectedDialogs = 0;
  const reselectDialog = (dialog) => {
    unexpectedDialogs++;
    void dialog.accept();
  };
  page.on('dialog', reselectDialog);
  await page.getByRole('button', { name: '主任务与模型连接（启动默认值）', exact: true }).click();
  page.off('dialog', reselectDialog);
  assert.equal(unexpectedDialogs, 0, '重选当前节不能询问或丢失草稿');
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  await expect(page.getByRole('region', { name: '应用设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存更改', exact: true }).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await expect(page.getByLabel('默认模型', { exact: true })).toHaveValue(model);
  await page.locator('.advanced-fields > summary').click();
  const endpoint = page.getByRole('textbox', { name: 'Endpoint URL', exact: true });
  const originalEndpoint = await endpoint.inputValue();
  await endpoint.fill('file:///invalid-endpoint');
  await page.getByRole('button', { name: '保存更改', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '验证或保存失败' })).toBeVisible();
  await page.getByRole('button', { name: '保存更改', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '验证或保存失败' })).toBeVisible();
  await page.getByRole('button', { name: '放弃更改', exact: true }).click();
  await page.locator('.advanced-fields > summary').click();
  await expect(endpoint).toHaveValue(originalEndpoint);
  await page.screenshot({ path: join(out, 'settings-light.png'), fullPage: true });
  const theme = page.locator('.settings-appearance select[aria-label="设置界面主题"]');
  await theme.selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('.settings-advanced-nav > summary').click();
  await page.getByRole('button', { name: '上下文与缓存预算', exact: true }).click();
  const maxTurns = page.getByRole('spinbutton', { name: '最大轮数', exact: true });
  const originalMaxTurns = await maxTurns.inputValue();
  await maxTurns.fill('12');
  await page.locator('.settings-advanced > summary').click();
  await page.getByRole('button', { name: '清除此节的本层覆盖', exact: true }).click();
  await expect(maxTurns).toHaveValue(originalMaxTurns);
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '放弃更改', exact: true }).click();
  await theme.selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.setViewportSize({ width: 900, height: 650 });
  // 仅模拟 renderer 的 macOS 安全区，不能证明 AppKit / 原生菜单通过。
  await page.evaluate(() => {
    document.documentElement.dataset.platform = 'darwin';
  });
  await page.screenshot({ path: join(out, 'mac-layout-simulation-dark.png'), fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    '窗口横向溢出',
  );
  await page.getByRole('button', { name: '返回工作区', exact: true }).click();
  const previousSession = await page.request.post(origin + '/api/snapshot', {
    data: '{}',
    headers: { 'Content-Type': 'application/json' },
  });
  const previousSessionId = (await previousSession.json()).runtime.sessionId;
  await page.getByRole('button', { name: '新建当前项目会话', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await page.request.post(origin + '/api/snapshot', {
        data: '{}',
        headers: { 'Content-Type': 'application/json' },
      });
      return (await response.json()).runtime?.sessionId;
    })
    .not.toBe(previousSessionId);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      environment: 'Node Playwright + Linux Chromium DPR 2 + isolated FakeProvider worker',
      checks: [
        '简单选项即选即保存',
        'React 设置保存',
        '未保存导航拦截',
        '校验失败反馈',
        '全局配置验证',
        '安全重置草稿',
        '系统暗色',
        '900px 高DPI 布局',
      ],
      native_macos: false,
      screenshots: ['settings-light.png', 'mac-layout-simulation-dark.png'],
    }),
  );
} finally {
  await browser.close();
}
