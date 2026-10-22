import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentConfigSchema, loadConfig } from '../src/core/config.js';
import { configurationSections, MASKED_SETTING } from '../src/builtin/configuration-settings.js';
import { settingsErrorMessage } from '../src/runtime/config-store.js';
import { mcpSettingsSection } from '../src/builtin/mcp-settings.js';

const dirs: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), 'agent-configuration-'));
  dirs.push(path);
  return path;
};
let home: string, cwd: string;
const signal = () => new AbortController().signal;
const read = (path = join(cwd, 'agent.config.json')) => JSON.parse(readFileSync(path, 'utf8'));
const write = (value: unknown, path = join(cwd, 'agent.config.json')) =>
  writeFileSync(path, JSON.stringify(value));
const section = (id: string) =>
  configurationSections(cwd).find((item) => item.id === `configuration-${id}`)!.section;
beforeEach(() => {
  home = directory();
  cwd = directory();
  mkdirSync(join(cwd, '.git'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('schema 驱动的分层配置入口', () => {
  it('MCP 只写固定作用域文件，掩码保护 args/env/headers，保留未知字段与 CAS', async () => {
    const path = join(cwd, 'mcp.json');
    write(
      {
        future: true,
        mcpServers: {
          local: {
            command: 'node',
            args: ['private-arg'],
            env: { KEY: 'private-env' },
            unknown: 9,
          },
          remote: { url: 'https://example.test/mcp', headers: { Authorization: 'private-header' } },
        },
      },
      path,
    );
    const editor = mcpSettingsSection(cwd, path);
    const value = (await editor.read!(signal())) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(JSON.stringify(value)).not.toContain('private-');
    expect(value.mcpServers.local.args).toBe(MASKED_SETTING);
    value.mcpServers.local.command = 'node-new';
    await editor.commit!(await editor.draft!(value, signal()), signal());
    expect(read(path).mcpServers.local).toEqual({
      command: 'node-new',
      args: ['private-arg'],
      env: { KEY: 'private-env' },
      unknown: 9,
    });
    expect(read(path).future).toBe(true);
    await expect(async () =>
      editor.draft!(
        { mcpServers: { local: { command: 'node', env: { KEY: 'never-save' } } } },
        signal(),
      ),
    ).rejects.toThrow();
    await editor.read!(signal());
    const stale = await editor.draft!({}, signal());
    write({ external: true }, path);
    expect(() => editor.commit!(stale, signal())).toThrow(/配置已变化/);
    expect(read(path)).toEqual({ external: true });
  });
  it('全部顶层字段有入口或专用编辑器，打开和取消不补默认值、不创建文件', async () => {
    const sections = configurationSections(cwd);
    const keys = sections.flatMap(({ section }) =>
      Object.keys(section.schema.properties as object),
    );
    expect([...keys, 'capabilities', 'pluginConfig'].sort()).toEqual(
      Object.keys(AgentConfigSchema.shape).sort(),
    );
    for (const { section } of sections) {
      expect(await section.read!(signal(), 'project')).toEqual({});
      expect(await section.read!(signal(), 'global')).toEqual({});
      await section.draft!({}, signal(), 'project');
    }
    expect(existsSync(join(cwd, 'agent.config.json'))).toBe(false);
    expect(existsSync(join(home, '.agent'))).toBe(false);
  });

  it('用户层与项目层分开，重置只删除本层已知字段，未知嵌套字段及其他配置保留', async () => {
    mkdirSync(join(home, '.agent'));
    const globalPath = join(home, '.agent', 'config.json');
    write({ maxTurns: 20, cache: { ttl: '1h' } }, globalPath);
    write({
      provider: 'fake',
      maxTurns: 6,
      cache: { enabled: false, future: { retained: true } },
      unknownRoot: 'keep',
    });
    const editor = section('budgets');
    expect(await editor.read!(signal(), 'project')).toEqual({
      maxTurns: 6,
      cache: { enabled: false },
    });
    expect(await editor.read!(signal(), 'global')).toEqual({ maxTurns: 20, cache: { ttl: '1h' } });
    const draft = await editor.draft!({}, signal(), 'project');
    expect(() => editor.commit!(draft, signal(), 'global')).toThrow(/作用域/);
    await editor.commit!(draft, signal(), 'project');
    expect(read()).toEqual({
      provider: 'fake',
      cache: { future: { retained: true } },
      unknownRoot: 'keep',
    });
    expect(read(globalPath)).toEqual({ maxTurns: 20, cache: { ttl: '1h' } });
    expect(loadConfig(cwd).maxTurns).toBe(20);
  });

  it('严格验证 endpoint、key 引用、数值、权限规则、未知字段，失败不写入', async () => {
    write({ provider: 'fake', unknownRoot: true });
    const before = readFileSync(join(cwd, 'agent.config.json'), 'utf8');
    for (const [id, invalid] of [
      ['connection', { apiKeyEnv: 'sk-real-key-is-not-a-variable' }],
      ['connection', { baseURL: 'https://user:private@example.test/v1' }],
      ['connection', { baseURL: 'https://example.test/v1?token=private' }],
      ['connection', { model: 'invalid model' }],
      ['budgets', { maxTurns: 0 }],
      ['budgets', { cache: { ttl: 'unknown' } }],
      ['budgets', { cache: { nonexistentBudget: 20 } }],
      ['permissions', { permissions: { allow: [''] } }],
      ['files', { arbitraryPath: '/tmp/forbidden' }],
    ] as const) {
      const editor = section(id);
      await editor.read!(signal());
      await expect(async () => editor.draft!(invalid, signal())).rejects.toThrow();
    }
    expect(readFileSync(join(cwd, 'agent.config.json'), 'utf8')).toBe(before);
  });

  it('凭据和未知字段不进入展示值；掩码保持原值而不把掩码写到磁盘', async () => {
    write({
      baseURL: 'https://user:private@example.test',
      apiKey: 'private-key',
      unknown: 'private-unknown',
    });
    const editor = section('connection');
    const value = await editor.read!(signal());
    expect(value).toEqual({ baseURL: MASKED_SETTING });
    expect(JSON.stringify(value)).not.toContain('private');
    const draft = await editor.draft!({ ...(value as object), model: 'test-model' }, signal());
    await editor.commit!(draft, signal());
    expect(read()).toEqual({
      baseURL: 'https://user:private@example.test',
      apiKey: 'private-key',
      unknown: 'private-unknown',
      model: 'test-model',
    });
  });

  it('CAS、符号链接、取消和一次性草稿保护现有文件；错误不包含配置正文', async () => {
    write({ maxTurns: 5 });
    const editor = section('budgets');
    await editor.read!(signal());
    const input = { maxTurns: 8 };
    const draft = await editor.draft!(input, signal());
    input.maxTurns = 99;
    const aborted = new AbortController();
    aborted.abort();
    expect(() => editor.commit!(draft, aborted.signal)).toThrow();
    expect(read().maxTurns).toBe(5);
    await editor.commit!(draft, signal());
    expect(read().maxTurns).toBe(8);
    expect(() => editor.commit!(draft, signal())).toThrow();
    await editor.read!(signal());
    const stale = await editor.draft!({ maxTurns: 10 }, signal());
    write({ maxTurns: 12 });
    expect(() => editor.commit!(stale, signal())).toThrow(/配置已变化/);
    expect(read().maxTurns).toBe(12);
    rmSync(join(cwd, 'agent.config.json'));
    const outside = join(directory(), 'outside.json');
    write({ maxTurns: 22 }, outside);
    symlinkSync(outside, join(cwd, 'agent.config.json'));
    expect(() => editor.read!(signal())).toThrow();
    expect(read(outside)).toEqual({ maxTurns: 22 });
    expect(settingsErrorMessage(new Error('private-key'))).not.toContain('private-key');
  });

  it('插件编辑器从真实 schema 发现字段、保留继承、拒绝跨字段错误和敏感明文', async () => {
    const plugin = {
      manifest: { id: 'test.plugin', apiVersion: 1 as const, version: '1.0.0' },
      config: {
        schema: z.object({
          count: z.number().int().positive().default(3),
          credential: z.string().optional(),
        }),
        ownedFields: ['count', 'credential'],
        sensitiveFields: ['credential'],
        scopes: ['project' as const],
      },
      setup() {},
    };
    write({
      pluginConfig: {
        'test.plugin': { count: 5, credential: 'env:TEST_KEY', unknown: true },
        another: { keep: true },
      },
    });
    const editor = configurationSections(cwd, [plugin]).at(-1)!.section;
    expect(editor.scopeTargets?.map((item) => item.scope)).toEqual(['project']);
    expect(() => editor.read!(signal(), 'global')).toThrow();
    expect(await editor.read!(signal())).toEqual({ count: 5, credential: MASKED_SETTING });
    await expect(async () => editor.draft!({ count: -1 }, signal())).rejects.toThrow();
    await expect(async () =>
      editor.draft!({ credential: 'private-key' }, signal()),
    ).rejects.toThrow();
    const draft = await editor.draft!({ credential: MASKED_SETTING }, signal());
    await editor.commit!(draft, signal());
    expect(read().pluginConfig).toEqual({
      'test.plugin': { credential: 'env:TEST_KEY', unknown: true },
      another: { keep: true },
    });
  });
});
