/** 必须同时具备 App 与缓存 runtime；所有请求使用 FakeProvider，不读取真实凭据。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopController } from '../desktop/worker/controller.js';
import { createAgent, type Agent } from '../src/index.js';
import { defaultPreset } from '../src/builtin/default-preset.js';
import { definePlugin } from '../src/sdk/index.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { loadConfigWithSources } from '../src/core/config.js';

let root: string,
  cwd: string,
  home: string,
  controller: DesktopController,
  agent: Agent,
  fake: FakeProvider;
const latest = () => controller.snapshot!;
const send = (payload: Record<string, unknown>) =>
  controller.handle({ ...payload, generation: latest().generation, sessionId: latest().sessionId });
const read = async (id: string, scope = 'project') => {
  await send({ type: 'settings-read', sectionId: id, scope });
  return latest().settingsEditor!;
};
const save = async (id: string, value: unknown) => {
  await read(id);
  await send({
    type: 'settings-commit',
    editorId: latest().settingsEditor!.id,
    json: JSON.stringify(value),
  });
  expect(latest().settingsEditor!.error).toBeUndefined();
  expect(latest().settingsEditor!.saved).toBe(true);
};
const raw = async () => JSON.parse(await readFile(join(cwd, 'agent.config.json'), 'utf8'));
const start = async () => {
  controller = new DesktopController(
    () => {},
    async (path, options) => {
      fake = new FakeProvider([
        (request) =>
          textResponse(request.model === 'planner-configured' ? 'null' : 'offline summary / reply'),
      ]);
      agent = await createAgent(path, {
        ...options,
        autoSaveSessions: false,
        preset: (input) => {
          const preset = defaultPreset(input);
          return {
            ...preset,
            plugins: [
              ...preset.plugins.filter((plugin) => plugin.manifest.id !== 'agentlab.provider-fake'),
              definePlugin({
                manifest: { id: 'agentlab.provider-fake', apiVersion: 1, version: '1.0.0' },
                setup(ctx) {
                  ctx.provide.provider('fake', fake);
                },
              }),
            ],
          };
        },
      });
      return agent;
    },
  );
  await controller.initialize(cwd, false, randomUUID());
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-cache-integration-'));
  cwd = join(root, 'project');
  home = join(root, 'home');
  await mkdir(cwd);
  await mkdir(join(cwd, '.git'));
  await mkdir(home);
  await mkdir(join(home, '.agent'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  await writeFile(
    join(home, '.agent/config.json'),
    JSON.stringify({ cache: { enabled: false, ttl: '5m' } }),
  );
  await writeFile(
    join(cwd, 'agent.config.json'),
    JSON.stringify({ provider: 'fake', model: 'main-fixture', future: true }),
  );
  await start();
});
afterEach(async () => {
  await controller.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const expected: Record<string, string[]> = {
  'configuration-additional': ['replayToolArguments'],
  'configuration-agentlab.planning': [
    'mode',
    'provider',
    'model',
    'thinking',
    'maxOutputTokens',
    'maxRequestBytes',
  ],
  'configuration-agentlab.compaction-summary': [
    'provider',
    'model',
    'thinking',
    'strategy',
    'maxOutputTokens',
    'maxRequestBytes',
  ],
  'configuration-agentlab.reviewer-model': [
    'provider',
    'model',
    'thinking',
    'timeoutMs',
    'maxRequestBytes',
    'maxResponseBytes',
    'maxOutputTokens',
    'prefixCache',
  ],
  'configuration-agentlab.provider-openai': ['dialect', 'models'],
  'configuration-agentlab.provider-anthropic': ['models'],
  'configuration-agentlab.mcp': [
    'maxInlineChars',
    'maxAgeDays',
    'maxStoredBytes',
    'deduplicate',
    'maxSearchChars',
  ],
};
describe('App + 缓存最终 runtime 的实际设置接入', () => {
  it('所有新增字段在 worker 目录中注册且可读，打开不回填默认，均提示重启', async () => {
    const before = await readFile(join(cwd, 'agent.config.json'), 'utf8');
    for (const [id, fields] of Object.entries(expected)) {
      const metadata = latest().settings.find((item) => item.id === id)!;
      expect(metadata, id).toBeDefined();
      expect(metadata.editable).toBe(true);
      expect(metadata.applyMode).toBe('newSession');
      expect(Object.keys(metadata.schema.properties as object).sort()).toEqual([...fields].sort());
      expect((await read(id)).value).toEqual({});
    }
    const cache = (
      latest().settings.find((item) => item.id === 'configuration-budgets')!.schema
        .properties as Record<string, any>
    ).cache;
    expect(Object.keys(cache.properties)).toEqual(
      expect.arrayContaining(['staticTtl', 'ttlStrategy']),
    );
    expect(await readFile(join(cwd, 'agent.config.json'), 'utf8')).toBe(before);
  });
  it('App 只写 staticTtl，仍继承全局 enabled=false/ttl，保留未来字段且不填充保守默认', async () => {
    await writeFile(
      join(cwd, 'agent.config.json'),
      JSON.stringify({
        provider: 'fake',
        model: 'main-fixture',
        cache: { future: { keep: true } },
        future: true,
      }),
    );
    await save('configuration-budgets', { cache: { staticTtl: '1h' } });
    expect((await raw()).cache).toEqual({ future: { keep: true }, staticTtl: '1h' });
    const loaded = loadConfigWithSources(cwd);
    expect(loaded.config.cache).toMatchObject({
      enabled: false,
      ttl: '5m',
      staticTtl: '1h',
      ttlStrategy: 'fixed',
    });
    expect(loaded.config.replayToolArguments).toBe(false);
    expect((await raw()).replayToolArguments).toBeUndefined();
    await save('configuration-agentlab.compaction-summary', { model: 'summary-configured' });
    await save('configuration-agentlab.mcp', { maxAgeDays: 14 });
    expect((await raw()).pluginConfig['agentlab.compaction-summary']).toEqual({
      model: 'summary-configured',
    });
    expect((await raw()).pluginConfig['agentlab.mcp']).toEqual({ maxAgeDays: 14 });
    expect(agent.config.cache.enabled).toBe(false); // 提交没有热替换当前 runtime。
  });
  it('模型能力映射使用真实 schema 校验，保留模型内未知字段，重启后 adapter 采用', async () => {
    await writeFile(
      join(cwd, 'agent.config.json'),
      JSON.stringify({
        provider: 'fake',
        pluginConfig: {
          'agentlab.provider-openai': {
            models: { fixture: { api: 'chat-completions', future: { token: 'private-fixture' } } },
          },
        },
      }),
    );
    const value = (await read('configuration-agentlab.provider-openai')).value as any;
    expect(value).toEqual({ models: { fixture: { api: 'chat-completions' } } });
    await send({
      type: 'settings-commit',
      editorId: latest().settingsEditor!.id,
      json: JSON.stringify({ models: { fixture: { api: 'wrong' } } }),
    });
    expect(latest().settingsEditor!.error).toBeDefined();
    await save('configuration-agentlab.provider-openai', {
      models: {
        fixture: {
          api: 'chat-completions',
          rawToolArguments: true,
          prefixCompaction: false,
          outputParameter: 'max_tokens',
        },
      },
    });
    expect((await raw()).pluginConfig['agentlab.provider-openai'].models.fixture.future).toEqual({
      token: 'private-fixture',
    });
    await controller.dispose();
    await start();
    expect(agent.providers.get('openai').modelCapabilities?.('fixture')).toMatchObject({
      rawToolArguments: true,
      prefixCompaction: false,
      outputParameter: 'max_tokens',
    });
    expect(JSON.stringify(latest())).not.toContain('private-fixture');
  });
  it('App 保存 planner/summary/judge 后，重启时角色路由、thinking 与预算真正采用', async () => {
    await save('configuration-agentlab.planning', {
      provider: 'fake',
      model: 'planner-configured',
      thinking: 'off',
      maxOutputTokens: 333,
      maxRequestBytes: 1000000,
    });
    await save('configuration-agentlab.compaction-summary', {
      provider: 'fake',
      model: 'summary-configured',
      thinking: 'off',
      strategy: 'isolated',
      maxOutputTokens: 444,
      maxRequestBytes: 1000000,
    });
    await save('configuration-agentlab.reviewer-model', {
      provider: 'fake',
      model: 'judge-configured',
      thinking: 'off',
      maxOutputTokens: 555,
    });
    await save('configuration-budgets', { compactThreshold: 1 });
    expect(agent.loop.getJudgeStatus()?.model).not.toBe('judge-configured');
    await controller.dispose();
    await start();
    expect(agent.loop.getJudgeStatus()).toMatchObject({
      model: 'judge-configured',
      provider: 'fake',
      providerSource: 'explicit',
    });
    agent.loop.importSession({
      messages: Array.from({ length: 8 }, (_, i) => ({
        role: 'user' as const,
        content: 'old ' + i,
      })),
    });
    await send({ type: 'submit', invocationId: randomUUID(), text: 'continue' });
    await vi.waitFor(() => expect(latest().busy).toBe(false));
    expect(latest().error).toBeUndefined();
    expect(fake.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'summary-configured', maxTokens: 444, thinking: 'off' }),
        expect.objectContaining({ model: 'planner-configured', maxTokens: 333, thinking: 'off' }),
      ]),
    );
    const persisted = await raw();
    expect(persisted.pluginConfig['agentlab.reviewer-model']).toEqual({
      provider: 'fake',
      model: 'judge-configured',
      thinking: 'off',
      maxOutputTokens: 555,
    });
    expect(persisted.future).toBe(true);
  });
});
