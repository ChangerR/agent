/** 快速配置只在隔离 HOME 保存固定假密钥，真实 Provider 不发请求。 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ModelSetupSettings } from '../desktop/main/model-setup.js';
import { CredentialVault, type SecureStorage } from '../desktop/main/credentials.js';
import { MODEL_SERVICES, type ModelService } from '../desktop/shared/model-setup.js';
import { loadConfigWithSources } from '../src/core/config.js';
import { createAgent } from '../src/index.js';
let root: string, config: string, vault: CredentialVault, settings: ModelSetupSettings;
const key = 'fictional-model-setup-key';
const read = () => JSON.parse(readFileSync(config, 'utf8'));
const store = (value: unknown) => writeFileSync(config, JSON.stringify(value));
function secure(available = true, backend = 'gnome_libsecret'): SecureStorage {
  const secret = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString(value) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', secret, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();
    },
  };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentlab-model-setup-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.agentlab'), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('禁止真实网络');
    }),
  );
  config = join(home, '.agentlab/config.json');
  vault = new CredentialVault(secure());
  settings = new ModelSetupSettings(vault);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function save(service: ModelService, patch: Record<string, unknown> = {}) {
  const view = settings.read(service);
  settings.save({
    token: view.token,
    endpoint: view.endpoint,
    protocol: view.protocol,
    model: view.model,
    key,
    ...patch,
  });
}
it('打开与切换预设不创建文件，首次默认 DeepSeek；状态不含凭据', () => {
  expect(settings.read().service).toBe('deepseek');
  settings.read('kimi');
  settings.read('custom');
  expect(existsSync(config)).toBe(false);
  expect(existsSync(vault.path)).toBe(false);
});
it.each(['deepseek', 'kimi'] as const)(
  '%s 只填 key 就同时创建连接、默认模型和安全引用，并可装配真实 runtime',
  async (service) => {
    save(service);
    const raw = read(),
      item = raw.pluginConfig['agentlab.provider-connections'].connections[raw.provider];
    expect(raw.model).toBe(MODEL_SERVICES[service].models[0]);
    expect(item.baseURL).toBe(MODEL_SERVICES[service].endpoint);
    expect(item.type).toBe('openai');
    expect(item.apiKeyRef).toMatch(/^cred_/);
    expect(readFileSync(config, 'utf8') + readFileSync(vault.path, 'utf8')).not.toContain(key);
    expect(settings.read().configured).toBe(true);
    expect(JSON.stringify(settings.read())).not.toContain(key);
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    const keys = vault.resolve(loadConfigWithSources(cwd).config);
    expect(Object.values(keys).map((v) => v.key)).toEqual([key]);
    const agent = await createAgent(cwd, { resolveCredential: (ref) => keys[ref].key });
    try {
      expect(agent.loop.model).toBe(raw.model);
    } finally {
      await agent.dispose();
    }
  },
);
it('DeepSeek 与 Kimi 可以来回切换，不必重复输入已保存 key，模型跟随厂商', () => {
  save('deepseek');
  save('kimi');
  save('deepseek', { key: '' });
  expect(read().model).toBe('deepseek-flash');
  expect(settings.read('kimi').configured).toBe(true);
  expect(
    Object.keys(read().pluginConfig['agentlab.provider-connections'].connections),
  ).toHaveLength(2);
});
it('自定义连接一页保存协议、端点、模型，并保留未知字段及其他连接', () => {
  store({
    future: 1,
    baseURL: 'https://old.invalid',
    apiKeyEnv: 'OLD_KEY',
    pluginConfig: {
      'agentlab.provider-connections': {
        future: 2,
        connections: { untouched: { type: 'fake', future: 3 } },
      },
    },
  });
  save('custom', {
    endpoint: 'https://custom.test/anthropic',
    protocol: 'anthropic',
    model: 'custom-model',
  });
  const raw = read();
  expect(raw.future).toBe(1);
  expect(raw.baseURL).toBeUndefined();
  expect(raw.apiKeyEnv).toBeUndefined();
  expect(raw.pluginConfig['agentlab.provider-connections']).toMatchObject({
    future: 2,
    connections: { untouched: { future: 3 } },
  });
  const view = settings.read();
  expect(view).toMatchObject({
    service: 'custom',
    protocol: 'anthropic',
    endpoint: 'https://custom.test/anthropic',
    configured: true,
  });
  save('custom', { key: '', model: 'other-model' });
  expect(read().model).toBe('other-model');
});
it('更换端点或协议后必须重新输入 key，旧密钥不绑定到新服务', () => {
  save('custom', { endpoint: 'https://one.test/v1', protocol: 'openai', model: 'custom' });
  const before = readFileSync(config, 'utf8');
  expect(() => save('custom', { endpoint: 'https://two.test/v1', key: '' })).toThrow(/重新输入/);
  expect(readFileSync(config, 'utf8')).toBe(before);
  save('custom', { endpoint: 'https://two.test/v1', key: 'fictional-other-key' });
  expect(settings.read().endpoint).toBe('https://two.test/v1');
});
it('Kimi 国际站可选，国内外 key 不混用', () => {
  save('kimi', { endpoint: 'https://api.moonshot.ai/v1' });
  expect(settings.read().service).toBe('kimi');
  expect(() => save('kimi', { endpoint: MODEL_SERVICES.kimi.endpoint, key: '' })).toThrow(
    /重新输入/,
  );
});
it('创建同名连接时不覆盖原记录，重新启用必要插件，保留其他禁用项', () => {
  store({
    disabledPlugins: ['agentlab.provider-connections', 'other.plugin'],
    pluginConfig: {
      'agentlab.provider-connections': {
        connections: { 'quick-deepseek': { type: 'fake', future: 7 } },
      },
    },
  });
  save('deepseek');
  const raw = read();
  expect(raw.provider).toBe('quick-deepseek-2');
  expect(raw.disabledPlugins).toEqual(['other.plugin']);
  expect(raw.pluginConfig['agentlab.provider-connections'].connections['quick-deepseek']).toEqual({
    type: 'fake',
    future: 7,
  });
});
it('自定义 OpenAI 推理模型自动选可用思考等级，旧官方模型在保存前带出可用默认', () => {
  save('custom', { endpoint: 'https://api.openai.com/v1', protocol: 'openai', model: 'o3' });
  expect(read().thinking).toBe('high');
  save('deepseek');
  store({ ...read(), model: 'retired-model' });
  expect(settings.read().model).toBe('deepseek-flash');
  expect(read().model).toBe('retired-model');
});
it('官方端点、协议、模型不能被伪造；不合法输入不能暴露 key', () => {
  for (const patch of [
    { endpoint: 'https://evil.test/v1' },
    { protocol: 'anthropic' },
    { model: 'unknown' },
  ])
    expect(() => save('deepseek', patch)).toThrow(/预设/);
  for (const endpoint of [
    'file:///tmp/a',
    'https://user:secret@test/v1',
    'https://test/v1?token=private',
    'https://test/v1/chat/completions',
  ])
    expect(() => save('custom', { endpoint })).toThrow(/基础地址/);
  expect(existsSync(config)).toBe(false);
  expect(existsSync(vault.path)).toBe(false);
});
it('拒绝不可用与 basic_text 存储，不写配置或明文', () => {
  for (const backend of [secure(false), secure(true, 'basic_text')]) {
    vault = new CredentialVault(backend, 'linux');
    settings = new ModelSetupSettings(vault);
    expect(settings.read().available).toBe(false);
    expect(() => save('deepseek')).toThrow(/未保存/);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(vault.path)).toBe(false);
  }
});
it('配置并发变化拒绝保存；旧令牌不能重复消费', () => {
  const view = settings.read();
  store({ future: 'external' });
  const input = {
    token: view.token,
    endpoint: view.endpoint,
    protocol: view.protocol,
    model: view.model,
    key,
  };
  expect(() => settings.save(input)).toThrow(/变化/);
  expect(read()).toEqual({ future: 'external' });
  expect(existsSync(vault.path)).toBe(false);
  expect(() => settings.save(input)).toThrow(/重新读取/);
});
it('密文写入后若配置 CAS 冲突，只回滚本次密文，保留外部配置', () => {
  const write = vault.write.bind(vault);
  vi.spyOn(vault, 'write').mockImplementationOnce((base, next) => {
    const result = write(base, next);
    store({ external: true });
    return result;
  });
  expect(() => save('deepseek')).toThrow(/变化/);
  expect(read()).toEqual({ external: true });
  expect(vault.read().value).toEqual({});
});
