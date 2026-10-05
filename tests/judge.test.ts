/**
 * LLM 审批员（AutoJudge）测试：auto 模式下用小模型自动审批。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextManager } from '../src/core/context/manager.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { AgentLoop } from '../src/core/loop.js';
import { PermissionEngine } from '../src/core/permission/engine.js';
import { AutoJudge } from '../src/core/permission/judge.js';
import type { PluginContext } from '../src/core/plugin.js';
import { ProviderRegistry, ToolRegistry } from '../src/core/registry.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { builtinTools } from '../src/tools/index.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-judge-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeLoop(opts: { script: ScriptedResponse[]; judge?: AutoJudge; events?: EventBus }) {
  const events = opts.events ?? new EventBus();
  const tools = new ToolRegistry();
  const hooks = new HookRunner();
  const ctx: PluginContext = {
    providers: new ProviderRegistry(),
    tools,
    hooks: { register: (p, h) => hooks.register(p, h) },
    config: {} as PluginContext['config'],
  };
  builtinTools.register(ctx);
  const loop = new AgentLoop({
    provider: new FakeProvider(opts.script),
    model: 'fake',
    tools,
    permission: new PermissionEngine({ mode: 'auto', rules: { allow: [], ask: [], deny: [] } }),
    hooks,
    events,
    context: new ContextManager({ compactThreshold: 1_000_000 }),
    systemPrompt: 'test',
    maxTurns: 10,
    cwd: tmp,
    autoJudge: opts.judge,
  });
  return { loop, events };
}

describe('LLM 审批员', () => {
  it('始终允许只记忆字面量目标，不把路径中的 glob 扩大成授权', async () => {
    const { loop, events } = makeLoop({ script: [
      toolUseResponse([{ id: 'a', name: 'write_file', input: { path: 'a*.txt', content: 'one' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'b', name: 'write_file', input: { path: 'ab.txt', content: 'two' } }]), textResponse('ok'),
      toolUseResponse([{ id: 'c', name: 'write_file', input: { path: 'a*.txt', content: 'three' } }]), textResponse('ok'),
    ] });
    let asks = 0;
    events.on('permission_request', (e) => { asks++; e.resolve({ allow: true, remember: 'session' }); });
    await loop.run('first'); await loop.run('different'); await loop.run('same');
    expect(asks).toBe(2);
  });
  it('超长参数完整审查不了时回落 ask，不能只审前缀', async () => {
    const judgeProvider = new FakeProvider([textResponse('{"verdict":"allow"}')]);
    const events = new EventBus();
    const { loop } = makeLoop({ events, judge: new AutoJudge(judgeProvider, 'judge'), script: [
      toolUseResponse([{ id: 'long', name: 'write_file', input: { content: 'x'.repeat(2100), path: '/outside/secret' } }]),
      textResponse('done'),
    ] });
    let asked = false;
    events.on('permission_request', (e) => { asked = true; e.resolve({ allow: false }); });
    await loop.run('写入');
    expect(asked).toBe(true);
    expect(judgeProvider.requests).toHaveLength(0);
  });
  it('审批员放行：auto 模式下写文件不再询问用户', async () => {
    // 审批员 provider：总是判 allow
    const judgeProvider = new FakeProvider([textResponse('{"verdict":"allow","reason":"写入项目内文件，安全"}')]);
    const { loop, events } = makeLoop({
      judge: new AutoJudge(judgeProvider, 'judge-model'),
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]),
        textResponse('done'),
      ],
    });
    const asks: AgentEvent[] = [];
    const purposes: string[] = [];
    events.on('permission_request', (e) => asks.push(e));
    events.on('model_request', (e) => purposes.push(e.purpose));
    const result = await loop.run('写文件');
    expect(purposes).toEqual(['agent', 'judge', 'agent']);
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 30 });
    expect(asks).toHaveLength(0); // 没有询问用户
    expect(await readFile(join(tmp, 'x.txt'), 'utf-8')).toBe('hi'); // 工具确实执行了
    expect(judgeProvider.requests[0].model).toBe('judge-model'); // 用的是小模型
  });

  it('审批员不确定：回落为询问用户', async () => {
    const judgeProvider = new FakeProvider([textResponse('{"verdict":"ask","reason":"删除操作拿不准"}')]);
    const events = new EventBus();
    const { loop } = makeLoop({
      events,
      judge: new AutoJudge(judgeProvider, 'judge-model'),
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]),
        textResponse('done'),
      ],
    });
    let asked = false;
    events.on('permission_request', (e) => {
      asked = true;
      e.resolve({ allow: true });
    });
    await loop.run('写文件');
    expect(asked).toBe(true);
  });

  it('审批员调用失败：保守回落为询问用户', async () => {
    const judgeProvider = new FakeProvider([
      () => {
        throw new Error('network down');
      },
    ]);
    const events = new EventBus();
    const { loop } = makeLoop({
      events,
      judge: new AutoJudge(judgeProvider, 'judge-model'),
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'hi' } }]),
        textResponse('done'),
      ],
    });
    let asked = false;
    events.on('permission_request', (e) => {
      asked = true;
      e.resolve({ allow: true });
    });
    await loop.run('写文件');
    expect(asked).toBe(true);
  });

  it('审批员不绕过 deny 规则和危险检测', async () => {
    const judgeProvider = new FakeProvider([textResponse('{"verdict":"allow","reason":"安全"}')]);
    const events = new EventBus();
    const { loop } = makeLoop({ events, judge: new AutoJudge(judgeProvider, 'judge-model'), script: [
      // 危险命令：危险检测在管线第 2 步就强制 ask，不经过审批员
      toolUseResponse([{ id: 't1', name: 'bash', input: { command: 'sudo rm -rf /opt' } }]),
      textResponse('done'),
    ] });
    let asked = false;
    events.on('permission_request', (e) => {
      asked = true;
      expect(e.request.reason).toContain('危险');
      e.resolve({ allow: false });
    });
    await loop.run('执行危险命令');
    expect(asked).toBe(true);
    expect(judgeProvider.requests).toHaveLength(0); // 审批员根本没被调用
  });
});
