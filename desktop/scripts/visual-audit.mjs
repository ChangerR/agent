/** 浏览器像素/布局审阅。真实 renderer + 隔离 worker；凭据/无项目桥明确使用虚构样例，非 Electron。 */
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const origin = process.env.AGENTLAB_UI_ORIGIN ?? 'http://127.0.0.1:4378';
const previewURL = new URL(origin);
if (
  previewURL.protocol !== 'http:' ||
  previewURL.hostname !== '127.0.0.1' ||
  previewURL.username ||
  previewURL.password
)
  throw new Error('Visual audit only accepts the isolated local HTTP preview.');
const out = resolve(process.argv[2] ?? join(repo, 'docs/evidence/ui-redesign/after'));
await mkdir(out, { recursive: true });
const call = async (path, value = {}) => {
  const response = await fetch(origin + '/api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!response.ok) throw new Error('Isolated preview request failed: ' + response.status);
  return response.json();
};
const state = await call('snapshot');
if (!state?.globalSettings) throw new Error('Start the isolated desktop preview first.');
const config = state.globalSettings.settings.find((s) => s.id === 'configuration-connection')
  .scopes[0].path;
// 不接受任意 HOME/用户配置路径，只能写 preview 本次创建的临时数据。
if (
  !config.startsWith('/tmp/agentlab-desktop-preview-') ||
  !config.endsWith('/home/.agentlab/config.json')
)
  throw new Error('Only isolated preview fixture paths are writable.');
const base = {
  provider: 'studio',
  model: 'studio-default',
  pluginConfig: {
    'agentlab.planning': { mode: 'off' },
    'agentlab.provider-connections': {
      connections: {
        studio: {
          type: 'openai',
          displayName: '工作用连接',
          enabled: true,
          baseURL: 'http://127.0.0.1:9/v1',
          apiKeyRef: 'cred_' + '1'.repeat(32),
        },
        'long-display-provider': {
          type: 'anthropic',
          displayName: '用于检查长名称换行与侧栏布局的第二个测试连接',
          enabled: true,
          baseURL: 'http://127.0.0.1:9',
        },
      },
    },
  },
};
await mkdir(dirname(config), { recursive: true });
await writeFile(config, JSON.stringify(base, null, 2));
await writeFile(
  join(dirname(config), 'models.json'),
  JSON.stringify(
    {
      'studio-default': {
        displayName: '标准对话模型',
        contextWindow: 131072,
        maxOutputTokens: 8192,
      },
      'careful-code': { displayName: '代码审阅模型', contextWindow: 131072, maxOutputTokens: 8192 },
    },
    null,
    2,
  ),
);
const browser = await chromium.launch({
  executablePath: process.env.AGENTLAB_CHROMIUM ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox'],
});
const reports = [],
  errors = [];
const kind =
  'browser renderer + explicit no-project/credential fixture + isolated real configuration worker; not Electron';
async function capture(page, name, source = kind) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, name + '.png') });
  const metrics = await page.evaluate(() => {
    const selectors = [
      '.app',
      '.sidebar',
      '.workspace',
      '.heading',
      '.configuration-page',
      '.configuration-nav',
      '.configuration-editor',
      '.settings-page-heading',
      '.settings-content',
      '.record-list',
      '.record-details',
      '.credential-panel',
      '.configuration-actions',
    ];
    const boxes = Object.fromEntries(
      selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) return [selector, null];
        const r = element.getBoundingClientRect(),
          c = getComputedStyle(element);
        return [
          selector,
          {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            font: c.fontSize,
            lineHeight: c.lineHeight,
            display: c.display,
            padding: c.padding,
            gap: c.gap,
            overflow: c.overflow,
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          },
        ];
      }),
    );
    const fonts = {},
      unconditional = {},
      all = {};
    for (const e of document.querySelectorAll(
      '.configuration-editor label,.configuration-editor .small,.configuration-editor button,.configuration-nav button',
    )) {
      const c = getComputedStyle(e);
      fonts[c.fontSize] = (fonts[c.fontSize] ?? 0) + 1;
    }
    const walk = (rules, conditional = false) => {
      for (const rule of rules) {
        if (rule.styleSheet) walk(rule.styleSheet.cssRules, conditional);
        if (rule.selectorText) {
          all[rule.selectorText] = (all[rule.selectorText] ?? 0) + 1;
          if (!conditional)
            unconditional[rule.selectorText] = (unconditional[rule.selectorText] ?? 0) + 1;
        }
        if (rule.cssRules) walk(rule.cssRules, conditional || !rule.selectorText);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {}
    }
    const first = [
      ...document.querySelectorAll(
        '.configuration-editor form input:not([type=checkbox]),.configuration-editor form select',
      ),
    ].find((e) => e.getClientRects().length);
    const r = first?.getBoundingClientRect();
    const grids = [
      ...document.querySelectorAll(
        '.record-details .simple-global-field > input,.record-details .simple-global-field > select,.record-details > .map-row > .union-editor > label > select',
      ),
    ].map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, width: r.width, height: r.height };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      boxes,
      fonts,
      alignedDetails: grids,
      duplicateSelectors: Object.entries(all).filter(([, n]) => n > 1),
      unconditionalDuplicateSelectors: Object.entries(unconditional).filter(([, n]) => n > 1),
      firstEditable: r
        ? {
            y: r.y,
            height: r.height,
            visible: r.y >= 0 && r.bottom <= innerHeight,
            hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === first,
          }
        : null,
      bodyOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  reports.push({ name, kind: source, ...metrics });
  expect(metrics.bodyOverflow, name + ' horizontal overflow').toBe(false);
}
async function openSection(page, id) {
  const select = page.getByRole('combobox', { name: '设置页面', exact: true });
  if (await select.isVisible()) await select.selectOption(id);
  else {
    const snapshot = await call('snapshot');
    const title = snapshot.globalSettings.settings.find((s) => s.id === id).title;
    await page
      .locator('.configuration-nav')
      .getByRole('button', { name: title, exact: true })
      .click();
  }
  await expect
    .poll(async () => (await call('snapshot')).globalSettings.settingsEditor?.sectionId)
    .toBe(id);
  await expect(page.getByText('正在读取设置…', { exact: true })).toHaveCount(0);
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await capture(page, '01-projects-desktop-light', 'real renderer web + isolated worker');
  await page.getByRole('button', { name: '离线演示', exact: true }).click();
  await expect(page.getByLabel('输入任务', { exact: true })).toBeEnabled();
  await capture(page, '02-chat-desktop-light', 'real renderer web + isolated FakeProvider worker');
  await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('dark');
  await capture(page, '02-chat-desktop-dark', 'real renderer web + isolated FakeProvider worker');
  await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('light');
  await page.close();
  for (const [size, width, height, scale] of [
    ['desktop', 1440, 960, 1],
    ['narrow', 900, 700, 1],
    ['zoom125', 720, 560, 1.25],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: scale,
    });
    await context.addInitScript(() => {
      const transform = (s) => ({
        ...s,
        projects: [],
        runtime: undefined,
        platform: 'browser',
      });
      let configured = true;
      const call = async (path, data = {}) => {
        const r = await fetch('/api/' + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        });
        const v = await r.json();
        if (!r.ok) throw new Error(v.error ?? 'fixture request failed');
        return v;
      };
      window.agentlab = {
        snapshot: async () => transform(await call('snapshot')),
        onState(listener) {
          const e = new EventSource('/api/events');
          e.onmessage = (m) => listener(transform(JSON.parse(m.data)));
          return () => e.close();
        },
        onNavigate: () => () => {},
        settingsDirty: async () => {},
        globalSettingsRequest: (a) => call('global-settings', a),
        pickProject: async () => {},
        pickDirectory: async () => undefined,
        openProject: async () => {},
        startDemo: async () => {},
        newSession: async () => {},
        request: (a) => call('request', a),
        credentialStatus: async (provider) => ({
          token: 'visual-fixture',
          provider,
          endpoint: 'http://127.0.0.1:9/v1',
          configured,
          available: true,
          backend: 'visual-fixture-only',
        }),
        saveCredential: async (_token, key) => {
          configured = key !== null;
        },
      };
      addEventListener('DOMContentLoaded', () => {
        const b = document.createElement('div');
        b.textContent = '浏览器视觉样例 · 虚构数据';
        b.style.cssText =
          'position:fixed;z-index:9999;bottom:2px;left:5px;font:9px sans-serif;color:#92928e;pointer-events:none';
        document.body.append(b);
      });
    });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(origin);
    await p.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await expect(p.getByRole('combobox', { name: '配置作用域', exact: true })).toHaveValue(
      'global',
    );
    await expect(p.getByText('正在读取设置…', { exact: true })).toHaveCount(0);
    await capture(p, '03-model-settings-' + size + '-light');
    await openSection(p, 'configuration-agentlab.provider-connections');
    await capture(p, '04-provider-settings-' + size + '-light');
    if (size === 'desktop') {
      const list = p.locator('.record-list');
      await list.getByRole('button').filter({ hasText: '用于检查长名称' }).click();
      await capture(p, '06-provider-long-name-desktop');
      const theme = p.locator('select[aria-label="设置界面主题"]');
      await theme.locator('xpath=ancestor::details').locator(':scope > summary').click();
      await theme.selectOption('dark');
      await capture(p, '05-provider-settings-desktop-dark');
      await theme.selectOption('light');
      await theme.locator('xpath=ancestor::details').locator(':scope > summary').click();
    }
    for (const [id, name] of [
      ['configuration-model-catalog', '07-model-catalog'],
      ['configuration-budgets', '08-budgets'],
      ['configuration-permissions', '09-permissions'],
      ['configuration-mcp-servers', '10-mcp-empty'],
    ]) {
      await openSection(p, id);
      await capture(p, name + '-' + size);
    }
    if (size === 'desktop') {
      await openSection(p, 'configuration-budgets');
      const field = p
        .locator('.configuration-field[data-field=maxTurns]')
        .first()
        .locator(':scope > input');
      await field.fill('77');
      await writeFile(config, JSON.stringify({ ...base, maxTurns: 66 }));
      await p.getByRole('button', { name: '保存更改', exact: true }).click();
      await expect(p.locator('.configuration-editor').getByRole('alert')).toBeVisible();
      await capture(p, '11-save-conflict-desktop');
      await writeFile(config, JSON.stringify(base));
      await p.getByRole('button', { name: '放弃更改', exact: true }).click();
      await p.getByRole('button', { name: '重新读取', exact: true }).click();
    }
    await context.close();
  }
  expect(errors).toEqual([]);
  await writeFile(
    join(out, 'computed-layout.json'),
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
        note: 'Browser zoom125 uses CSS720×560 + DPR1.25 as equivalent viewport. Real Electron uses native zoom separately. Fixtures contain no real credential; credential methods here do not validate safeStorage.',
        reports,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'Browser pixel audit captured ' + reports.length + ' states; no body overflow or page error.',
  );
} finally {
  await browser.close();
}
