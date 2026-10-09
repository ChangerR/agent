/** 配置与 .env 的真实装配回归；SDK 完全替换，所有凭据均为测试假值。 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempProject } from './helpers/project.js';

const sdk = vi.hoisted(() => ({
  options: [] as Array<{ apiKey?: string; baseURL?: string }>,
  anthropicOptions: [] as Array<{ apiKey?: string; baseURL?: string; authToken?: string | null }>,
}));
vi.mock('openai', () => ({ default: class {
  constructor(options: { apiKey?: string; baseURL?: string }) { sdk.options.push(options); }
  chat = { completions: { create: async function* () {
    yield { choices: [{ delta: { content: 'offline fixture' }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  } } };
} }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class {
  constructor(options: { apiKey?: string; baseURL?: string; authToken?: string | null }) { sdk.anthropicOptions.push(options); }
  messages = { stream: async function* () {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'offline fixture' } };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
  } };
} }));
import { complete, createAgent, loadConfigWithSources, type Agent } from '../src/index.js';
import { loadProjectEnv } from '../src/runtime/environment.js';

let cwd: string;
const agents: Agent[] = [];
beforeEach(async () => {
  cwd = await mkdtempProject(join(tmpdir(), 'agentlab-env-'));
  sdk.options.length = 0; sdk.anthropicOptions.length = 0;
  // 显式登记所有 .env 测试变量，保证原生 loadEnvFile 的进程改动在测试后恢复。
  for (const name of ['AGENTLAB_ENV_FIXTURE', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'PROVIDER', 'MODEL']) vi.stubEnv(name, undefined);
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
async function agent(from = cwd, config: Record<string, unknown> = { provider: 'fake', model: 'fixture-model' }) {
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify(config));
  const value = await createAgent(from, { autoSaveSessions: false }); agents.push(value); return value;
}

it('缺少 .env 正常启动，配置只读加载不加载环境文件', async () => {
  await agent();
  await writeFile(join(cwd, '.env'), 'AGENTLAB_ENV_FIXTURE=fake-file-value\n');
  loadConfigWithSources(cwd);
  expect(process.env.AGENTLAB_ENV_FIXTURE).toBeUndefined();
  loadProjectEnv(cwd);
  expect(process.env.AGENTLAB_ENV_FIXTURE).toBe('fake-file-value');
});

it('从子目录启动只加载规范化项目根 .env，忽略子目录与 .env.local', async () => {
  const nested = join(cwd, 'src'); await mkdir(nested);
  await writeFile(join(cwd, '.env'), 'AGENTLAB_ENV_FIXTURE=root-fake-value\n');
  await writeFile(join(cwd, '.env.local'), 'AGENTLAB_ENV_FIXTURE=local-fake-value\n');
  await writeFile(join(nested, '.env'), 'AGENTLAB_ENV_FIXTURE=nested-fake-value\n');
  const value = await agent(nested);
  expect(value.cwd).toBe(cwd);
  expect(process.env.AGENTLAB_ENV_FIXTURE).toBe('root-fake-value');
});

it.each(['fake-shell-value', ''])('已有进程变量 %j 优先于 .env，包含显式空值', async (value) => {
  vi.stubEnv('AGENTLAB_ENV_FIXTURE', value);
  await writeFile(join(cwd, '.env'), 'AGENTLAB_ENV_FIXTURE=fake-file-value\n');
  loadProjectEnv(cwd);
  expect(process.env.AGENTLAB_ENV_FIXTURE).toBe(value);
});

it('.env 不代替 JSON 的 provider/model；凭据、端点在 provider 装配之前加载', async () => {
  await writeFile(join(cwd, '.env'), [
    'DEEPSEEK_API_KEY=fake-key-never-sent',
    'OPENAI_BASE_URL=https://env-endpoint.invalid/v1',
    'PROVIDER=anthropic', 'MODEL=not-the-configured-model',
  ].join('\n'));
  const value = await agent(cwd, { provider: 'openai', model: 'fixture-model', apiKeyEnv: 'DEEPSEEK_API_KEY' });
  expect(value.config.provider).toBe('openai');
  expect(value.loop.model).toBe('fixture-model');
  await value.loop.run('offline test');
  expect(sdk.options).toEqual([{ apiKey: 'fake-key-never-sent', baseURL: 'https://env-endpoint.invalid/v1' }]);
});

it('默认 key 变量可从 .env 加载，显式 JSON baseURL 优先于 .env 端点', async () => {
  await writeFile(join(cwd, '.env'), 'OPENAI_API_KEY=fake-default-key\nOPENAI_BASE_URL=https://env.invalid/v1\n');
  const value = await agent(cwd, { provider: 'openai', model: 'fixture-model', baseURL: 'https://configured.invalid/v1' });
  await value.loop.run('offline test');
  expect(sdk.options).toEqual([{ apiKey: 'fake-default-key', baseURL: 'https://configured.invalid/v1' }]);
});

it('同一进程重复装配不会覆盖已加载变量；文件修改需要新进程', async () => {
  await writeFile(join(cwd, '.env'), 'AGENTLAB_ENV_FIXTURE=first-fake-value\n');
  await agent();
  await writeFile(join(cwd, '.env'), 'AGENTLAB_ENV_FIXTURE=changed-fake-value\n');
  await agent();
  expect(process.env.AGENTLAB_ENV_FIXTURE).toBe('first-fake-value');
});

it('只有 ENOENT 可静默跳过；读取错误阻止装配且不泄露错误原文', async () => {
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => { throw Object.assign(new Error('fake-secret-must-not-leak'), { code: 'EACCES' }); });
  const failure = await createAgent(cwd).catch(error => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(join(cwd, '.env'));
  expect((failure as Error).message).toContain('EACCES');
  expect((failure as Error).message).not.toContain('fake-secret-must-not-leak');
  expect(sdk.options).toEqual([]);
});

it('未知或异常错误码不回显原始错误内容', () => {
  vi.spyOn(process, 'loadEnvFile').mockImplementation(() => { throw { code: 'FAKE_SECRET_CODE', message: 'fake-secret-message' }; });
  expect(() => loadProjectEnv(cwd)).toThrow('无法加载项目环境文件');
  expect(() => loadProjectEnv(cwd)).not.toThrow('fake-secret');
  expect(() => loadProjectEnv(cwd)).not.toThrow('FAKE_SECRET_CODE');
});


const providers = ['openai', 'anthropic'] as const;
const request = { model: 'fixture-model', system: '', messages: [{ role: 'user' as const, content: 'offline test' }], tools: [] };

it.each(providers.flatMap(provider => [undefined, '', ' \t '].map(value => ({ provider, value }))))(
  '$provider 显式 key 变量为 $value 时请求前报错，不能回退默认凭据', async ({ provider, value: key }) => {
    vi.stubEnv('DEEPSEEK_API_KEY', key);
    vi.stubEnv('OPENAI_API_KEY', 'fake-default-openai-must-not-use');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-default-anthropic-must-not-use');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fake-default-bearer-must-not-use');
    const value = await agent(cwd, { provider, model: 'fixture-model', apiKeyEnv: 'DEEPSEEK_API_KEY' });
    // 仅启动、浏览权限配置不会构造 SDK；真正请求时才验证该 provider。
    expect(await value.dispatchCommand('/permissions')).toBeDefined();
    expect(sdk.options).toEqual([]); expect(sdk.anthropicOptions).toEqual([]);
    const result = await value.loop.run('offline test');
    expect(result.reason).toBe('error');
    expect(result.error).toContain('apiKeyEnv');
    expect(result.error).toContain('.env');
    expect(result.error).toContain('重新启动');
    expect(result.error).not.toContain('fake-default');
    expect(sdk.options).toEqual([]); expect(sdk.anthropicOptions).toEqual([]);
  },
);

it.each(providers.flatMap(provider => ['', ' \t ', 'fake-secret-mistaken-for-variable-name', 'toString', '__proto__'].map(apiKeyEnv => ({ provider, apiKeyEnv }))))(
  '$provider 显式变量名为 $apiKeyEnv 时安全拒绝且不回显配置原值', async ({ provider, apiKeyEnv }) => {
    const value = await agent(cwd, { provider, model: 'fixture-model', apiKeyEnv });
    const result = await value.loop.run('offline test');
    expect(result.reason).toBe('error');
    expect(result.error).toContain('apiKeyEnv');
    expect(result.error).not.toContain('fake-secret-mistaken-for-variable-name');
    expect(sdk.options).toEqual([]); expect(sdk.anthropicOptions).toEqual([]);
  },
);

it.each(providers)('%s 显式空 shell key 覆盖非空 .env 时仍拒绝', async provider => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  await writeFile(join(cwd, '.env'), 'DEEPSEEK_API_KEY=fake-file-key-must-not-use\n');
  const value = await agent(cwd, { provider, model: 'fixture-model', apiKeyEnv: 'DEEPSEEK_API_KEY' });
  const result = await value.loop.run('offline test');
  expect(result.reason).toBe('error'); expect(result.error).not.toContain('fake-file-key');
  expect(sdk.options).toEqual([]); expect(sdk.anthropicOptions).toEqual([]);
});

it.each(['DEEPSEEK_API_KEY', '', ' \t '])('fake 不因未使用的显式 apiKeyEnv=%j 阻塞', async apiKeyEnv => {
  const value = await agent(cwd, { provider: 'fake', model: 'fixture-model', apiKeyEnv });
  expect((await value.loop.run('offline test')).reason).toBe('completed');
  expect(sdk.options).toEqual([]); expect(sdk.anthropicOptions).toEqual([]);
});

it.each(providers)('%s 未指定 apiKeyEnv 且无 key 时仍能启动与打开菜单', async provider => {
  const value = await agent(cwd, { provider, model: 'fixture-model' });
  expect(await value.dispatchCommand('/permissions')).toBeDefined();
  expect(sdk.options).toEqual([]); expect(sdk.anthropicOptions).toEqual([]);
});

it.each(providers)('%s 有效自定义 key 不混用默认凭据', async provider => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fake-explicit-key');
  vi.stubEnv('OPENAI_API_KEY', 'fake-default-openai');
  vi.stubEnv('ANTHROPIC_API_KEY', 'fake-default-anthropic');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fake-default-bearer');
  const value = await agent(cwd, { provider, model: 'fixture-model', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://configured.invalid/v1' });
  expect((await value.loop.run('offline test')).reason).toBe('completed');
  const options = provider === 'openai' ? sdk.options : sdk.anthropicOptions;
  expect(options).toEqual([{ apiKey: 'fake-explicit-key', baseURL: 'https://configured.invalid/v1', ...(provider === 'anthropic' ? { authToken: null } : {}) }]);
});

it.each(providers.flatMap(provider => [undefined, 'fake-explicit-key'].map(key => ({ provider, key }))))(
  '$provider 的显式变量不传给实际调用的备用 provider（值=$key）', async ({ provider, key }) => {
    vi.stubEnv('DEEPSEEK_API_KEY', key);
    vi.stubEnv('OPENAI_API_KEY', 'fake-default-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-default-anthropic');
    const value = await agent(cwd, { provider, model: 'fixture-model', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://configured.invalid/v1' });
    const backup = provider === 'openai' ? 'anthropic' : 'openai';
    await expect(complete(value.providers.get(backup), request, new AbortController().signal)).resolves.toMatchObject({ text: 'offline fixture' });
    const options = backup === 'openai' ? sdk.options : sdk.anthropicOptions;
    expect(options).toEqual([{ apiKey: `fake-default-${backup}`, baseURL: undefined }]);
  },
);

it('Anthropic 未指定 apiKeyEnv 时保留默认变量与 SDK 默认认证行为', async () => {
  await writeFile(join(cwd, '.env'), 'ANTHROPIC_API_KEY=fake-default-anthropic\n');
  const value = await agent(cwd, { provider: 'anthropic', model: 'fixture-model' });
  expect((await value.loop.run('offline test')).reason).toBe('completed');
  expect(sdk.anthropicOptions).toEqual([{ apiKey: 'fake-default-anthropic', baseURL: undefined }]);
});


it.each([false, true])('真实 Anthropic SDK 离线请求头：显式变量=%s 时不会混入默认 bearer', async explicit => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fake-explicit-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'fake-default-anthropic');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fake-default-bearer');
  const value = await agent(cwd, { provider: 'anthropic', model: 'fixture-model', ...(explicit ? { apiKeyEnv: 'DEEPSEEK_API_KEY' } : {}) });
  expect((await value.loop.run('offline test')).reason).toBe('completed');
  const { default: RealAnthropic } = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  // 只运行 SDK 的本地 header 构造函数，fetch 必须保持零次调用。
  const fetch = vi.fn().mockRejectedValue(new Error('offline fixture forbids network'));
  const client = new RealAnthropic({ ...sdk.anthropicOptions[0], fetch });
  const { values: headers } = await (client as unknown as { authHeaders(options: object): Promise<{ values: Headers }> }).authHeaders({});
  expect(headers.get('x-api-key')).toBe(explicit ? 'fake-explicit-key' : 'fake-default-anthropic');
  expect(headers.get('authorization')).toBe(explicit ? null : 'Bearer fake-default-bearer');
  expect(fetch).not.toHaveBeenCalled();
});
