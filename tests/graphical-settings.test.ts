/** 图形设置背后的真实配置事务：领域 CRUD、未知保留、凭据隔离和运行时采用。 */
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAgent, type Agent } from '../src/index.js';
import { AgentConfigSchema, loadConfigWithSources } from '../src/core/config.js';
import { mcpSettingsSection } from '../src/builtin/mcp-settings.js';
import { modelSettingsSection } from '../src/builtin/model-settings.js';
import {
  environmentSettingsSection,
  patchEnvironment,
} from '../src/builtin/environment-settings.js';
import {
  providerConnectionsPlugin,
  CONNECTIONS_PLUGIN,
} from '../src/builtin/provider-connections.js';
import { configurationSections } from '../src/builtin/configuration-settings.js';
import { DesktopController } from '../desktop/worker/controller.js';
import { parseEnv } from 'node:util';
import { defaultPreset } from '../src/builtin/default-preset.js';
import type { Plugin } from '../src/sdk/index.js';
let root: string, home: string, cwd: string;
const agents: Agent[] = [];
const signal = () => new AbortController().signal;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-graph-settings-'));
  home = join(root, 'home');
  cwd = join(root, 'project');
  await mkdir(join(home, '.agentlab'), { recursive: true });
  await mkdir(join(cwd, '.git'), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  await save(join(cwd, 'agent.config.json'), {
    provider: 'fake',
    pluginConfig: { 'agentlab.planning': { mode: 'off' } },
  });
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.dispose()));
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it('MCP 可新增、重命名、重排、替换与清除凭据，原文不回传，未知元数据保留', async () => {
  const file = join(cwd, 'mcp.json');
  await save(file, {
    future: 1,
    mcpServers: {
      old: {
        command: 'node',
        args: ['first-secret', 'second-secret'],
        env: { TOKEN: 'environment-secret' },
        future: { keep: 1 },
      },
    },
  });
  const section = mcpSettingsSection(cwd, file);
  const raw = (await section.read!(signal())) as any;
  expect(JSON.stringify(raw)).not.toMatch(/first-secret|second-secret|environment-secret/);
  const server = raw.mcpServers.old;
  server.args.reverse();
  server.env.RENAMED = server.env.TOKEN;
  delete server.env.TOKEN;
  raw.mcpServers.renamed = server;
  delete raw.mcpServers.old;
  await section.commit!(await section.draft!(raw, signal()), signal());
  expect((await json(file)).mcpServers.renamed).toEqual({
    command: 'node',
    args: ['second-secret', 'first-secret'],
    env: { RENAMED: 'environment-secret' },
    future: { keep: 1 },
  });
  const next = (await section.read!(signal())) as any;
  delete next.mcpServers.renamed.args;
  next.mcpServers.renamed.env.RENAMED = 'replacement-secret';
  next.mcpServers.remote = {
    url: 'https://example.test/mcp?token=private-url',
    headers: { Authorization: 'Bearer manual-secret' },
  };
  await section.commit!(await section.draft!(next, signal()), signal());
  const view = await section.read!(signal());
  expect(JSON.stringify(view)).not.toMatch(/replacement-secret|manual-secret|private-url/);
  expect((await json(file)).mcpServers.remote.headers.Authorization).toBe('Bearer manual-secret');
  const forged = structuredClone(view) as any;
  forged.mcpServers.remote.headers.Authorization = { $secret: crypto.randomUUID() };
  expect(() => section.draft!(forged, signal())).toThrow();
  const stale = await section.draft!(view, signal());
  await save(file, { external: true });
  expect(() => section.commit!(stale, signal())).toThrow();
  expect(await json(file)).toEqual({ external: true });
});

it('项目 .env 只在手动提交时写入，保留注释、多行和未知行，掩码/取消/CAS 不泄露', async () => {
  const file = join(cwd, '.env'),
    before = '# keep comment\nUNCHANGED=`line 1\nline 2`\nKEY=old-private\n# tail\nUNPARSED LINE\n';
  await writeFile(file, before);
  const section = environmentSettingsSection(cwd);
  const raw = (await section.read!(signal())) as any;
  expect(JSON.stringify(raw)).not.toContain('old-private');
  expect(await readFile(file, 'utf8')).toBe(before);
  raw.variables.KEY = 'new-private';
  raw.variables.NEW_KEY = 'quote\'" value';
  const draft = await section.draft!(raw, signal());
  const abort = new AbortController();
  abort.abort();
  expect(() => section.commit!(draft, abort.signal)).toThrow();
  expect(await readFile(file, 'utf8')).toBe(before);
  await section.commit!(draft, signal());
  const text = await readFile(file, 'utf8');
  expect(text).toContain('# keep comment\nUNCHANGED=`line 1\nline 2`');
  expect(text).toContain('UNPARSED LINE');
  expect(parseEnv(text)).toMatchObject({
    KEY: 'new-private',
    NEW_KEY: 'quote\'" value',
    UNCHANGED: 'line 1\nline 2',
  });
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(process.env.NEW_KEY).toBeUndefined();
  expect(JSON.stringify(await section.read!(signal()))).not.toContain('new-private');
  const stale = await section.draft!({}, signal());
  await writeFile(file, 'EXTERNAL=1\n');
  expect(() => section.commit!(stale, signal())).toThrow();
  expect(await readFile(file, 'utf8')).toBe('EXTERNAL=1\n');
  expect(patchEnvironment('A=one\nA=two\n# c\n', { B: 'literal\\nvalue' })).toContain('# c');
});

it('模型目录 CRUD 保存 ID、显示名、上下文/输出上限并在重启后真正采用，重命名保留未知项', async () => {
  const file = join(cwd, 'models.json');
  await save(file, {
    old: { contextWindow: 8192, maxOutputTokens: 512, future: { keep: 'not-to-render' } },
  });
  const section = modelSettingsSection(cwd),
    raw = (await section.read!(signal())) as any;
  expect(JSON.stringify(raw)).not.toContain('not-to-render');
  raw.catalog.custom = raw.catalog.old;
  delete raw.catalog.old;
  Object.assign(raw.catalog.custom, {
    displayName: '我的模型',
    contextWindow: 32000,
    maxOutputTokens: 1024,
  });
  await section.commit!(await section.draft!(raw, signal()), signal());
  expect((await json(file)).custom.future).toEqual({ keep: 'not-to-render' });
  const agent = await createAgent(cwd);
  agents.push(agent);
  expect(agent.modelInfo('custom')).toMatchObject({
    displayName: '我的模型',
    contextWindow: 32000,
    maxOutputTokens: 1024,
  });
  const next = (await section.read!(signal())) as any;
  next.catalog.custom.contextWindow = -1;
  expect(() => section.draft!(next, signal())).toThrow();
  await section.read!(signal());
  await section.commit!(await section.draft!({}, signal()), signal());
  expect(await json(file)).toEqual({});
});

it.skipIf(process.platform === 'win32')(
  '领域文件拒绝父目录符号链接逃逸，不提供任意文件写入',
  async () => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await save(join(outside, 'catalog.json'), { existing: { contextWindow: 20 } });
    await symlink(outside, join(cwd, 'linked'), 'dir');
    await save(join(cwd, 'agent.config.json'), {
      provider: 'fake',
      modelsFile: 'linked/catalog.json',
      mcpConfig: 'linked/mcp.json',
    });
    expect(() => modelSettingsSection(cwd).read!(signal())).toThrow();
    expect(() => mcpSettingsSection(cwd).read!(signal())).toThrow();
    expect(await json(join(outside, 'catalog.json'))).toEqual({ existing: { contextWindow: 20 } });
  },
);

it('命名 Provider CRUD 进入真实注册表，保留预算方法/路由隔离，已引用连接不能删除', async () => {
  const file = join(cwd, 'agent.config.json');
  await save(file, {
    provider: 'named',
    model: 'model-one',
    capabilities: { reviewer: false },
    pluginConfig: {
      [CONNECTIONS_PLUGIN]: {
        connections: {
          named: { type: 'fake' },
          apiOne: { type: 'openai', baseURL: 'https://a.test/v1' },
          apiTwo: { type: 'openai', baseURL: 'https://a.test/v1' },
        },
      },
      'agentlab.planning': { mode: 'off' },
    },
  });
  const agent = await createAgent(cwd);
  agents.push(agent);
  expect(agent.providers.list().map((p) => p.name)).toEqual(
    expect.arrayContaining(['named', 'apiOne', 'apiTwo']),
  );
  const a = agent.providers.get('apiOne'),
    b = agent.providers.get('apiTwo');
  expect(a.routeId).not.toBe(b.routeId);
  expect(a.requestBytes).toBeTypeOf('function');
  expect(a.normalizeRequest).toBeTypeOf('function');
  await agent.loop.run('offline');
  expect(
    agent.loop.getMessages().some((m) => JSON.stringify(m).includes('[fake connection named]')),
  ).toBe(true);
  expect(agent.permission.mode).toBe('ask');
  const section = configurationSections(cwd, [
    providerConnectionsPlugin(cwd, loadConfigWithSources(cwd).config),
  ]).find((s) => s.id === 'configuration-' + CONNECTIONS_PLUGIN)!.section;
  await section.read!(signal());
  expect(() => section.draft!({ connections: {} }, signal())).toThrow();
  const config = await json(file);
  config.provider = 'fake';
  await save(file, config);
  await section.read!(signal());
  await section.commit!(await section.draft!({ connections: {} }, signal()), signal());
  expect((await json(file)).pluginConfig[CONNECTIONS_PLUGIN].connections).toEqual({});
});

it('实际装配的外部插件 ownedFields 也有图形 schema，敏感引用不回传', async () => {
  await save(join(cwd, 'agent.config.json'), {
    provider: 'fake',
    pluginConfig: {
      custom: {
        rows: [{ name: 'one', values: [1, 2] }],
        credential: 'env:TEST_ONLY',
        future: 'unknown-private',
      },
    },
  });
  const agent = await createAgent(cwd, {
    plugins: [
      {
        manifest: { id: 'custom', version: '1.0.0', apiVersion: 1 },
        config: {
          schema: z.object({
            rows: z.array(z.object({ name: z.string(), values: z.array(z.number()) })),
            credential: z.string().optional(),
          }),
          ownedFields: ['rows', 'credential'],
          sensitiveFields: ['credential'],
        },
        setup() {},
      },
    ],
  });
  agents.push(agent);
  const section = agent.settings.find((s) => s.id === 'configuration-custom')!.section;
  expect(section.schema.properties).toHaveProperty('rows');
  const value = await section.read!(signal());
  expect(JSON.stringify(value)).not.toMatch(/TEST_ONLY|unknown-private/);
  const raw = value as any;
  raw.rows[0].values.reverse();
  await section.commit!(await section.draft!(raw, signal()), signal());
  expect((await json(join(cwd, 'agent.config.json'))).pluginConfig.custom).toMatchObject({
    rows: [{ name: 'one', values: [2, 1] }],
    credential: 'env:TEST_ONLY',
    future: 'unknown-private',
  });
});

it('全部真实顶层字段和实际插件字段覆盖可渲染 schema，没有空 JSON 编辑兜底', async () => {
  let plugins: readonly Plugin[] = [];
  const controller = new DesktopController(
    () => {},
    (cwd, options) =>
      createAgent(cwd, {
        ...options,
        preset(input) {
          const preset = defaultPreset(input);
          plugins = preset.plugins;
          return preset;
        },
      }),
  );
  try {
    await controller.initialize(cwd, true, crypto.randomUUID());
    const snapshot = controller.snapshot!;
    const covered = new Set(
      snapshot.settings
        .filter((s) => s.id.startsWith('configuration-'))
        .flatMap((s) => Object.keys(s.schema.properties ?? {})),
    );
    for (const key of Object.keys(AgentConfigSchema.shape))
      if (!['pluginConfig', 'capabilities'].includes(key)) expect(covered.has(key), key).toBe(true);
    for (const id of [
      'configuration-model-catalog',
      'configuration-project-environment',
      'configuration-mcp-servers',
      'configuration-' + CONNECTIONS_PLUGIN,
      'capability-selection',
      'policy-deterministic-config',
    ])
      expect(
        snapshot.settings.some((s) => s.id === id),
        id,
      ).toBe(true);
    const walk = (s: any): void => {
      expect(!!(s.type || s.anyOf || s['x-any']), JSON.stringify(s)).toBe(true);
      if (s.anyOf) s.anyOf.forEach(walk);
      if (s.items) walk(s.items);
      if (typeof s.additionalProperties === 'object') walk(s.additionalProperties);
      Object.values(s.properties ?? {}).forEach(walk);
    };
    snapshot.settings.filter((s) => s.editable).forEach((s) => walk(s.schema));
    for (const plugin of plugins) {
      if (!plugin.config?.ownedFields?.length) continue;
      const id =
        plugin.manifest.id === 'agentlab.policy'
          ? 'policy-deterministic-config'
          : 'configuration-' + plugin.manifest.id;
      const properties = snapshot.settings.find((s) => s.id === id)?.schema.properties as
        Record<string, unknown> | undefined;
      for (const field of plugin.config.ownedFields)
        expect(properties && Object.hasOwn(properties, field), id + '.' + field).toBe(true);
      if (plugin.config.schema instanceof z.ZodObject)
        for (const field of Object.keys(plugin.config.schema.shape))
          expect(plugin.config.ownedFields).toContain(field);
    }
  } finally {
    await controller.dispose();
  }
});

it('动态 map 重命名和插件入口改名/重排仍保留属于原条目的未知元数据', async () => {
  const file = join(cwd, 'agent.config.json');
  await save(file, {
    provider: 'fake',
    pluginEntries: [{ entry: './old.mjs', enabled: false, future: { keep: 1 } }],
    pluginConfig: {
      [CONNECTIONS_PLUGIN]: { connections: { old: { type: 'fake', future: { keep: 2 } } } },
    },
  });
  const sections = configurationSections(cwd, [
    providerConnectionsPlugin(cwd, loadConfigWithSources(cwd).config),
  ]);
  const files = sections.find((s) => s.id === 'configuration-files')!.section;
  const raw = (await files.read!(signal())) as any;
  expect(JSON.stringify(raw)).not.toContain('future');
  raw.pluginEntries[0].entry = './renamed.mjs';
  raw.pluginEntries.unshift({ entry: './new.mjs', enabled: false });
  await files.commit!(await files.draft!(raw, signal()), signal());
  expect((await json(file)).pluginEntries).toEqual([
    { entry: './new.mjs', enabled: false },
    { entry: './renamed.mjs', enabled: false, future: { keep: 1 } },
  ]);
  const profiles = sections.find((s) => s.id === 'configuration-' + CONNECTIONS_PLUGIN)!.section;
  const value = (await profiles.read!(signal())) as any;
  value.connections.renamed = value.connections.old;
  delete value.connections.old;
  await profiles.commit!(await profiles.draft!(value, signal()), signal());
  expect((await json(file)).pluginConfig[CONNECTIONS_PLUGIN].connections).toEqual({
    renamed: { type: 'fake', future: { keep: 2 } },
  });
});

it('图形路径提交后领域编辑立即跟随新引用，旧草稿不能回写旧文件或撤回新引用', async () => {
  const config = join(cwd,'agent.config.json');
  const models = modelSettingsSection(cwd), mcp = mcpSettingsSection(cwd);
  await models.read!(signal());
  await mcp.read!(signal());
  const oldModels = await models.draft!({catalog:{old:{contextWindow:4096}}},signal());
  const oldMcp = await mcp.draft!({mcpServers:{old:{command:'node'}}},signal());
  await save(config,{provider:'fake',modelsFile:'new-models.json',mcpConfig:'new-mcp.json'});
  expect(()=>models.commit!(oldModels,signal())).toThrow();
  expect(()=>mcp.commit!(oldMcp,signal())).toThrow();
  await expect(readFile(join(cwd,'models.json'))).rejects.toThrow();
  await expect(readFile(join(cwd,'mcp.json'))).rejects.toThrow();
  const modelTarget = models.scopeTargets?.find(t=>t.scope==='project'), mcpTarget = mcp.scopeTargets?.find(t=>t.scope==='project');
  expect(modelTarget && 'path' in modelTarget ? modelTarget.path : undefined).toBe(join(cwd,'new-models.json'));
  expect(mcpTarget && 'path' in mcpTarget ? mcpTarget.path : undefined).toBe(join(cwd,'new-mcp.json'));
  await models.read!(signal()); await mcp.read!(signal());
  await models.commit!(await models.draft!({catalog:{fresh:{contextWindow:8192}}},signal()),signal());
  await mcp.commit!(await mcp.draft!({mcpServers:{fresh:{command:'node'}}},signal()),signal());
  expect((await json(join(cwd,'new-models.json'))).fresh.contextWindow).toBe(8192);
  expect((await json(join(cwd,'new-mcp.json'))).mcpServers.fresh.command).toBe('node');
  expect((await json(config)).modelsFile).toBe('new-models.json');
});
