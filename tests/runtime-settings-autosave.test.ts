import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/index.js';
import { definePlugin, type InteractionRequest } from '../src/sdk/index.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { ConfigConflictError, settingsErrorMessage } from '../src/runtime/config-store.js';
import { mkdtempProjectSync } from './helpers/project.js';

const dirs: string[] = [];
let home: string;
const project = () => {
  const cwd = mkdtempProjectSync(join(tmpdir(), 'runtime-autosave-'));
  dirs.push(cwd);
  return cwd;
};
const write = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'runtime-autosave-home-'));
  dirs.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('模型与思考设置立即保存并应用', () => {
  it('命令写项目并立即应用，保留 provider/端点/凭据引用与未知字段，重启仍保持', async () => {
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    const original = {
      provider: 'fake',
      model: 'before',
      baseURL: 'https://endpoint.invalid/v1',
      apiKeyEnv: 'TEST_ONLY_KEY',
      future: { keep: true },
    };
    write(path, original);
    let agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      await agent.dispatchCommand('/model after');
      await agent.dispatchCommand('/think high');
      expect(read(path)).toEqual({ ...original, model: 'after', thinking: 'high' });
      expect(agent.loop.model).toBe('after');
      expect(agent.loop.thinking).toBe('high');
      expect(agent.loop.providerName).toBe('fake');
      await agent.dispose();
      agent = await createAgent(cwd, { autoSaveSessions: false });
      expect(agent.loop.model).toBe('after');
      expect(agent.loop.thinking).toBe('high');
    } finally {
      await agent.dispose();
    }
  });

  it('一次选择即保存，取消和中途文件修改均不保存、不应用', async () => {
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    write(path, { provider: 'fake', model: 'before' });
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      const interact = vi.fn(async () => 'medium');
      await agent.dispatchCommand('/think', { interact });
      expect(interact).toHaveBeenCalledTimes(1);
      expect(read(path).thinking).toBe('medium');
      const before = readFileSync(path, 'utf8');
      await agent.dispatchCommand('/model', { interact: async () => undefined });
      expect(readFileSync(path, 'utf8')).toBe(before);
      await expect(
        agent.dispatchCommand('/model', {
          interact: async () => {
            write(path, { provider: 'fake', model: 'external', future: true });
            return 'chosen';
          },
        }),
      ).rejects.toThrow(/配置已变化/);
      expect(agent.loop.model).toBe('before');
      expect(read(path)).toEqual({ provider: 'fake', model: 'external', future: true });
    } finally {
      await agent.dispose();
    }
  });

  it('显式项目命令替换会话启动覆盖，不修改全局层', async () => {
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    const globalPath = join(home, '.agentlab', 'config.json');
    write(path, { provider: 'fake', model: 'project-model' });
    write(globalPath, { model: 'global-model', thinking: 'low', future: true });
    const agent = await createAgent(cwd, {
      autoSaveSessions: false,
      config: { model: 'session-model' },
    });
    try {
      await agent.dispatchCommand('/model chosen');
      await agent.dispatchCommand('/think high');
      expect(agent.loop.model).toBe('chosen');
      expect(agent.loop.thinking).toBe('high');
      expect(read(path)).toEqual({ provider: 'fake', model: 'chosen', thinking: 'high' });
      expect(read(globalPath)).toEqual({ model: 'global-model', thinking: 'low', future: true });
    } finally {
      await agent.dispose();
    }
  });

  it('保存失败不改变当前运行值，错误不泄露文件中的值', async () => {
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    write(path, { provider: 'fake', model: 'before' });
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      writeFileSync(path, '{"private":"SECRET_SHOULD_NOT_APPEAR" trailing');
      const failure = await agent.dispatchCommand('/model chosen').catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toContain('SECRET_SHOULD_NOT_APPEAR');
      expect(agent.loop.model).toBe('before');
    } finally {
      await agent.dispose();
    }
  });
  it('错误元数据和模型 ID 不能回显秘密或终端控制符', async () => {
    const malicious = Object.assign(new Error('SECRET_MESSAGE'), { code: 'SECRET_CODE' });
    expect(settingsErrorMessage(malicious)).not.toContain('SECRET');
    expect(settingsErrorMessage(new ConfigConflictError('SECRET_CONFLICT'))).not.toContain(
      'SECRET',
    );
    expect(
      settingsErrorMessage(Object.assign(new Error('SECRET_PATH'), { code: 'EACCES' })),
    ).toContain('EACCES');
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    write(path, { provider: 'fake', model: 'before' });
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      for (const control of ['\x1b', '\x00', '\x7f'])
        await expect(agent.dispatchCommand(`/model bad${control}model`)).rejects.toThrow(/用法/);
      expect(read(path).model).toBe('before');
      expect(agent.loop.model).toBe('before');
    } finally {
      await agent.dispose();
    }
  });

  it('设置已保存而自定义运行应用失败时，报告真实持久化状态且隐藏插件错误', async () => {
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    write(path, { provider: 'fake', model: 'before' });
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      vi.spyOn(agent.loop, 'setModel').mockImplementation(() => {
        throw new Error('SECRET_PLUGIN_APPLY_ERROR');
      });
      const failure = await agent.dispatchCommand('/model chosen').catch((error) => error);
      expect(failure.message).toContain('设置已保存');
      expect(failure.message).not.toContain('SECRET_PLUGIN_APPLY_ERROR');
      expect(read(path).model).toBe('chosen');
      expect(agent.loop.model).toBe('before');
    } finally {
      await agent.dispose();
    }
  });

  it('Kimi 模型切换原子保存兼容 thinking，非法等级在保存前拒绝', async () => {
    const cwd = project();
    const path = join(cwd, 'agent.config.json');
    write(path, { provider: 'kimi-test', model: 'k3', thinking: 'medium' });
    const provider = definePlugin({
      manifest: { id: 'test.kimi-settings', version: '1.0.0', apiVersion: 1 },
      setup(ctx) {
        const base = new OpenAIProvider({
          apiKey: 'offline-never-sent',
          baseURL: 'https://api.kimi.ai/coding/v1',
        });
        ctx.provide.provider('kimi-test', {
          name: 'kimi-test',
          capabilities: base.capabilities,
          modelCapabilities: base.modelCapabilities.bind(base),
          stream: base.stream.bind(base),
        });
      },
    });
    let agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [provider] });
    try {
      expect(agent.loop.thinking).toBe('high');
      await expect(agent.dispatchCommand('/think off')).rejects.toThrow('low|high');
      expect(read(path)).toMatchObject({ model: 'k3', thinking: 'medium' });
      await agent.dispatchCommand('/model k3.1-pro');
      expect(read(path)).toMatchObject({ model: 'k3.1-pro', thinking: 'high' });
      const interact = vi.fn(async (_request: InteractionRequest) => 'low');
      await agent.dispatchCommand('/think', { interact });
      expect(interact.mock.calls[0][0].choices).toEqual([
        { id: 'low', label: 'low' },
        { id: 'high', label: 'high' },
      ]);
      expect(read(path).thinking).toBe('low');
      await agent.dispose();
      agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [provider] });
      expect(agent.loop.thinking).toBe('low');
    } finally {
      await agent.dispose();
    }
  });
});
