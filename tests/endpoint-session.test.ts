import { mkdtempProject } from './helpers/project.js';
/** 端点身份回归：SDK 使用假实现，不访问网络，也不需要真实密钥。 */
import { writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ endpoints: [] as Array<string | undefined> }));
vi.mock('openai', () => ({ default: class {
  constructor(options: { baseURL?: string }) { sdk.endpoints.push(options.baseURL); }
  chat = { completions: { create: async function* () {
    yield { choices: [{ delta: { content: 'mock response' }, finish_reason: null }] };
    yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
  } } };
} }));
import { createAgent, loadSession, sessionPath, type Agent } from '../src/index.js';
let cwd: string;
const agents: Agent[] = [];
beforeEach(async () => {
  cwd = await mkdtempProject(join(tmpdir(), 'agent-endpoint-regression-'));
  sdk.endpoints.length = 0;
  vi.stubEnv('OPENAI_API_KEY', 'fake-never-sent');
  vi.stubEnv('ANTHROPIC_API_KEY', 'fake-never-sent');
  vi.stubEnv('OPENAI_BASE_URL', undefined);
});
afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
async function agent(config: Record<string, unknown> = {}) {
  await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ provider: 'openai', model: 'mock', ...config }));
  const value = await createAgent(cwd, { autoSaveSessions: false });
  agents.push(value);
  return value;
}
async function save(value: Agent) {
  value.loop.importSession({ model: 'mock', thinking: 'off', messages: [{ role: 'user', content: 'saved history' }] });
  await value.session.save();
  return value.session.id;
}
it('环境变量端点改变时拒绝恢复，保持当前会话不变', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://a.invalid/v1');
  const first = await agent(); const id = await save(first);
  vi.stubEnv('OPENAI_BASE_URL', 'https://b.invalid/v1');
  const second = await agent(); const currentId = second.session.id;
  await expect(second.session.resume(id)).rejects.toMatchObject({ code: 'provider_mismatch' });
  expect(second.loop.getMessages()).toEqual([]);
  expect(second.session.id).toBe(currentId);
});
it('同一环境变量端点可恢复，落盘仅存指纹', async () => {
  const endpoint = 'https://user:fake-secret@a.invalid/v1?token=fake-token';
  vi.stubEnv('OPENAI_BASE_URL', endpoint);
  const first = await agent(); const id = await save(first);
  const file = await loadSession(cwd, id);
  expect(file.endpointKey).toBe(createHash('sha256').update(endpoint).digest('hex'));
  const text = await readFile(sessionPath(cwd, id), 'utf8');
  for (const secret of ['fake-secret', 'fake-token', 'a.invalid']) expect(text).not.toContain(secret);
  const second = await agent(); await expect(second.session.resume(id)).resolves.toMatchObject({ id });
});
it('配置端点优先于环境变量，环境变量变化不造成误拒绝', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://env-a.invalid');
  const first = await agent({ baseURL: 'https://configured.invalid' }); const id = await save(first);
  vi.stubEnv('OPENAI_BASE_URL', 'https://env-b.invalid');
  const second = await agent({ baseURL: 'https://configured.invalid' });
  await expect(second.session.resume(id)).resolves.toMatchObject({ id });
  await second.loop.run('continue'); expect(sdk.endpoints).toEqual(['https://configured.invalid']);
});
it('组装后环境变量变化不使实际 SDK 端点与已记录身份漂移', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://initial.invalid/v1');
  const first = await agent();
  vi.stubEnv('OPENAI_BASE_URL', 'https://changed.invalid/v1');
  await first.loop.run('hello'); await first.session.save();
  expect(sdk.endpoints).toEqual(['https://initial.invalid/v1']);
  expect((await loadSession(cwd, first.session.id)).endpointKey).toBe(createHash('sha256').update('https://initial.invalid/v1').digest('hex'));
});
it('默认端点保留旧 default 身份，且创建后设置环境变量不会改变目的地', async () => {
  const first = await agent(); const id = await save(first);
  expect((await loadSession(cwd, id)).endpointKey).toBe('default');
  const second = await agent(); await second.session.resume(id);
  vi.stubEnv('OPENAI_BASE_URL', 'https://late.invalid');
  await second.loop.run('continue');
  expect(sdk.endpoints).toEqual(['https://api.openai.com/v1']);
});
it('其他 provider 不受 OpenAI 环境变量影响', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://a.invalid');
  const first = await agent({ provider: 'fake' }); const id = await save(first);
  vi.stubEnv('OPENAI_BASE_URL', 'https://b.invalid');
  const second = await agent({ provider: 'fake' });
  await expect(second.session.resume(id)).resolves.toMatchObject({ id });
});
it.each(['', '   '])('显式端点 %j 与真实 SDK 的默认回退行为一致', async (baseURL) => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://fallback.invalid');
  // 仅构造真实 SDK 客户端读取最终 baseURL，不发请求；流式调用仍由上面的假 SDK 接管。
  const { default: RealOpenAI } = await vi.importActual<typeof import('openai')>('openai');
  const expectedEndpoint = new RealOpenAI({ apiKey: 'fake-never-sent', baseURL }).baseURL;
  const first = await agent({ baseURL });
  await first.loop.run('hello'); await first.session.save();
  expect(sdk.endpoints).toEqual([expectedEndpoint]);
  const expectedKey = baseURL ? createHash('sha256').update(expectedEndpoint).digest('hex') : 'default';
  expect((await loadSession(cwd, first.session.id)).endpointKey).toBe(expectedKey);
});
it('旧环境变量会话的 default 标记不能被当作已验证端点，legacy 开关也不绕过', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://old-env.invalid/v1');
  const first = await agent(); const id = await save(first);
  const path = sessionPath(cwd, id);
  // 模拟修复前版本将环境变量端点错误保存为 default 的格式。
  const old = JSON.parse(await readFile(path, 'utf8'));
  old.endpointKey = 'default'; await writeFile(path, JSON.stringify(old));
  const second = await agent();
  await expect(second.session.resume(id)).rejects.toMatchObject({ code: 'provider_mismatch' });
  await expect(second.session.resume(id, { allowLegacyProvider: true })).rejects.toMatchObject({ code: 'provider_mismatch' });
  expect(second.loop.getMessages()).toEqual([]);
});
