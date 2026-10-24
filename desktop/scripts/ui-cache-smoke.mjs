/** App 与缓存 runtime 的真实 Node/Playwright UI 验收；只连接隔离 FakeProvider。 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
const origin = process.env.AGENTLAB_UI_ORIGIN ?? 'http://127.0.0.1:4176';
const url = new URL(origin);
assert(
  url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password,
  '只允许本机隔离预览',
);
const out = process.env.AGENTLAB_UI_EVIDENCE ?? '/tmp/agent-cache-ui';
await mkdir(out, { recursive: true });
const suffix = randomUUID().slice(0, 8);
const age = 14 + parseInt(suffix.slice(0, 2), 16);
const storedBytes = 1048576 + parseInt(suffix.slice(0, 4), 16);
const searchChars = 65536 + parseInt(suffix.slice(0, 4), 16);
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ??
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  headless: true,
  args: process.platform === 'linux' ? ['--no-sandbox'] : [],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '离线演示', exact: true }).click();
  await expect(page.getByLabel('输入任务', { exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
  await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
  const choose = async (title) => {
    await page.getByRole('button', { name: title, exact: true }).click();
    await expect(page.getByRole('button', { name: '重新读取', exact: true })).toBeVisible();
  };
  const override = async (label) => {
    await expect
      .poll(async () => {
        const state = await readState();
        const scope = await page
          .getByRole('combobox', { name: '配置作用域', exact: true })
          .inputValue();
        return (
          (scope === 'global' ? state.globalSettings : state.runtime)?.settingsEditor?.scope ===
          scope
        );
      })
      .toBe(true);
    await expect(page.locator('.configuration-editor form')).toBeVisible();
    const checkbox = page.getByRole('checkbox', { name: '覆盖 ' + label, exact: true });
    if (await checkbox.count()) await checkbox.check();
  };
  const text = async (label, value) => {
    await override(label);
    await page.getByLabel(label, { exact: true }).fill(value);
  };
  const select = async (label, value) => {
    await override(label);
    await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
  };
  const number = async (label, value) => {
    await override(label);
    await page.getByRole('spinbutton', { name: label, exact: true }).fill(String(value));
  };
  const readState = async () => {
    const response = await page.request.post(origin + '/api/snapshot', {
      data: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    assert(response.ok());
    return response.json();
  };
  const save = async () => {
    const scope = await page
      .getByRole('combobox', { name: '配置作用域', exact: true })
      .inputValue();
    const pick = (s) => (scope === 'global' ? s.globalSettings : s.runtime).settingsEditor;
    const before = pick(await readState()).id;
    await expect(page.getByText('未保存', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect
      .poll(async () => {
        const e = pick(await readState());
        return e.id !== before && e.saved;
      })
      .toBe(true);
    return pick(await readState()).value;
  };
  await choose('上下文与缓存预算');
  await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('global');
  await override('缓存');
  await select('启用', 'false');
  await select('TTL', '5m');
  assert.deepEqual(await save(), { cache: { enabled: false, ttl: '5m' } });
  await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
  await override('缓存');
  await select('静态前缀 TTL（省略时继承会话 TTL）', '1h');
  assert.deepEqual(await save(), { cache: { staticTtl: '1h' } });
  await page.screenshot({ path: join(out, 'cache-sparse-overrides.png'), fullPage: true });
  await choose('其他运行配置');
  await select('原始工具参数回放（默认关闭）', 'false');
  assert.deepEqual(await save(), { replayToolArguments: false });
  for (const title of ['主任务规划', '摘要模型与预算', '审批模型与预算']) {
    await choose(title);
    await select('Provider', 'fake');
    await text('模型 ID', 'ui-role-' + title + '-' + suffix);
    await select('思考等级', 'off');
    await number('输出 token 上限', 512);
    const value = await save();
    assert.equal(value.provider, 'fake');
    assert.equal(value.thinking, 'off');
    assert.equal(value.maxOutputTokens, 512);
    assert(!Object.hasOwn(value, 'prefixCache'));
    if (title === '摘要模型与预算') {
      assert(!Object.hasOwn(value, 'strategy'));
      await page.screenshot({ path: join(out, 'summary-role-settings.png'), fullPage: true });
    }
  }
  for (const [title, api] of [
    ['OpenAI 兼容协议', 'chat-completions'],
    ['Anthropic 模型能力', 'messages'],
  ]) {
    await choose(title);
    await override('模型 API 能力');
    await page.getByRole('button', { name: '新增 模型 API 能力', exact: true }).click();
    await page.getByRole('textbox', { name: '模型 API 能力 名称 1', exact: true }).fill('fixture');
    await select('API 类型', api);
    await select('支持原始参数回放', 'false');
    assert.equal((await save()).models.fixture.api, api);
  }
  await choose('MCP 结果预算');
  await number('MCP 结果保留天数（0 关闭）', age);
  await number('MCP 结果存储软上限（字节；0 关闭）', storedBytes);
  await number('MCP 单次检索字符上限', searchChars);
  assert.deepEqual(await save(), {
    maxAgeDays: age,
    maxStoredBytes: storedBytes,
    maxSearchChars: searchChars,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      environment: 'Node Playwright + Linux Chromium DPR 2 + isolated FakeProvider worker',
      checks: [
        '全部新增字段可发现',
        'cache 稀疏覆盖',
        'planner/summary/judge 实际表单提交',
        '双 provider 模型能力映射',
        'MCP 存储与检索预算',
        '保守默认不回填',
      ],
      native_macos: false,
    }),
  );
} finally {
  await browser.close();
}
