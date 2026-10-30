/** Electron → preload → main → SSH → worker → 本机 mock API 的图形验收。 */
import { _electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const target = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'ubuntu@10.100.0.8';
const packaged = process.argv.includes('--packaged');
if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(target)) throw new Error('INVALID_TARGET');
const prior = JSON.parse(await readFile('desktop/.validation/remote/ssh-smoke.json', 'utf8'));
const base = prior.remoteRoot;
if (!/^\/tmp\/agentlab-ssh-test-[a-f0-9-]+$/.test(base)) throw new Error('INVALID_TEST_ROOT');
const project = base + '/ui-project-' + randomUUID(),
  home = await mkdtemp(join(tmpdir(), 'agentlab-remote-ui-'));
const secondProject = base + '/ui-second-project-' + randomUUID();
const output = resolve('desktop/.validation/remote');
await mkdir(join(home, '.agentlab'), { recursive: true });
const key = 'ssh-ui-fixed-fake-' + randomUUID();
let rounds = 0,
  requests = 0;
const server = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  assert.equal(req.headers.authorization, 'Bearer ' + key);
  requests++;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const push = (delta, reason = null) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'ui-' + rounds,
          choices: [{ index: 0, delta, finish_reason: reason }],
        }) +
        '\n\n',
    );
  rounds++;
  if (rounds === 1) {
    push({
      tool_calls: [
        {
          index: 0,
          id: 'ui-read',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
        },
      ],
    });
    push({}, 'tool_calls');
  } else if (rounds === 2) {
    push({
      tool_calls: [
        {
          index: 0,
          id: 'ui-write',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'ui-proof.txt', content: 'SSH_ELECTRON_APPROVED' }),
          },
        },
      ],
    });
    push({}, 'tool_calls');
  } else {
    push({ content: 'SSH_ELECTRON_UI_COMPLETE' });
    push({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await writeFile(
  join(home, 'models.json'),
  JSON.stringify({ 'ssh-ui': { contextWindow: 200000, maxOutputTokens: 4096 } }),
);
await writeFile(
  join(home, '.agentlab/config.json'),
  JSON.stringify({
    provider: 'openai',
    model: 'ssh-ui',
    baseURL: 'http://127.0.0.1:' + port + '/v1',
    apiKeyEnv: 'AGENTLAB_SSH_UI_KEY',
    modelsFile: join(home, 'models.json'),
  }),
);
const fixture = Buffer.from(
  JSON.stringify({
    provider: 'openai',
    model: 'ssh-ui',
    permissions: { allow: [], deny: [], ask: ['write_file'] },
    capabilities: { reviewer: false },
    pluginConfig: { 'agentlab.planning': { mode: 'off' } },
  }),
).toString('base64');
execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', target, 'sh -s'], {
  input: `set -eu\nmkdir -p '${project}' '${secondProject}'\nprintf '%s' '${fixture}' | base64 -d > '${project}/agent.config.json'\nprintf '%s' '${fixture}' | base64 -d > '${secondProject}/agent.config.json'\nprintf 'SSH_UI_READ_OK\\n' > '${project}/README.md'\n`,
  windowsHide: true,
});
let app;
try {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENTLAB_REMOTE_TEST_HOME: base + '/home',
    AGENTLAB_SSH_UI_KEY: key,
    ANTHROPIC_API_KEY: 'test-only-never-sent',
    OPENAI_API_KEY: 'test-only-never-sent',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.OPENAI_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const launchOptions = {
    ...(packaged
      ? { executablePath: resolve('desktop/release/agentlab-win32-x64/agentlab.exe') }
      : {}),
    args: [
      ...(packaged ? [] : [resolve('desktop/dist')]),
      '--user-data-dir=' + join(home, 'electron'),
    ],
    env,
    timeout: 30000,
  };
  app = await _electron.launch(launchOptions);
  let page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // 尚未打开运行时时也能从全局入口选工作位置；取消不创建会话。
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '新建会话', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建项目…', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(() => window.agentlab.snapshot())).runtime, undefined);
  assert.equal(requests, 0);
  await page.getByRole('button', { name: '添加主机', exact: true }).click();
  await page.getByLabel('SSH 主机', { exact: true }).fill(target);
  await page.getByLabel('主机名称', { exact: true }).fill('内网 Ubuntu');
  await expect(page.getByLabel('远程目录', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('本机模型连接', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(output, '01-remote-form.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '添加主机', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 30000 });
  const added = await page.evaluate(() => window.agentlab.snapshot());
  assert.equal(added.remoteHosts.length, 1);
  assert.equal(added.projects.length, 0);
  assert.equal(added.runtime, undefined);
  assert.equal(requests, 0);
  const preferences = await app.evaluate(async ({ app }) => app.getPath('userData'));
  const persisted = JSON.parse(
    await readFile(join(preferences, 'desktop-preferences.json'), 'utf8'),
  );
  assert.equal(persisted.remoteHosts.length, 1);
  assert.equal(persisted.projects.length, 0);
  await page.screenshot({ path: join(output, '01b-host-saved.png'), fullPage: true });
  await app.close();
  app = await _electron.launch(launchOptions);
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByRole('button', { name: '打开主机项目 内网 Ubuntu', exact: true }),
  ).toBeVisible();
  const restarted = await page.evaluate(() => window.agentlab.snapshot());
  assert.equal(restarted.remoteHosts[0].id, added.remoteHosts[0].id);
  assert.equal(restarted.projects.length, 0);
  assert.equal(requests, 0);
  await page.getByRole('button', { name: '打开主机项目 内网 Ubuntu', exact: true }).click();
  await expect(page.getByLabel('远程目录', { exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByLabel('远程目录', { exact: true }).fill(base);
  await page.getByRole('button', { name: '转到', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '进入目录 ' + project.split('/').at(-1), exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole('button', { name: '进入目录 ' + project.split('/').at(-1), exact: true })
    .click();
  await expect(page.getByRole('button', { name: '打开此目录为项目', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.screenshot({ path: join(output, '01c-project-picker.png'), fullPage: true });
  await page.getByRole('button', { name: '打开此目录为项目', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  await expect(page.locator('.remote-identity')).toContainText(target);
  const input = page.locator('textarea').filter({ visible: true }).first();
  await input.fill('SSH_UI_PROBE 读取 README.md 并写入证明文件');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '仅允许本次', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({ path: join(output, '02-remote-approval.png'), fullPage: true });
  await page.getByRole('button', { name: '仅允许本次', exact: true }).click();
  await expect(page.getByText('SSH_ELECTRON_UI_COMPLETE', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  assert.equal(
    execFileSync(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', target, "cat '" + project + "/ui-proof.txt'"],
      { encoding: 'utf8', windowsHide: true },
    ),
    'SSH_ELECTRON_APPROVED',
  );
  await page.screenshot({ path: join(output, '03-remote-complete.png'), fullPage: true });
  const state = await page.evaluate(() => window.agentlab.snapshot());
  assert(!JSON.stringify(state).includes(key));
  assert(state.runtime.remote.connected);
  await page.setViewportSize({ width: 820, height: 720 });
  await page.screenshot({ path: join(output, '04-remote-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '所有项目', exact: true }).click();
  await page
    .locator('.projects-toolbar')
    .getByRole('button', { name: '打开项目', exact: true })
    .click();
  await page.getByLabel('项目位置', { exact: true }).selectOption(added.remoteHosts[0].id);
  await expect(page.getByLabel('远程目录', { exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByLabel('远程目录', { exact: true }).fill(secondProject);
  await page.getByRole('button', { name: '转到', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开此目录为项目', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '打开此目录为项目', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  const second = await page.evaluate(() => window.agentlab.snapshot());
  assert.equal(second.remoteHosts.length, 1);
  assert.equal(second.projects.length, 2);
  assert.equal(second.runtime.cwd, secondProject);
  assert(second.projects.every((p) => p.remoteHostId === added.remoteHosts[0].id));
  await page.setViewportSize({ width: 1424, height: 900 });
  const newSession = () => page.getByRole('button', { name: '新建会话', exact: true }).click();
  const snapshot = () => page.evaluate(() => window.agentlab.snapshot());
  const firstProject = second.projects.find((p) => p.path === project);
  await newSession();
  await page.getByLabel('会话工作位置', { exact: true }).selectOption(added.remoteHosts[0].id);
  await page.getByLabel('搜索会话项目', { exact: true }).fill(firstProject.name);
  await page.screenshot({ path: join(output, '05-new-session-projects.png'), fullPage: true });
  await page
    .getByRole('button', { name: '在项目 ' + firstProject.name + ' 中新建会话', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  const fresh = await snapshot();
  assert.equal(fresh.runtime.cwd, project);
  assert.notEqual(fresh.runtime.sessionId, state.runtime.sessionId);
  assert.equal(fresh.runtime.rows.length, 0);
  assert(fresh.runtime.sessions.some((s) => s.id === state.runtime.sessionId));
  assert.equal(requests, 3);
  await newSession();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await snapshot()).runtime.sessionId, fresh.runtime.sessionId);
  await page.getByRole('button', { name: '新建当前项目会话', exact: true }).click();
  await expect
    .poll(
      async () => {
        const current = await snapshot();
        return (
          !current.connecting &&
          !!current.runtime &&
          current.runtime.sessionId !== fresh.runtime.sessionId
        );
      },
      { timeout: 90000 },
    )
    .toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal((await snapshot()).runtime.cwd, project);

  // 打开其他项目也必须新建空上下文，不能恢复目标目录的最近会话。
  await newSession();
  await page.getByRole('button', { name: '打开其他项目…', exact: true }).click();
  await expect(page.getByLabel('远程目录', { exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByLabel('远程目录', { exact: true }).fill(project);
  await page.getByRole('button', { name: '转到', exact: true }).click();
  await expect(page.getByRole('button', { name: '在此项目新建会话', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '在此项目新建会话', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  const openedFresh = await snapshot();
  assert.equal(openedFresh.runtime.rows.length, 0);
  assert.notEqual(openedFresh.runtime.sessionId, state.runtime.sessionId);

  // 在已保存主机上新建目录并立即进入新会话，浏览父目录时不会切换工作区。
  const newRemoteName = 'new-session-project-' + randomUUID();
  await newSession();
  await page.getByRole('button', { name: '新建项目…', exact: true }).click();
  await page.getByRole('button', { name: '浏览…', exact: true }).click();
  await expect(page.getByLabel('远程目录', { exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByLabel('远程目录', { exact: true }).fill(base);
  await page.getByRole('button', { name: '转到', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择此目录', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: '选择此目录', exact: true }).click();
  await expect(page.getByLabel('新项目父目录', { exact: true })).toHaveValue(base);
  assert.equal((await snapshot()).runtime.sessionId, openedFresh.runtime.sessionId);
  await page.getByLabel('新项目名称', { exact: true }).fill(newRemoteName);
  await page.screenshot({ path: join(output, '06-new-remote-project.png'), fullPage: true });
  await page.getByRole('button', { name: '创建项目并新建会话', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  const createdRemote = await snapshot();
  assert.equal(createdRemote.runtime.cwd, base + '/' + newRemoteName);
  assert.equal(createdRemote.runtime.rows.length, 0);
  assert.equal(createdRemote.runtime.remote.target, target);
  assert.equal(
    execFileSync(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        target,
        "cat '" + base + '/' + newRemoteName + "/agent.config.json'",
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
    '{}\n',
  );

  // 本地原生目录选择由测试桩返回隔离目录，不接触用户的项目。
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, home);
  await newSession();
  await page.getByRole('button', { name: '新建项目…', exact: true }).click();
  await page.getByLabel('新项目位置', { exact: true }).selectOption('local');
  await page.getByRole('button', { name: '浏览…', exact: true }).click();
  await expect(page.getByLabel('新项目父目录', { exact: true })).toHaveValue(home);
  await page.getByLabel('新项目名称', { exact: true }).fill('local-new-project');
  await page.getByRole('button', { name: '创建项目并新建会话', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  const createdLocal = await snapshot();
  assert.equal(createdLocal.runtime.cwd, join(home, 'local-new-project'));
  assert.equal(createdLocal.runtime.rows.length, 0);
  assert.equal(createdLocal.runtime.remote, undefined);
  assert.equal(await readFile(join(home, 'local-new-project/agent.config.json'), 'utf8'), '{}\n');
  assert.equal(requests, 3);
  await newSession();
  await expect(page.locator('.new-session-project')).toHaveCount(4);
  await page.getByLabel('会话工作位置', { exact: true }).selectOption('local');
  await expect(page.locator('.new-session-project')).toHaveCount(1);
  await page.getByLabel('会话工作位置', { exact: true }).selectOption(added.remoteHosts[0].id);
  await expect(page.locator('.new-session-project')).toHaveCount(3);
  await page.screenshot({
    path: join(output, '07-mixed-project-session-picker.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: '在项目 ' + firstProject.name + ' 中新建会话', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 90000 });
  assert.equal((await snapshot()).runtime.cwd, project);
  assert.equal((await snapshot()).runtime.rows.length, 0);
  assert.equal(requests, 3);
  await writeFile(
    join(output, 'electron-smoke.json'),
    JSON.stringify(
      {
        ok: true,
        packaged,
        target,
        project,
        requests,
        sessionId: state.runtime.sessionId,
        remoteKeyInRenderer: false,
        hostSavedBeforeProject: true,
        savedHostCount: added.remoteHosts.length,
        projectCountImmediatelyAfterHost: added.projects.length,
        browsedProjectDirectory: true,
        hostRestoredAfterRestart: true,
        multipleProjectsOnOneHost: true,
        newSessionWithoutRuntime: true,
        projectChooserLocalAndRemote: true,
        selectedProjectStartsFreshSession: true,
        oldConversationPreserved: true,
        projectScopedNewSession: true,
        cancelPreservesCurrentSession: true,
        openDirectoryStartsFreshSession: true,
        createRemoteProjectAndSession: true,
        browseParentWithoutSwitchingSession: true,
        createLocalProjectAndSession: true,
        switchLocalToRemoteForNewSession: true,
        newSessionModelRequests: 0,
      },
      null,
      2,
    ),
  );
  console.log('SSH Electron UI smoke passed');
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
