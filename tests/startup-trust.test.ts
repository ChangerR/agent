/** 启动信任与隔离回归只使用临时项目和固定假凭据。 */
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createAgent } from '../src/index.js';
import { loadConfigWithSources } from '../src/core/config.js';
import {
  authorizeStartup,
  inspectStartupTrust,
  StartupTrustRequired,
} from '../src/runtime/startup-trust.js';
import { copyExecutionSnapshot, projectSnapshotExecution } from '../src/builtin/execution/index.js';
import { processEnvironment } from '../src/runtime/process-environment.js';
import { configurationSections } from '../src/builtin/configuration-settings.js';
import { DesktopController } from '../desktop/worker/controller.js';
import { resolveAgentPaths } from '../src/core/paths.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'startup-trust-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  return root;
}
it('项目插件顶层代码在信任前不会执行，批准绑定入口内容', async () => {
  const cwd = await project(),
    plugin = join(cwd, 'plugin.mjs'),
    marker = join(cwd, 'marker');
  await writeFile(
    plugin,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default {manifest:{id:'test.startup',version:'1.0.0',apiVersion:1},setup(){}};`,
  );
  await writeFile(
    join(cwd, 'agent.config.json'),
    JSON.stringify({ provider: 'fake', pluginEntries: ['./plugin.mjs'] }),
  );
  await expect(createAgent(cwd, { autoSaveSessions: false })).rejects.toBeInstanceOf(
    StartupTrustRequired,
  );
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const approve = vi.fn(() => true);
  const agent = await createAgent(cwd, { autoSaveSessions: false, approveStartup: approve });
  expect(approve).toHaveBeenCalledOnce();
  expect(await readFile(marker, 'utf8')).toBe('ran');
  await agent.dispose();
  expect(inspectStartupTrust(loadConfigWithSources(cwd)).entries).toEqual([]);
  await writeFile(
    plugin,
    `export default {manifest:{id:'test.startup',version:'2.0.0',apiVersion:1},setup(){}};`,
  );
  expect(
    inspectStartupTrust(loadConfigWithSources(cwd)).entries.some((entry) =>
      entry.id.startsWith('plugin:'),
    ),
  ).toBe(true);
  await expect(
    createAgent(cwd, { autoSaveSessions: false, approveStartup: () => true }),
  ).rejects.toThrow('plugin_changed_restart_required');
});
it('信任等待期间配置变化不会激活新入口', async () => {
  const cwd = await project();
  await writeFile(
    join(cwd, 'agent.config.json'),
    JSON.stringify({ provider: 'fake', permissions: { allow: ['write_file(src/**)'] } }),
  );
  await expect(
    authorizeStartup(loadConfigWithSources(cwd), {}, async () => {
      await writeFile(
        join(cwd, 'agent.config.json'),
        JSON.stringify({ provider: 'fake', permissions: { allow: ['write_file'] } }),
      );
      return true;
    }),
  ).rejects.toThrow('startup_trust_stale');
});
it('同时批准相同配置不会因另一份相同批准而失效', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  const approve = async () => {
    if (++waiting === 2) release();
    await gate;
    return true;
  };
  await Promise.all([
    authorizeStartup(loadConfigWithSources(cwd), {}, approve),
    authorizeStartup(loadConfigWithSources(cwd), {}, approve),
  ]);
  expect(waiting).toBe(2);
  expect(inspectStartupTrust(loadConfigWithSources(cwd)).entries).toEqual([]);
});
it('短暂的信任记录写锁释放后只重试已经批准的配置', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
  const directory = resolveAgentPaths(cwd).projectStateDir;
  await mkdir(directory, { recursive: true });
  const lock = join(directory, 'startup-trust.json.settings.lock');
  await writeFile(lock, 'test-lock');
  const released = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      rm(lock).then(() => resolve(), reject);
    }, 40);
  });
  try {
    await authorizeStartup(loadConfigWithSources(cwd), {}, () => true);
    expect(inspectStartupTrust(loadConfigWithSources(cwd)).entries).toEqual([]);
  } finally {
    await released;
  }
});
it('MCP 与端点摘要不泄露环境值、请求头值或 URL 凭据', async () => {
  const cwd = await project();
  await writeFile(
    join(cwd, 'agent.config.json'),
    JSON.stringify({
      provider: 'fake',
      mcpConfig: './mcp.json',
      baseURL: 'https://user:TEST_SECRET@example.invalid/v1?token=TEST_SECRET',
    }),
  );
  await writeFile(
    join(cwd, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        remote: {
          url: 'https://user:TEST_SECRET@example.invalid/mcp?token=TEST_SECRET',
          headers: { Authorization: 'TEST_SECRET' },
        },
      },
    }),
  );
  const request = inspectStartupTrust(loadConfigWithSources(cwd));
  expect(request.entries).toHaveLength(2);
  expect(JSON.stringify(request)).not.toContain('TEST_SECRET');
});
it('MCP 启动信任列出显式继承的变量名', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ mcpConfig: './mcp.json' }));
  await writeFile(
    join(cwd, 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: { command: process.execPath, inheritEnv: ['OPENAI_API_KEY'] },
      },
    }),
  );
  const request = inspectStartupTrust(loadConfigWithSources(cwd));
  expect(request.entries[0].summary).toContain('OPENAI_API_KEY');
  expect(request.entries[0].details).toMatchObject({
    inheritedEnvironmentNames: ['OPENAI_API_KEY'],
  });
});
it('拒绝冲突的授权 ID，避免批准后反复进入启动信任', async () => {
  const cwd = await project();
  await writeFile(
    join(cwd, 'agent.config.json'),
    JSON.stringify({
      pluginConfig: {
        'agentlab.policy': {
          resourceRules: ['src/**', 'tests/**'].map((glob) => ({
            id: 'duplicate',
            action: 'allow',
            effects: ['write'],
            resource: { kind: 'file', glob },
          })),
        },
      },
    }),
  );
  expect(() => inspectStartupTrust(loadConfigWithSources(cwd))).toThrow('startup_config_invalid');
});
it('桌面启动信任按 generation、fingerprint 绑定，批准后才装配', async () => {
  const cwd = await project(),
    generation = randomUUID();
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
  const controller = new DesktopController(() => {});
  try {
    await controller.initialize(cwd, false, generation);
    const state = controller.snapshot!;
    expect(state.phase).toBe('等待启动信任');
    expect(state.plugins).toEqual([]);
    await expect(
      controller.handle({
        type: 'trust-startup',
        generation,
        sessionId: state.sessionId,
        fingerprint: '0'.repeat(64),
        allow: true,
      }),
    ).rejects.toThrow('会话已变化');
    await controller.handle({
      type: 'trust-startup',
      generation,
      sessionId: state.sessionId,
      fingerprint: state.startupTrust!.fingerprint,
      allow: true,
    });
    expect(controller.snapshot!.phase).toBe('就绪');
    expect(controller.snapshot!.startupTrust).toBeUndefined();
  } finally {
    await controller.dispose();
  }
});
it('子进程默认环境不带模型凭据和加载器变量，显式列名才传递', () => {
  const source = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'fixed-fake',
    BASH_ENV: '/untrusted',
    LD_PRELOAD: '/untrusted',
  };
  expect(processEnvironment([], source)).toEqual({ PATH: '/usr/bin' });
  expect(processEnvironment(['OPENAI_API_KEY'], source)).toEqual({
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'fixed-fake',
  });
});
it('隔离副本排除凭据、符号链接和硬链接，改副本不影响源文件', async () => {
  const cwd = await project(),
    output = await project();
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/a.ts'), 'original');
  await writeFile(join(cwd, '.env'), 'fixed-fake-secret');
  await symlink(join(cwd, '.env'), join(cwd, 'alias'));
  await link(join(cwd, '.env'), join(cwd, 'hard-alias'));
  await copyExecutionSnapshot(cwd, output, [], new AbortController().signal);
  expect(await readFile(join(output, 'src/a.ts'), 'utf8')).toBe('original');
  for (const name of ['.env', 'alias', 'hard-alias'])
    await expect(readFile(join(output, name))).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(join(output, 'src/a.ts'), 'changed');
  expect(await readFile(join(cwd, 'src/a.ts'), 'utf8')).toBe('original');
});
it('隔离探针未通过时拒绝执行；通过时仅能修改副本且不能读取宿主 HOME', async () => {
  const cwd = await project(),
    execution = projectSnapshotExecution(cwd),
    signal = new AbortController().signal;
  await writeFile(join(cwd, 'file.txt'), 'source');
  const status = await execution.status(signal);
  const result = await execution.execute(
    {
      file: 'bash',
      args: ['-c', 'echo changed > file.txt; test "$HOME" = /home/agent'],
      cwd,
      timeoutMs: 3000,
    },
    signal,
  );
  expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('source');
  if (status.available) {
    expect(result.isError).toBe(false);
    expect(result.content).toContain('改动未回写');
  } else {
    expect(result.isError).toBe(true);
    expect(result.content).toContain('sandbox_unavailable');
  }
});

it('设置页显式保存项目模式后启动不再次确认同一模式', async () => {
  const cwd = await project(),
    signal = new AbortController().signal;
  const section = configurationSections(cwd).find(
    (value) => value.id === 'configuration-permissions',
  )!.section;
  await section.read!(signal, 'project');
  const draft = await section.draft!({ permissionMode: 'auto' }, signal, 'project');
  await section.commit!(draft, signal, 'project');
  expect(inspectStartupTrust(loadConfigWithSources(cwd)).entries).toEqual([]);
});
