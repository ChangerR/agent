/** 真实 Electron → preload IPC → Node worker → 配置文件的离线验收。Linux 需 Xvfb。 */
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, chmod, access, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const layoutOnly = process.argv.includes('--layout-only');
const output = resolve(
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    join(repo, 'docs/evidence/graphical-settings'),
);
const root = await mkdtemp(join(tmpdir(), 'agentlab 设置 '));
const home = join(root, 'home'),
  project = join(root, 'settings-project');
await mkdir(join(home, '.agentlab'), { recursive: true });
await mkdir(join(project, '.git'), { recursive: true });
await mkdir(output, { recursive: true });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const store = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const configPath = join(project, 'agent.config.json');
await store(join(home, '.agentlab/config.json'), { cache: { enabled: false, ttl: '5m' } });
await store(configPath, {
  provider: 'acceptance',
  model: 'offline-model',
  permissionMode: 'ask',
  capabilities: { reviewer: false },
  permissions: { ask: ['write_file'] },
  pluginEntries: ['./acceptance.mjs'],
  pluginConfig: { 'agentlab.planning': { mode: 'off' }, 'acceptance.provider': { count: 3 } },
  future: { preserve: 'fixture-metadata' },
});
await writeFile(
  join(project, '.env'),
  '# preserved comment\nFIXTURE_SECRET=private-existing-fixture\n',
);
await writeFile(join(project, 'README.md'), '# Real Electron offline acceptance\n');
await writeFile(
  join(project, 'acceptance.mjs'),
  `
import { appendFileSync } from 'node:fs';
export default {
  manifest: { id: 'acceptance.provider', version: '1.0.0', apiVersion: 1 },
  config: {
    ownedFields: ['count', 'rows'],
    schema: { parse(v) {
      if (v.count !== undefined && (!Number.isInteger(v.count) || v.count < 0)) throw new Error('count must be nonnegative');
      if (v.rows !== undefined && !Array.isArray(v.rows)) throw new Error('rows must be an array');
      return v;
    } },
  },
  setup(ctx) {
    let calls = 0;
    const served = new Set();
    ctx.provide.provider('acceptance', {
      name: 'acceptance', capabilities: { thinking: false, streaming: true },
      async *stream(req) {
        const requests = req.messages.flatMap(message => message.role !== 'user' || message.source === 'runtime' ? [] : typeof message.content === 'string' ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text)).filter(text => text.includes('WRITE_FIXTURE'));
        const last = requests.at(-1), text = last ?? '', key = requests.length + ':' + text;
        appendFileSync(new URL('./provider-trace.jsonl', import.meta.url), JSON.stringify({call: calls, served: [...served], messages:req.messages.map(m=>({role:m.role,source:m.source,kind:typeof m.content,write:typeof m.content==='string' && m.content.includes('WRITE_FIXTURE'),blocks:Array.isArray(m.content)?m.content.map(b=>({type:b.type,write:typeof b.text==='string' && b.text.includes('WRITE_FIXTURE')})):undefined})),requests})+'\\n');
        yield { type: 'message_start' };
        if (last && !served.has(key)) {
          served.add(key);
          const id = 'write-fixture-' + ++calls;
          yield { type: 'tool_use_start', id, name: 'write_file' };
          yield { type: 'tool_use_delta', id, input: JSON.stringify({ path: text.includes('WRITE_FIXTURE_ALLOW') ? 'approval-proof-allowed.txt' : 'approval-proof.txt', content: 'approved in real Electron' }) };
          yield { type: 'tool_use_stop', id };
          yield { type: 'message_stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'OFFLINE_ACCEPTANCE_OK' };
          yield { type: 'message_stop', stopReason: 'end_turn' };
        }
        yield { type: 'usage', inputTokens: 10, outputTokens: 10 };
      },
    });
  },
};
`,
);

// Playwright 的 inspector/debug 参数继续传给真实 run.mjs 和真实 Electron，末端没有替身。
const wrapper = join(root, 'run-app.sh');
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
if (process.platform === 'win32')
  throw new Error('此入口当前在 POSIX shell 下验收；Windows 使用专用 runner。');
await writeFile(
  wrapper,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(repo, 'desktop/scripts/run.mjs'))} "$@"\n`,
);
await chmod(wrapper, 0o700);
const env = Object.fromEntries(
  Object.entries({
    PATH: process.env.PATH,
    DISPLAY: process.env.DISPLAY,
    XAUTHORITY: process.env.XAUTHORITY,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'share'),
    XDG_CACHE_HOME: join(root, 'cache'),
  }).filter(([, value]) => value !== undefined),
);
let app,
  page,
  step = 'launch',
  acceptConfirm = true;
const passed = [],
  pageErrors = [];
const renderedFields = [];
async function launch() {
  app = await _electron.launch({
    executablePath: wrapper,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    cwd: repo,
    env,
    timeout: 60_000,
  });
  page = await app.firstWindow();
  console.log('window navigation', page.url().startsWith('file:') ? 'file' : page.url());
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('renderer console', message.text());
  });
  page.on('requestfailed', (request) =>
    console.error(
      'renderer resource',
      request.url().split('/').at(-1),
      request.failure()?.errorText,
    ),
  );
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    void (acceptConfirm ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  await page.waitForURL(pathToFileURL(join(repo, 'desktop/dist/renderer/index.html')).href, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('button', { name: '打开应用设置', exact: true })).toBeVisible();
}
const snapshot = () => page.evaluate(() => window.agentlab.snapshot());
const editor = () => page.locator('.configuration-editor');
const form = () => editor().locator('form');
// 作用于当前分组的直接字段，避免同名嵌套项互相命中。
const groupField = (group, name) =>
  group.locator(`:scope > .configuration-field[data-field="${name}"]`);
async function openSection(id) {
  const state = await snapshot();
  const section = state.runtime?.settings.find((s) => s.id === id);
  assert.ok(section, 'missing actual registered settings: ' + id);
  await page
    .locator('.configuration-nav')
    .getByRole('button', { name: section.title, exact: true })
    .click();
  await expect.poll(async () => (await snapshot()).runtime?.settingsEditor?.sectionId).toBe(id);
  await expect(editor().getByRole('heading', { name: section.title, exact: true })).toBeVisible();
  await expect(editor().getByText('正在读取设置…', { exact: true })).toHaveCount(0);
}
async function override(group, name) {
  const item = groupField(group, name);
  await item.locator(':scope > .override-label input').check();
  return item;
}
async function save() {
  const before = (await snapshot()).runtime.settingsEditor.id;
  await form().getByRole('button', { name: '提交此节', exact: true }).click();
  await expect
    .poll(async () => {
      const value = (await snapshot()).runtime?.settingsEditor;
      return value?.error || (value?.id !== before && value?.saved ? 'saved' : 'waiting');
    })
    .toBe('saved');
  await expect(editor().getByRole('alert')).toHaveCount(0);
}
async function check(name, run) {
  if (
    layoutOnly &&
    ![
      '真实 run.mjs 开发启动（未提供 Node LICENSE 环境覆盖）',
      '可发现的设置按钮与真实菜单入口',
      '未保存关闭取消、主题持久化、缩放与窄窗口布局',
    ].includes(name)
  )
    return;
  step = name;
  await run();
  passed.push(name);
  console.log('PASS ' + name);
}
async function waitForNewSession(previous) {
  await expect
    .poll(async () => {
      const state = await snapshot(),
        runtime = state.runtime;
      return (
        !!runtime && runtime.sessionId !== previous && runtime.phase === '就绪' && !state.connecting
      );
    })
    .toBe(true);
}
async function exerciseObject(group, schema, path) {
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    if (name === 'apiKeyRef') {
      await expect(groupField(group, name).locator('.managed-reference')).toBeVisible();
      renderedFields.push({ path: path + '.' + name, type: 'managed safe-storage status' });
      continue;
    }
    const node = await override(group, name);
    await exerciseField(node, child, name, path + '.' + name);
  }
}
async function exerciseField(host, schema, name, path) {
  renderedFields.push({
    path,
    type: schema.writeOnly
      ? 'secret'
      : schema['x-rule']
        ? 'rule'
        : schema.anyOf
          ? 'union'
          : (schema.type ?? 'typed'),
  });
  if (schema.writeOnly) {
    await expect(host.locator(':scope > .secret-field')).toBeVisible();
    return;
  }
  if (schema['x-rule']) {
    await expect(host.locator(':scope > .rule-editor select')).toHaveCount(2);
    return;
  }
  const alternatives =
    schema.anyOf ??
    (Array.isArray(schema.type) ? schema.type.map((type) => ({ type })) : undefined);
  if (alternatives) {
    for (const [index, alternative] of alternatives.entries()) {
      await host.locator(':scope > .union-editor > label > select').selectOption(String(index));
      await exerciseField(
        host.locator(':scope > .union-editor'),
        alternative,
        name,
        path + ' [' + index + ']',
      );
    }
    return;
  }
  if (schema.type === 'object' && schema.properties) {
    await exerciseObject(host.locator(':scope > fieldset'), schema, path);
  } else if (schema.type === 'object') {
    const map = host.locator(':scope > .map-editor');
    await map.locator(':scope > .add-record').click();
    const key = map.locator(':scope > .record-details > .map-row > label > input');
    await key.fill('coverageItem');
    await exerciseField(
      map.locator(':scope > .record-details > .map-row'),
      typeof schema.additionalProperties === 'object'
        ? schema.additionalProperties
        : { 'x-any': true },
      name + ' · coverageItem',
      path + '.*',
    );
  } else if (schema.type === 'array') {
    const array = host.locator(':scope > .array-editor');
    await array.locator(':scope > button').click();
    if (name === 'pluginEntries') {
      await expect(
        array.locator('.plugin-entry input[type="text"],.plugin-entry input:not([type])'),
      ).toHaveCount(1);
      await expect(array.locator('.plugin-entry input[type="checkbox"]')).toHaveCount(1);
      renderedFields.push(
        { path: path + '[].entry', type: 'plugin module' },
        { path: path + '[].enabled', type: 'plugin toggle' },
      );
    } else
      await exerciseField(
        array.locator(':scope > .array-row'),
        schema.items ?? { 'x-any': true },
        name + ' 1',
        path + '[]',
      );
  } else if (schema.enum || schema.const !== undefined || schema.type === 'boolean') {
    await expect(host.locator(':scope > select')).toBeVisible();
  } else if (['number', 'integer', 'string'].includes(schema.type)) {
    // 字符串可为 Provider 下拉或带候选列表的输入。
    assert.ok(
      await host.locator(':scope > input,:scope > select').count(),
      'missing primitive control ' + path,
    );
  } else if (schema.type === 'null') {
    await expect(host.getByText('空值（null）', { exact: true })).toBeVisible();
  } else {
    await expect(host.locator(':scope > div > label > select')).toBeVisible();
  }
}
try {
  await check('真实 run.mjs 开发启动（未提供 Node LICENSE 环境覆盖）', async () => {
    await launch();
    const userData = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.ok(!relative(root, userData).startsWith('..'), 'userData must stay in isolated fixture');
    await app.close();
    app = undefined;
    await store(join(userData, 'desktop-preferences.json'), {
      projects: [{ id: project, path: project, name: 'settings-project', demo: false }],
    });
    await launch();
    await page.getByRole('button', { name: '打开项目 settings-project', exact: true }).click();
    await expect.poll(async () => (await snapshot()).runtime?.phase).toBe('就绪');
    assert.equal((await snapshot()).runtime.provider, 'acceptance');
    assert.equal((await snapshot()).runtime.demo, false);
  });
  await check('可发现的设置按钮与真实菜单入口', async () => {
    await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
    await expect(
      editor().getByRole('heading', { name: '主任务与模型连接（启动默认值）', exact: true }),
    ).toBeVisible();
    const menu = await app.evaluate(({ Menu }) => {
      const find = (items) =>
        items.flatMap((i) => [i, ...(i.submenu ? find(i.submenu.items) : [])]);
      const settings = find(Menu.getApplicationMenu().items).find((i) => i.label === '设置…');
      return { accelerator: settings?.accelerator, found: !!settings };
    });
    assert.equal(menu.found, true);
    assert.equal(menu.accelerator, 'CmdOrCtrl+,');
    await page.getByRole('button', { name: '打开项目 settings-project', exact: true }).click();
    await app.evaluate(({ Menu }) => {
      const find = (items) =>
        items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
      const item = find(Menu.getApplicationMenu().items).find((item) => item.label === '设置…');
      item.click();
    });
    await expect(page.getByRole('region', { name: '应用设置', exact: true })).toBeVisible();
    await expect(form().locator('textarea')).toHaveCount(0);
    await page.screenshot({ path: join(output, '01-settings-entry-linux-electron.png') });
  });

  // 后续场景同样操作真实控件；所有测试配置仅存在隔离的临时项目。
  await check('模型目录新增、修改、保存', async () => {
    await openSection('configuration-model-catalog');
    const catalog = await override(form().locator(':scope > fieldset'), 'catalog');
    await catalog.getByRole('button', { name: '新增 模型目录', exact: true }).click();
    await catalog
      .getByRole('textbox', { name: '模型目录 名称 1', exact: true })
      .fill('offline-custom');
    const model = catalog.locator('.map-row > fieldset');
    await (await override(model, 'contextWindow')).getByRole('spinbutton').fill('32000');
    await (await override(model, 'maxOutputTokens')).getByRole('spinbutton').fill('2048');
    await (await override(model, 'displayName')).getByRole('textbox').fill('离线验收模型');
    await save();
    assert.equal(
      (await json(join(project, 'models.json')))['offline-custom'].displayName,
      '离线验收模型',
    );
    assert.equal(
      resolve(project, (await json(configPath)).modelsFile),
      join(project, 'models.json'),
    );
    await page.screenshot({ path: join(output, '02-model-catalog-linux-electron.png') });
  });

  await check('Provider 列表 CRUD、适配器与模型能力嵌套控件', async () => {
    await openSection('configuration-agentlab.provider-connections');
    const connections = await override(form().locator(':scope > fieldset'), 'connections');
    await connections.getByRole('button', { name: '新增 命名连接', exact: true }).click();
    await connections
      .getByRole('textbox', { name: '命名连接 名称 1', exact: true })
      .fill('offlineProfile');
    await connections
      .getByRole('combobox', { name: 'connections · offlineProfile 类型', exact: true })
      .selectOption('2');
    const profile = connections.locator('.map-row .union-editor > fieldset');
    await (await override(profile, 'displayName')).getByRole('textbox').fill('本地验收连接');
    await save();
    assert.equal(
      (await json(configPath)).pluginConfig['agentlab.provider-connections'].connections
        .offlineProfile.type,
      'fake',
    );
    // 网络连接只编辑/保存后删除，不装配、不发送探测请求。
    await connections.getByRole('button', { name: '新增 命名连接', exact: true }).click();
    await connections
      .getByRole('textbox', { name: '命名连接 名称 2', exact: true })
      .fill('temporaryAPI');
    const api = connections
      .locator(':scope > .record-workspace > .record-details > .map-row')
      .last()
      .locator('.union-editor > fieldset');
    await (await override(api, 'baseURL')).getByRole('textbox').fill('https://example.test/v1');
    await (await override(api, 'apiKeyEnv')).getByRole('textbox').fill('ACCEPTANCE_KEY');
    const models = await override(api, 'models');
    await models.getByRole('button', { name: '新增 模型 API 能力', exact: true }).click();
    await models
      .getByRole('textbox', { name: '模型 API 能力 名称 1', exact: true })
      .fill('offline-custom');
    const capability = models.locator('.map-row > fieldset');
    await (
      await override(capability, 'api')
    )
      .getByRole('combobox')
      .selectOption('chat-completions');
    await (
      await override(capability, 'rawToolArguments')
    )
      .getByRole('combobox')
      .selectOption('false');
    await save();
    assert.equal(
      (await json(configPath)).pluginConfig['agentlab.provider-connections'].connections
        .temporaryAPI.models['offline-custom'].api,
      'chat-completions',
    );
    await connections
      .getByRole('button', { name: '删除 命名连接 temporaryAPI', exact: true })
      .click();
    await connections
      .getByRole('textbox', { name: '命名连接 名称 1', exact: true })
      .fill('offlineRenamed');
    await save();
    const saved = (await json(configPath)).pluginConfig['agentlab.provider-connections']
      .connections;
    assert.deepEqual(Object.keys(saved), ['offlineRenamed']);
    assert.equal(saved.offlineRenamed.displayName, '本地验收连接');
    await page.screenshot({ path: join(output, '03-provider-connections-linux-electron.png') });
  });

  await check('作用域稀疏覆盖、继承取消与缓存预算', async () => {
    await openSection('configuration-budgets');
    let cache = await override(form().locator(':scope > fieldset'), 'cache');
    const cacheGroup = cache.locator(':scope > fieldset');
    await (await override(cacheGroup, 'staticTtl')).getByRole('combobox').selectOption('1h');
    await save();
    assert.deepEqual((await json(configPath)).cache, { staticTtl: '1h' });
    assert.deepEqual((await json(join(home, '.agentlab/config.json'))).cache, {
      enabled: false,
      ttl: '5m',
    });
    const effective = (await snapshot()).runtime.settingsEditor.effectiveValue.cache;
    assert.equal(effective.enabled, false);
    assert.equal(effective.ttl, '5m');
    assert.equal(effective.staticTtl, '1h');
    await (
      await override(cache.locator(':scope > fieldset'), 'ttl')
    )
      .getByRole('combobox')
      .selectOption('1h');
    acceptConfirm = false;
    await editor()
      .getByRole('combobox', { name: '配置作用域', exact: true })
      .selectOption('global');
    assert.equal((await snapshot()).runtime.settingsEditor.scope, 'project');
    acceptConfirm = true;
    await form().getByRole('button', { name: '放弃更改', exact: true }).click();
    assert.deepEqual((await json(configPath)).cache, { staticTtl: '1h' });
    await editor()
      .getByRole('combobox', { name: '配置作用域', exact: true })
      .selectOption('global');
    await expect.poll(async () => (await snapshot()).runtime.settingsEditor.scope).toBe('global');
    await (
      await override(form().locator(':scope > fieldset'), 'maxTurns')
    )
      .getByRole('spinbutton')
      .fill('27');
    await save();
    assert.equal((await json(join(home, '.agentlab/config.json'))).maxTurns, 27);
    assert.equal((await json(configPath)).maxTurns, undefined);
    await editor()
      .getByRole('combobox', { name: '配置作用域', exact: true })
      .selectOption('project');
    await expect.poll(async () => (await snapshot()).runtime.settingsEditor.scope).toBe('project');
  });

  await check('MCP stdio、参数排序、env 和 HTTP headers 图形化配置', async () => {
    await openSection('configuration-mcp-servers');
    const servers = await override(form().locator(':scope > fieldset'), 'mcpServers');
    await servers.getByRole('button', { name: '新增 MCP 服务器', exact: true }).click();
    await servers.getByRole('textbox', { name: 'MCP 服务器 名称 1', exact: true }).fill('local');
    let server = servers
      .locator(':scope > .record-workspace > .record-details > .map-row')
      .first()
      .locator('.union-editor > fieldset');
    await (await override(server, 'command')).getByRole('textbox').fill(process.execPath);
    const args = await override(server, 'args');
    for (const [i, value] of [
      '--import',
      require.resolve('tsx'),
      join(repo, 'examples/mcp-server.ts'),
    ].entries()) {
      await args.getByRole('button', { name: '新增 命令参数', exact: true }).click();
      await args.getByLabel(`args ${i + 1}`, { exact: true }).fill(value);
    }
    await args.getByRole('button', { name: '上移 命令参数 3', exact: true }).click();
    await args.getByRole('button', { name: '下移 命令参数 2', exact: true }).click();
    await args.getByRole('button', { name: '新增 命令参数', exact: true }).click();
    await args.getByLabel('args 4', { exact: true }).fill('remove-me');
    await args.getByRole('button', { name: '清除 args 4', exact: true }).click();
    await expect(args.locator('.array-row')).toHaveCount(3);
    const envVars = await override(server, 'env');
    await envVars.getByRole('button', { name: '新增 环境变量', exact: true }).click();
    await envVars
      .getByRole('textbox', { name: '环境变量 名称 1', exact: true })
      .fill('MCP_FIXTURE_TOKEN');
    await envVars
      .getByLabel('env · MCP_FIXTURE_TOKEN', { exact: true })
      .fill('manual-mcp-private-fixture');
    await save();
    assert.equal(
      (await json(join(project, 'mcp.json'))).mcpServers.local.env.MCP_FIXTURE_TOKEN,
      'manual-mcp-private-fixture',
    );
    assert.ok(!JSON.stringify(await snapshot()).includes('manual-mcp-private-fixture'));
    await expect(form().locator('input[type="password"]')).toHaveCount(0);
    await servers
      .getByRole('textbox', { name: 'MCP 服务器 名称 1', exact: true })
      .fill('localRenamed');
    await save();
    assert.equal(
      (await json(join(project, 'mcp.json'))).mcpServers.localRenamed.env.MCP_FIXTURE_TOKEN,
      'manual-mcp-private-fixture',
    );
    await servers.getByRole('button', { name: '新增 MCP 服务器', exact: true }).click();
    await servers
      .getByRole('textbox', { name: 'MCP 服务器 名称 2', exact: true })
      .fill('httpTemporary');
    await servers
      .getByRole('combobox', { name: 'mcpServers · httpTemporary 类型', exact: true })
      .selectOption('1');
    server = servers
      .locator(':scope > .record-workspace > .record-details > .map-row')
      .last()
      .locator('.union-editor > fieldset');
    await (
      await override(server, 'url')
    )
      .getByLabel('服务器 URL', { exact: true })
      .fill('https://example.test/mcp?fixture=private');
    const headers = await override(server, 'headers');
    await headers.getByRole('button', { name: '新增 请求头', exact: true }).click();
    await headers
      .getByRole('textbox', { name: '请求头 名称 1', exact: true })
      .fill('Authorization');
    await headers
      .getByLabel('headers · Authorization', { exact: true })
      .fill('Bearer offline-fixture');
    await save();
    assert.ok(!JSON.stringify(await snapshot()).includes('Bearer offline-fixture'));
    await page.screenshot({ path: join(output, '04-mcp-masked-linux-electron.png') });
    await servers
      .getByRole('button', { name: '删除 MCP 服务器 httpTemporary', exact: true })
      .click();
    await save();
    assert.deepEqual(Object.keys((await json(join(project, 'mcp.json'))).mcpServers), [
      'localRenamed',
    ]);
  });

  await check('凭据不回传、手动替换/清除、项目环境与注释保留', async () => {
    await openSection('configuration-project-environment');
    const variables = await override(form().locator(':scope > fieldset'), 'variables');
    assert.ok(!JSON.stringify(await snapshot()).includes('private-existing-fixture'));
    await expect(variables.getByText('已设置 · 保留原值', { exact: true })).toBeVisible();
    await variables
      .getByRole('button', { name: '替换 variables · FIXTURE_SECRET', exact: true })
      .click();
    await variables
      .getByLabel('variables · FIXTURE_SECRET', { exact: true })
      .fill('replacement-private-fixture');
    await variables.getByRole('button', { name: '新增 项目环境变量', exact: true }).click();
    await variables
      .getByRole('textbox', { name: '项目环境变量 名称 2', exact: true })
      .fill('TEMP_SECRET');
    await variables.getByLabel('variables · TEMP_SECRET', { exact: true }).fill('will-be-cleared');
    await save();
    assert.match(await readFile(join(project, '.env'), 'utf8'), /# preserved comment\n/);
    assert.match(await readFile(join(project, '.env'), 'utf8'), /replacement-private-fixture/);
    assert.ok(!JSON.stringify(await snapshot()).includes('replacement-private-fixture'));
    await variables
      .getByRole('button', { name: '清除 variables · TEMP_SECRET', exact: true })
      .click();
    await save();
    assert.ok(!(await readFile(join(project, '.env'), 'utf8')).includes('TEMP_SECRET='));
    await page.screenshot({ path: join(output, '05-environment-masked-linux-electron.png') });
  });

  await check('辅助角色、请求预算、缓存回放与 MCP 保留策略', async () => {
    for (const id of [
      'agentlab.planning',
      'agentlab.compaction-summary',
      'agentlab.reviewer-model',
    ]) {
      await openSection('configuration-' + id);
      const group = form().locator(':scope > fieldset');
      await (await override(group, 'provider')).getByRole('combobox').selectOption('fake');
      await (
        await override(group, 'model')
      )
        .getByLabel('模型 ID', { exact: true })
        .fill('offline-custom');
      await (await override(group, 'thinking')).getByRole('combobox').selectOption('off');
      await (await override(group, 'maxOutputTokens')).getByRole('spinbutton').fill('1024');
      await (await override(group, 'maxRequestBytes')).getByRole('spinbutton').fill('131072');
      if (id === 'agentlab.planning')
        await (await override(group, 'mode')).getByRole('combobox').selectOption('off');
      await save();
      assert.equal((await json(configPath)).pluginConfig[id].maxRequestBytes, 131072);
    }
    await openSection('configuration-agentlab.mcp');
    const group = form().locator(':scope > fieldset');
    for (const [key, value] of Object.entries({
      maxInlineChars: 10000,
      maxAgeDays: 14,
      maxStoredBytes: 2097152,
      maxSearchChars: 8192,
    })) {
      await (await override(group, key)).getByRole('spinbutton').fill(String(value));
    }
    await (await override(group, 'deduplicate')).getByRole('combobox').selectOption('false');
    await save();
    await openSection('configuration-additional');
    await (
      await override(form().locator(':scope > fieldset'), 'replayToolArguments')
    )
      .getByRole('combobox')
      .selectOption('false');
    await save();
    assert.equal((await json(configPath)).replayToolArguments, false);
  });

  await check('插件列表增删排序与无 Zod 插件的嵌套类型控件', async () => {
    await openSection('configuration-files');
    const entries = await override(form().locator(':scope > fieldset'), 'pluginEntries');
    await entries.getByRole('button', { name: '新增 插件入口', exact: true }).click();
    await entries
      .getByRole('textbox', { name: '插件入口 2 模块', exact: true })
      .fill('./unused.mjs');
    await entries.getByRole('checkbox', { name: '插件入口 2 启用', exact: true }).uncheck();
    await entries.getByRole('button', { name: '上移 插件入口 2', exact: true }).click();
    await save();
    assert.equal((await json(configPath)).pluginEntries[0].enabled, false);
    await entries.getByRole('button', { name: '删除 插件入口 1', exact: true }).click();
    await save();
    assert.deepEqual((await json(configPath)).pluginEntries, ['./acceptance.mjs']);
    await openSection('configuration-acceptance.provider');
    const group = form().locator(':scope > fieldset');
    await (await override(group, 'count')).getByRole('spinbutton').fill('9');
    const rows = await override(group, 'rows');
    await rows.getByRole('combobox', { name: 'rows 值类型', exact: true }).selectOption('array');
    await rows.getByRole('button', { name: '新增 rows', exact: true }).click();
    await rows.getByRole('combobox', { name: 'rows 1 值类型', exact: true }).selectOption('object');
    await rows.getByRole('button', { name: '新增 rows 1', exact: true }).click();
    await rows.getByRole('textbox', { name: 'rows 1 名称 1', exact: true }).fill('budget');
    await rows
      .getByRole('combobox', { name: 'rows 1 · budget 值类型', exact: true })
      .selectOption('number');
    await rows.getByRole('spinbutton').fill('42');
    await save();
    assert.deepEqual((await json(configPath)).pluginConfig['acceptance.provider'], {
      count: 9,
      rows: [{ budget: 42 }],
    });
  });

  await check('校验失败、CAS 冲突、草稿取消与后端错误反馈', async () => {
    await openSection('configuration-acceptance.provider');
    let count = await override(form().locator(':scope > fieldset'), 'count');
    await count.getByRole('spinbutton').fill('-1');
    await form().getByRole('button', { name: '提交此节', exact: true }).click();
    await expect(editor().getByRole('alert')).toBeVisible();
    assert.equal((await json(configPath)).pluginConfig['acceptance.provider'].count, 9);
    await count.getByRole('spinbutton').fill('10');
    const external = await json(configPath);
    external.externalEdit = true;
    await store(configPath, external);
    await form().getByRole('button', { name: '提交此节', exact: true }).click();
    await expect(editor().getByRole('alert')).toBeVisible();
    assert.equal((await json(configPath)).pluginConfig['acceptance.provider'].count, 9);
    assert.equal((await json(configPath)).externalEdit, true);
    await editor().getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(editor().getByRole('alert')).toHaveCount(0);
    count = await override(form().locator(':scope > fieldset'), 'count');
    await count.getByRole('spinbutton').fill('11');
    await count.getByRole('spinbutton').press('Escape');
    await expect(count.getByRole('spinbutton')).toHaveValue('9');
    assert.equal((await json(configPath)).pluginConfig['acceptance.provider'].count, 9);
  });

  await check('权限规则构建器、原生目录选择 IPC 与项目边界校验', async () => {
    await openSection('configuration-permissions');
    const permissions = await override(form().locator(':scope > fieldset'), 'permissions');
    const rules = permissions.locator(':scope > fieldset');
    const deny = await override(rules, 'deny');
    await deny.getByRole('button', { name: '新增 Deny 规则', exact: true }).click();
    await deny.getByRole('combobox', { name: 'deny 1 工具', exact: true }).selectOption('bash');
    await deny
      .getByRole('combobox', { name: 'deny 1 匹配方式', exact: true })
      .selectOption('pattern');
    await deny.getByRole('textbox', { name: 'deny 1 目标', exact: true }).fill('rm *');
    await save();
    assert.deepEqual((await json(configPath)).permissions.ask, ['write_file']);
    assert.deepEqual((await json(configPath)).permissions.deny, ['bash(rm *)']);
    await openSection('policy-deterministic-config');
    const roots = await override(form().locator(':scope > fieldset'), 'writeRoots');
    await roots.getByRole('button', { name: '新增 明确授权的写入目录', exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, home);
    await roots.getByRole('button', { name: '选择目录', exact: true }).click();
    await expect(roots.getByRole('textbox')).toHaveValue(home);
    await form().getByRole('button', { name: '提交此节', exact: true }).click();
    await expect(editor().getByRole('alert')).toBeVisible();
    assert.equal((await json(configPath)).pluginConfig['agentlab.policy'], undefined);
    await roots.getByRole('textbox').fill('.');
    await save();
    assert.deepEqual((await json(configPath)).pluginConfig['agentlab.policy'].writeRoots, ['.']);
    await page.screenshot({ path: join(output, '06-policy-validation-linux-electron.png') });
  });

  await check('全部已注册配置字段和条件分支的真实表单控件覆盖', async () => {
    const sections = (await snapshot()).runtime.settings.filter((section) => section.editable);
    const diskBefore = await readFile(configPath, 'utf8');
    for (const section of sections) {
      await openSection(section.id);
      const resetName =
        {
          'configuration-model-catalog': '清空此文件的自定义模型',
          'configuration-mcp-servers': '清空此文件的服务器',
          'configuration-project-environment': '清空项目环境变量',
        }[section.id] ?? '清除此节的本层覆盖';
      await form().getByRole('button', { name: resetName, exact: true }).click();
      if (section.schema.properties)
        await exerciseObject(form().locator(':scope > fieldset'), section.schema, section.id);
      else
        await exerciseField(
          form().locator(':scope > fieldset'),
          section.schema,
          section.title,
          section.id,
        );
      await expect(form().locator('textarea')).toHaveCount(0);
      await form().getByRole('button', { name: '放弃更改', exact: true }).click();
    }
    assert.ok(sections.length >= 20);
    assert.ok(renderedFields.length >= 160);
    assert.equal(
      await readFile(configPath, 'utf8'),
      diskBefore,
      'coverage drafts cannot write configuration',
    );
    await store(join(output, 'ui-field-coverage.json'), {
      source: 'actual Electron controls',
      sections: sections.length,
      nodes: renderedFields.length,
      fields: renderedFields,
      saved: false,
      explanation: '本场景只检查所有真实字段/分支控件并放弃草稿；持久化/生效由其他逐场景验收覆盖。',
    });
  });

  await check('当前模型/思考/模式选择即保存，工具审批仍逐次确认', async () => {
    const quick = page.locator('.settings-quick').filter({ hasText: '外观与当前会话' });
    await quick.locator(':scope > summary').click();
    const current = (await snapshot()).runtime;
    const candidate = current.models.find((model) => model !== current.model) ?? current.model;
    await page.getByRole('combobox', { name: '设置当前模型', exact: true }).selectOption(candidate);
    await expect.poll(async () => (await json(configPath)).model).toBe(candidate);
    await page.getByRole('combobox', { name: '设置当前思考等级', exact: true }).selectOption('low');
    await expect.poll(async () => (await json(configPath)).thinking).toBe('low');
    await page.getByRole('combobox', { name: '设置当前权限模式', exact: true }).selectOption('ask');
    await expect.poll(async () => (await json(configPath)).permissionMode).toBe('ask');
    await page.getByRole('button', { name: '打开项目 settings-project', exact: true }).click();
    await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('WRITE_FIXTURE');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByRole('region', { name: '工具审批', exact: true })).toBeVisible();
    await assert.rejects(access(join(project, 'approval-proof.txt')));
    await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
    await expect(
      editor().getByText('任务或审批仍在处理中；结算后自动读取设置，当前审批保持待处理。', {
        exact: true,
      }),
    ).toBeVisible();
    assert.equal((await snapshot()).runtime.approvals.length, 1);
    await page.getByRole('button', { name: '打开项目 settings-project', exact: true }).click();
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect.poll(async () => (await snapshot()).runtime.busy).toBe(false);
    await assert.rejects(access(join(project, 'approval-proof.txt')));
    const deniedSession = (await snapshot()).runtime.sessionId;
    // 拒绝上下文的保护不会被测试绕过；明确新建独立会话，再审批另一个文件任务。
    await page.locator('.nav-new').click();
    await waitForNewSession(deniedSession);
    await page
      .getByRole('textbox', { name: '输入任务', exact: true })
      .fill('WRITE_FIXTURE_ALLOW 在另一文件创建新内容');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByRole('region', { name: '工具审批', exact: true })).toBeVisible();
    await assert.rejects(access(join(project, 'approval-proof-allowed.txt')));
    await page.getByRole('button', { name: '仅允许本次', exact: true }).click();
    await expect.poll(async () => (await snapshot()).runtime.busy).toBe(false);
    assert.equal(
      await readFile(join(project, 'approval-proof-allowed.txt'), 'utf8'),
      'approved in real Electron',
    );
    await page.screenshot({ path: join(output, '07-conversation-linux-electron.png') });
    await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
  });

  await check('主任务选用保存的 Provider/模型，关闭重启后真实采用并加载本地 MCP', async () => {
    await openSection('configuration-connection');
    const group = form().locator(':scope > fieldset');
    await (await override(group, 'provider')).getByRole('combobox').selectOption('offlineRenamed');
    await (
      await override(group, 'model')
    )
      .getByLabel('模型 ID', { exact: true })
      .fill('offline-custom');
    await (await override(group, 'thinking')).getByRole('combobox').selectOption('off');
    await save();
    assert.equal((await snapshot()).runtime.provider, 'acceptance');
    await app.close();
    app = undefined;
    await launch();
    await page.getByRole('button', { name: '打开项目 settings-project', exact: true }).click();
    await expect
      .poll(async () => {
        const state = await snapshot();
        return !state.connecting && state.runtime?.provider === 'offlineRenamed';
      })
      .toBe(true);
    assert.match((await snapshot()).runtime.error ?? '', /provider_mismatch/);
    const previous = (await snapshot()).runtime.sessionId;
    // 自动恢复旧会话保留其模型是原契约；明确新建才装配并采用启动默认值。
    await page.locator('.nav-new').click();
    await waitForNewSession(previous);
    await expect.poll(async () => (await snapshot()).runtime?.model).toBe('offline-custom');
    const state = await snapshot();
    assert.equal(state.runtime.provider, 'offlineRenamed');
    assert.equal(state.runtime.mode, 'ask');
    assert.equal(state.runtime.thinking, 'off');
    assert.equal(
      state.runtime.modelDetails.find((m) => m.id === 'offline-custom').contextWindow,
      32000,
    );
    assert.equal(
      state.runtime.modelDetails.find((m) => m.id === 'offline-custom').displayName,
      '离线验收模型',
    );
    assert.ok(
      state.runtime.tools.some((tool) => /localRenamed.*add|add.*localRenamed/.test(tool.name)),
    );
    assert.deepEqual((await json(configPath)).future, { preserve: 'fixture-metadata' });
    assert.equal((await json(configPath)).externalEdit, true);
    await page.getByRole('textbox', { name: '输入任务', exact: true }).fill('offline hello');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect(page.getByText('[fake connection offlineRenamed]', { exact: true })).toBeVisible();
    await expect.poll(async () => (await snapshot()).runtime.busy).toBe(false);
    await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
    await openSection('configuration-model-catalog');
    await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('dark');
    await editor().evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.screenshot({ path: join(output, '08-models-dark-linux-electron.png') });
  });

  await check('项目会话保存、新建、恢复与删除', async () => {
    let sessions = page.locator('.settings-quick').filter({ hasText: '项目与会话管理' });
    await sessions.locator(':scope > summary').click();
    await sessions.getByRole('button', { name: '保存当前会话', exact: true }).click();
    const oldId = (await snapshot()).runtime.sessionId;
    await expect
      .poll(async () => (await snapshot()).runtime.sessions.some((s) => s.id === oldId))
      .toBe(true);
    await sessions.getByRole('button', { name: '重新装配并新建会话', exact: true }).click();
    await waitForNewSession(oldId);
    await page
      .getByRole('textbox', { name: '输入任务', exact: true })
      .fill('second offline session');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect.poll(async () => (await snapshot()).runtime.busy).toBe(false);
    const secondId = (await snapshot()).runtime.sessionId;
    await page.getByRole('button', { name: '打开应用设置', exact: true }).click();
    await page.getByRole('combobox', { name: '配置作用域', exact: true }).selectOption('project');
    sessions = page.locator('.settings-quick').filter({ hasText: '项目与会话管理' });
    await sessions.locator(':scope > summary').click();
    await sessions
      .locator(`[data-session-id="${oldId}"]`)
      .getByRole('button', { name: '恢复', exact: true })
      .click();
    await expect.poll(async () => (await snapshot()).runtime.sessionId).toBe(oldId);
    await sessions
      .locator(`[data-session-id="${secondId}"]`)
      .getByRole('button', { name: '删除记录', exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).runtime.sessions.some((s) => s.id === secondId))
      .toBe(false);
  });

  await check('主题受控 IPC、保存失败反馈和原值保留', async () => {
    const prefs = join(
      await app.evaluate(({ app }) => app.getPath('userData')),
      'desktop-preferences.json',
    );
    assert.equal((await json(prefs)).theme, 'dark');
    const invalid = await page.evaluate(async () => {
      try {
        await window.agentlab.setTheme('../../invalid');
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(invalid, true);
    await rename(prefs, prefs + '.fixture-backup');
    await mkdir(prefs);
    try {
      await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('blue');
      await expect(
        page.getByRole('alert').filter({ hasText: '主题偏好保存失败' }).first(),
      ).toBeVisible();
      assert.equal((await snapshot()).theme, 'dark');
      assert.equal((await json(prefs + '.fixture-backup')).theme, 'dark');
    } finally {
      await rm(prefs, { recursive: true, force: true });
      await rename(prefs + '.fixture-backup', prefs);
    }
    await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('blue');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'blue');
    assert.equal((await json(prefs)).theme, 'blue');
    await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  await check('未保存关闭取消、主题持久化、缩放与窄窗口布局', async () => {
    if (layoutOnly) {
      await page.getByRole('combobox', { name: '桌面主题', exact: true }).selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    }
    await openSection('configuration-budgets');
    await (
      await override(form().locator(':scope > fieldset'), 'maxTurns')
    )
      .getByRole('spinbutton')
      .fill('99');
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect(editor().getByText('未保存', { exact: true })).toBeVisible();
    await expect(form().getByRole('spinbutton', { name: '最大轮数', exact: true })).toHaveValue(
      '99',
    );
    assert.equal((await json(configPath)).maxTurns, undefined);
    await form().getByRole('button', { name: '放弃更改', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(900, 700);
      win.webContents.setZoomFactor(1.25);
    });
    // 对齐 CDP 内容视口与缩放后的 CSS 尺寸，避免只裁切原来的大视口截图。
    await page.setViewportSize({ width: 720, height: 560 });
    if (await page.evaluate(() => innerWidth <= 650))
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
    await form().getByRole('checkbox', { name: '覆盖 缓存', exact: true }).scrollIntoViewIfNeeded();
    await form().getByRole('checkbox', { name: '覆盖 缓存', exact: true }).uncheck();
    await form().getByRole('checkbox', { name: '覆盖 缓存', exact: true }).check();
    const actions = await form().locator('.configuration-actions').boundingBox(),
      viewport = { height: await page.evaluate(() => innerHeight) };
    assert.ok(
      actions &&
        actions.y >= 0 &&
        actions.y < (viewport?.height ?? (await page.evaluate(() => innerHeight))),
      '缩放后保存栏应固定可见',
    );
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      '窄窗口不能横向溢出',
    );
    await page.screenshot({ path: join(output, '09-narrow-zoom-linux-electron.png') });
    await store(join(output, 'layout-bounds.json'), {
      window: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()),
      css: await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        zoom: devicePixelRatio,
      })),
      saveBar: actions,
      platform: process.platform,
      nativeMac: false,
    });
    await form().getByRole('button', { name: '放弃更改', exact: true }).click();
    await expect(
      editor().getByRole('heading', { name: '上下文与缓存预算', exact: true }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.setZoomFactor(1);
      win.setSize(1440, 960);
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    assert.equal(await page.evaluate(() => localStorage.getItem('agentlab-theme')), 'dark');
    await app.close();
    app = undefined;
    await launch();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('agentlab-theme')), 'dark');
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
      'agentlab',
    );
  });

  assert.deepEqual(pageErrors, []);
  await store(
    join(output, layoutOnly ? 'electron-layout-smoke.json' : 'electron-settings-smoke.json'),
    {
      platform: process.platform,
      electron: await app.evaluate(() => process.versions.electron),
      entry: 'node desktop/scripts/run.mjs',
      isolated: true,
      realWorkerAndIPC: true,
      modelRequests: 'local scripted provider only',
      passed,
      pageErrors,
      status: 'passed',
      macNativeTested: false,
    },
  );
  console.log('真实 Electron 设置验收通过：' + passed.length + ' 场景。证据：' + output);
} catch (error) {
  console.error(error);
  console.error(
    'offline fixture trace',
    await readFile(join(project, 'provider-trace.jsonl'), 'utf8').catch(() => '(not entered)'),
  );
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, 'failure-linux-electron.png') }).catch(() => {});
    const s = await snapshot().catch(() => undefined);
    // 不记录草稿或配置值；保留定位信息。
    console.error({
      step,
      phase: s?.runtime?.phase,
      error: s?.error,
      runtimeError: s?.runtime?.error,
      section: s?.runtime?.settingsEditor?.sectionId,
    });
  }
  await store(
    join(output, layoutOnly ? 'electron-layout-smoke.json' : 'electron-settings-smoke.json'),
    {
      platform: process.platform,
      status: 'failed',
      failedStep: step,
      passed,
      pageErrors,
    },
  );
  throw error;
} finally {
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0 });
      })
      .catch(() => {});
    await app.close();
  }
}
