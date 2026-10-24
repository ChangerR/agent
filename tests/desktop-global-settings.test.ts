import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { GlobalSettingsController } from '../desktop/worker/global-settings.js';
import {
  CredentialSettings,
  CredentialVault,
  type SecureStorage,
} from '../desktop/main/credentials.js';
import { loadConfigWithSources } from '../src/core/config.js';
import { resolveApiKey, storedApiKey } from '../src/providers/api-key.js';
import type { SettingsSnapshot } from '../desktop/shared/protocol.js';

let root: string, home: string, config: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlab-global-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.agentlab'), { recursive: true });
  config = join(home, '.agentlab/config.json');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const store = (value: unknown) => writeFileSync(config, JSON.stringify(value));
const read = () => JSON.parse(readFileSync(config, 'utf8'));
const fixtureKey = 'fictional-test-credential-never-a-real-account';
function secure(available = true, backend = 'gnome_libsecret'): SecureStorage {
  // 单元测试依赖使用隔离 AES；真实 safeStorage/Secret Service 另由 Electron 验收覆盖。
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();
    },
  };
}
const fixture = () => ({
  provider: 'cloud',
  model: 'global-model',
  future: { keep: true },
  pluginConfig: {
    'agentlab.provider-connections': {
      connections: {
        cloud: {
          type: 'openai',
          baseURL: 'http://127.0.0.1:12345/v1',
          enabled: true,
          future: { keep: true },
        },
      },
    },
  },
});

describe('独立全局设置与安全凭据', () => {
  it('CLI 原有环境变量方式保留，缺少解密宿主和端点身份错误不回退其他 key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'fictional-environment-key');
    expect(resolveApiKey({}, 'OPENAI_API_KEY')).toBe('fictional-environment-key');
    expect(() =>
      resolveApiKey(
        { apiKeyResolver: () => storedApiKey('cred_' + 'a'.repeat(32))! },
        'OPENAI_API_KEY',
        'http://127.0.0.1:1/v1',
      ),
    ).toThrow(/不会回退/);
    const resolver = vi.fn((endpoint: string) => {
      if (endpoint !== 'http://127.0.0.1:1/v1') throw new Error('endpoint mismatch');
      return 'fictional-stored-key';
    });
    expect(
      resolveApiKey({ apiKeyResolver: resolver }, 'OPENAI_API_KEY', 'http://127.0.0.1:1/v1'),
    ).toBe('fictional-stored-key');
    expect(() =>
      resolveApiKey({ apiKeyResolver: resolver }, 'OPENAI_API_KEY', 'http://127.0.0.1:2/v1'),
    ).toThrow('endpoint mismatch');
  });
  it('没有项目或会话也能配置；读取不写默认，保存不产生项目状态', async () => {
    let snapshot!: SettingsSnapshot;
    const controller = new GlobalSettingsController((s) => {
      snapshot = s;
    });
    const generation = '11111111-1111-4111-8111-111111111111';
    await controller.initialize(generation);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(home, '.agentlab/state'))).toBe(false);
    expect(snapshot.settings.some((s) => s.id === 'configuration-model-catalog')).toBe(true);
    expect(snapshot.settings.every((s) => s.scopes.every((t) => t.scope === 'global'))).toBe(true);
    await controller.handle({ type: 'read', generation, sectionId: 'configuration-connection' });
    expect(existsSync(config)).toBe(false);
    await controller.handle({
      type: 'commit',
      generation,
      editorId: snapshot.settingsEditor!.id,
      json: JSON.stringify({ provider: 'fake', model: 'shared' }),
    });
    expect(snapshot.settingsEditor!.saved).toBe(true);
    expect(read()).toEqual({ provider: 'fake', model: 'shared' });
    for (const project of ['one', 'two']) {
      const cwd = join(root, project);
      mkdirSync(cwd);
      expect(loadConfigWithSources(cwd).config.model).toBe('shared');
      expect(existsSync(join(cwd, 'agent.config.json'))).toBe(false);
    }
    const other = join(root, 'broken');
    mkdirSync(other);
    writeFileSync(join(other, 'agent.config.json'), 'bad JSON');
    expect(loadConfigWithSources(other, {}, { globalOnly: true }).config.model).toBe('shared');
    expect(existsSync(join(home, '.agentlab/state'))).toBe(false);
    await controller.handle({ type: 'read', generation, sectionId: 'configuration-connection' });
    const saving = controller.handle({
      type: 'commit',
      generation,
      editorId: snapshot.settingsEditor!.id,
      json: JSON.stringify({ provider: 'fake', model: 'closing-shared' }),
    });
    await Promise.all([saving, controller.dispose()]);
    expect(read().model).toBe('closing-shared');
    await expect(
      controller.handle({ type: 'read', generation, sectionId: 'configuration-connection' }),
    ).rejects.toThrow(/关闭/);
  });
  it('全局错误保存保留未知字段并报告 CAS，不吞掉外部更改', async () => {
    store({ model: 'before', future: { keep: true } });
    let snapshot!: SettingsSnapshot;
    const controller = new GlobalSettingsController((s) => {
      snapshot = s;
    });
    const generation = '11111111-1111-4111-8111-111111111111';
    await controller.initialize(generation);
    await controller.handle({ type: 'read', generation, sectionId: 'configuration-connection' });
    store({ model: 'external', future: { keep: true } });
    await controller.handle({
      type: 'commit',
      generation,
      editorId: snapshot.settingsEditor!.id,
      json: JSON.stringify({ model: 'after' }),
    });
    expect(snapshot.settingsEditor!.error).toBeTruthy();
    expect(read()).toEqual({ model: 'external', future: { keep: true } });
  });
  it('直接保存加密 key，状态不含明文，两个项目和重启宿主读取相同凭据', async () => {
    store(fixture());
    const backend = secure(),
      vault = new CredentialVault(backend),
      settings = new CredentialSettings(vault);
    const state = settings.read('cloud');
    await settings.save(state.token, fixtureKey);
    expect(readFileSync(config, 'utf8')).not.toContain(fixtureKey);
    expect(readFileSync(vault.path, 'utf8')).not.toContain(fixtureKey);
    const status = new CredentialSettings(new CredentialVault(backend)).read('cloud');
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(fixtureKey);
    for (const project of ['one', 'two']) {
      const cwd = join(root, project);
      mkdirSync(cwd);
      const loaded = loadConfigWithSources(cwd).config;
      expect(Object.values(new CredentialVault(backend).resolve(loaded)).map((v) => v.key)).toEqual(
        [fixtureKey],
      );
    }
    expect(read().future).toEqual({ keep: true });
    expect(read().pluginConfig['agentlab.provider-connections'].connections.cloud.future).toEqual({
      keep: true,
    });
    await settings.save(settings.read('cloud').token, null);
    expect(settings.read('cloud').configured).toBe(false);
    expect(Object.keys(vault.read().value)).toEqual([]);
  });
  it('安全存储不可用或 basic_text 时拒绝保存，绝不明文降级', async () => {
    for (const backend of [secure(false), secure(true, 'basic_text')]) {
      store(fixture());
      const vault = new CredentialVault(backend),
        settings = new CredentialSettings(vault);
      const before = readFileSync(config, 'utf8');
      const state = settings.read('cloud');
      expect(state.available).toBe(false);
      await expect(settings.save(state.token, fixtureKey)).rejects.toThrow(/未保存/);
      expect(readFileSync(config, 'utf8')).toBe(before);
      expect(existsSync(vault.path)).toBe(false);
    }
  });
  it('配置 CAS 失败回滚密文，表单令牌一次使用', async () => {
    store(fixture());
    const vault = new CredentialVault(secure()),
      settings = new CredentialSettings(vault),
      state = settings.read('cloud');
    store({ ...fixture(), model: 'external' });
    await expect(settings.save(state.token, fixtureKey)).rejects.toThrow();
    expect(Object.keys(vault.read().value)).toEqual([]);
    expect(read().model).toBe('external');
    await expect(settings.save(state.token, fixtureKey)).rejects.toThrow(/过期/);
  });
  it('项目改端点不能发送全局保存的 key；重新输入为新端点绑定，保留旧引用', async () => {
    store(fixture());
    const backend = secure(),
      vault = new CredentialVault(backend),
      settings = new CredentialSettings(vault);
    await settings.save(settings.read('cloud').token, fixtureKey);
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    writeFileSync(
      join(cwd, 'agent.config.json'),
      JSON.stringify({
        pluginConfig: {
          'agentlab.provider-connections': {
            connections: {
              ...read().pluginConfig['agentlab.provider-connections'].connections,
              cloud: {
                ...read().pluginConfig['agentlab.provider-connections'].connections.cloud,
                baseURL: 'http://127.0.0.1:45678/v1',
              },
            },
          },
        },
      }),
    );
    expect(() => vault.resolve(loadConfigWithSources(cwd).config)).toThrow(/端点/);
    const next = read();
    next.pluginConfig['agentlab.provider-connections'].connections.cloud.baseURL =
      'http://127.0.0.1:45678/v1';
    store(next);
    expect(settings.read('cloud').configured).toBe(false);
    await settings.save(settings.read('cloud').token, 'another-fictional-key');
    expect(() => vault.resolve(loadConfigWithSources(cwd).config)).toThrow(/端点/);
    writeFileSync(join(cwd, 'agent.config.json'), '{}');
    expect(
      Object.values(vault.resolve(loadConfigWithSources(cwd).config)).map((v) => v.key),
    ).toEqual(['another-fictional-key']);
    expect(Object.keys(vault.read().value)).toHaveLength(2);
  });
  it('内置 provider key 不要求先选择项目或设置主 provider', async () => {
    const backend = secure(),
      vault = new CredentialVault(backend),
      settings = new CredentialSettings(vault);
    await settings.save(settings.read('openai').token, fixtureKey);
    expect(read().provider).toBeUndefined();
    expect(read().pluginConfig['agentlab.provider-openai'].apiKeyRef).toMatch(/^cred_/);
    expect(settings.read('openai').configured).toBe(true);
  });
});
