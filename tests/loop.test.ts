/**
 * Agent loop 端到端测试：FakeProvider 脚本化驱动全链路。
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextManager, estimateTokens } from '../src/core/context/manager.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { AgentLoop } from '../src/core/loop.js';
import { PermissionEngine } from '../src/core/permission/engine.js';
import type { PluginContext } from '../src/core/plugin.js';
import type { StreamEvent } from '../src/core/protocol/types.js';
import { ProviderRegistry, ToolRegistry } from '../src/core/registry.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { builtinTools } from '../src/tools/index.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-test-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeLoop(opts: {
  script: ScriptedResponse[];
  mode?: 'ask' | 'auto' | 'yolo';
  rules?: { allow: string[]; ask: string[]; deny: string[] };
  events?: EventBus;
  hooks?: HookRunner;
  maxTurns?: number;
  compactThreshold?: number;
  cache?: { enabled: boolean; ttl: '5m' | '1h'; escalateAfterMs?: number };
}) {
  const events = opts.events ?? new EventBus();
  const tools = new ToolRegistry();
  const hooks = opts.hooks ?? new HookRunner();
  const ctx: PluginContext = {
    providers: new ProviderRegistry(),
    tools,
    hooks: { register: (point, handler) => hooks.register(point, handler) },
    config: {} as PluginContext['config'],
  };
  builtinTools.register(ctx);

  const permission = new PermissionEngine({
    mode: opts.mode ?? 'auto',
    rules: opts.rules ?? { allow: [], ask: [], deny: [] },
  });
  const provider = new FakeProvider(opts.script);
  const context = new ContextManager({ compactThreshold: opts.compactThreshold ?? 1_000_000 });
  const loop = new AgentLoop({
    provider,
    model: 'fake',
    tools,
    permission,
    hooks,
    events,
    context,
    systemPrompt: 'test',
    maxTurns: opts.maxTurns ?? 10,
    cwd: tmp,
    ...(opts.cache ? { cache: opts.cache } : {}),
  });
  return { loop, events, provider, permission, tools, context };
}

function collect(events: EventBus): AgentEvent[] {
  const log: AgentEvent[] = [];
  for (const type of ['text_delta', 'tool_call', 'tool_result', 'turn_end', 'loop_end', 'permission_request', 'error'] as const) {
    events.on(type, (e) => log.push(e as AgentEvent));
  }
  return log;
}

function textOf(log: AgentEvent[]): string {
  return log
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e as Extract<AgentEvent, { type: 'text_delta' }>).text)
    .join('');
}

describe('AgentLoop', () => {
  it('每次模型响应触发一次 TurnEnd；请求快照不会随后续对话改变', async () => {
    await writeFile(join(tmp, 'x'), 'data');
    const hooks = new HookRunner();
    const turns: Array<{ turn: number; stopReason: string }> = [];
    hooks.register('TurnEnd', (payload) => turns.push(payload));
    const { loop, provider } = makeLoop({ hooks, script: [
      toolUseResponse([{ id: 't', name: 'read_file', input: { path: 'x' } }]),
      textResponse('done'), textResponse('next'),
    ] });
    const result = await loop.run('read');
    const firstRequest = structuredClone(provider.requests[0]);
    await loop.run('next');
    expect(turns.map((t) => [t.turn, t.stopReason])).toEqual([[1, 'tool_use'], [2, 'end_turn'], [1, 'end_turn']]);
    expect(result).toMatchObject({ reason: 'completed', turns: 2, usage: { inputTokens: 20, outputTokens: 20 } });
    expect(provider.requests[0]).toEqual(firstRequest);
    expect(provider.requests[0].messages).toHaveLength(1);
  });

  it('没有 UI 和错误订阅者时，失败仍返回明确终态并且只结束一次', async () => {
    const { loop, events } = makeLoop({ script: [() => { throw new Error('offline failure'); }] });
    const ends: unknown[] = [];
    events.on('loop_end', (event) => ends.push(event));
    const result = await loop.run('fail');
    expect(result).toMatchObject({ reason: 'error', error: 'offline failure' });
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ reason: 'error' });
  });

  it('输出截断不会标为完成，dispose 后拒绝新的轮次', async () => {
    const { loop } = makeLoop({ script: [[
      { type: 'message_start' }, { type: 'text_delta', text: 'partial' },
      { type: 'message_stop', stopReason: 'max_tokens' },
    ]] });
    expect((await loop.run('long')).reason).toBe('max_tokens');
    await loop.dispose();
    await expect(loop.run('again')).rejects.toThrow('disposed');
  });

  it('审批等待可以中断，过期的允许回调不会执行或记住操作', async () => {
    const events = new EventBus();
    const { loop, permission, tools } = makeLoop({
      events,
      mode: 'ask',
      script: [toolUseResponse([{ id: 'cancelled', name: 'write_file', input: { path: 'cancelled.txt', content: 'no' } }])],
    });
    let lateResolve: ((d: import('../src/core/events.js').UserDecision) => void) | undefined;
    events.on('permission_request', (e) => {
      lateResolve = e.resolve;
      loop.abort_current();
      expect(e.signal.aborted).toBe(true);
    });
    const log = collect(events);
    await loop.run('write');
    lateResolve?.({ allow: true, remember: 'session' });
    expect(log.at(-1)).toMatchObject({ type: 'loop_end', reason: 'aborted' });
    expect(log.some((e) => e.type === 'tool_call')).toBe(false);
    await expect(access(join(tmp, 'cancelled.txt'))).rejects.toThrow();
    expect(permission.check(tools.get('write_file')!, { path: 'cancelled.txt' }).kind).toBe('ask');
  });

  it('并行审批全部可取消，loop 不会继续等待其他请求', async () => {
    const events = new EventBus();
    const { loop } = makeLoop({
      events, mode: 'ask',
      script: [toolUseResponse([
        { id: 'a', name: 'read_file', input: { path: 'a' } },
        { id: 'b', name: 'read_file', input: { path: 'b' } },
      ])],
    });
    let requests = 0;
    events.on('permission_request', () => { if (++requests === 2) loop.abort_current(); });
    const log = collect(events);
    await loop.run('read');
    expect(requests).toBe(2);
    expect(log.at(-1)).toMatchObject({ type: 'loop_end', reason: 'aborted' });
    expect(log.filter((e) => e.type === 'tool_call')).toHaveLength(0);
  });

  it('运行中拒绝重入，保留当前轮次的取消控制器', async () => {
    const events = new EventBus();
    const { loop } = makeLoop({
      events, mode: 'ask',
      script: [toolUseResponse([{ id: 'a', name: 'read_file', input: { path: 'a' } }])],
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    events.on('permission_request', entered);
    const first = loop.run('first');
    await waiting;
    await expect(loop.run('second')).rejects.toThrow('already running');
    loop.abort_current();
    await first;
  });

  it('dispose 中断审批并等待结果回填，清理后不能再运行', async () => {
    const { loop, events } = makeLoop({ mode: 'ask', script: [
      toolUseResponse([{ id: 'pending', name: 'write_file', input: { path: 'x', content: 'no' } }]),
    ] });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    events.on('permission_request', entered);
    const run = loop.run('write');
    await waiting;
    await loop.dispose();
    expect((await run).reason).toBe('aborted');
    expect(loop.getMessages().at(-1)?.content).toMatchObject([
      { type: 'tool_result', toolUseId: 'pending', isError: true },
    ]);
    await expect(access(join(tmp, 'x'))).rejects.toThrow();
    await expect(loop.run('next')).rejects.toThrow('disposed');
  });

  it('纯文本对话一轮结束', async () => {
    const { loop, events } = makeLoop({ script: [textResponse('你好，世界')] });
    const log = collect(events);
    await loop.run('hi');
    expect(textOf(log)).toBe('你好，世界');
    expect(log.at(-1)).toMatchObject({ type: 'loop_end', reason: 'completed' });
  });

  it('工具调用全链路：模型调 read_file → 执行 → 结果回填给模型', async () => {
    await writeFile(join(tmp, 'hello.txt'), 'file-content-42');
    const secondTurn: ScriptedResponse = (req): StreamEvent[] => {
      // 断言：回填给模型的是 user 角色的 tool_result，包含文件内容
      const last = req.messages.at(-1);
      expect(last?.role).toBe('user');
      expect(JSON.stringify(last?.content)).toContain('file-content-42');
      return (textResponse('读取完成') as StreamEvent[]);
    };
    const { loop, events } = makeLoop({
      script: [toolUseResponse([{ id: 't1', name: 'read_file', input: { path: 'hello.txt' } }]), secondTurn],
    });
    const log = collect(events);
    await loop.run('读一下 hello.txt');
    expect(textOf(log)).toContain('读取完成');
  });

  it('deny 规则：工具被拒绝且错误回填给模型', async () => {
    const { loop, events } = makeLoop({
      mode: 'yolo',
      rules: { allow: [], ask: [], deny: ['bash'] },
      script: [
        toolUseResponse([{ id: 't1', name: 'bash', input: { command: 'ls' } }]),
        textResponse('好的，我不执行'),
      ],
    });
    const log = collect(events);
    await loop.run('list files');
    const result = log.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.result.isError).toBe(true);
    expect(result.result.content).toContain('Permission denied');
  });

  it('ask 流程：permission_request 挂起，用户允许后执行', async () => {
    const events = new EventBus();
    const { loop } = makeLoop({
      mode: 'ask',
      events,
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'out.txt', content: 'abc' } }]),
        textResponse('写好了'),
      ],
    });
    // 模拟 UI：自动点"允许一次"
    events.on('permission_request', (e) => e.resolve({ allow: true }));
    await loop.run('write out.txt');
    expect(await readFile(join(tmp, 'out.txt'), 'utf-8')).toBe('abc');
  });

  it('"本次会话始终允许"：第二次同类调用不再询问', async () => {
    const events = new EventBus();
    const { loop } = makeLoop({
      mode: 'ask',
      events,
      script: [
        toolUseResponse([{ id: 't1', name: 'write_file', input: { path: 'a.txt', content: '1' } }]),
        toolUseResponse([{ id: 't2', name: 'write_file', input: { path: 'a.txt', content: '2' } }]),
        textResponse('done'),
      ],
    });
    let askCount = 0;
    events.on('permission_request', (e) => {
      askCount++;
      e.resolve({ allow: true, remember: 'session' });
    });
    await loop.run('write twice');
    expect(askCount).toBe(1); // 第二次命中会话级规则，静默放行
    expect(await readFile(join(tmp, 'a.txt'), 'utf-8')).toBe('2');
  });

  it('用户拒绝：反馈以 tool_result 回填', async () => {
    const events = new EventBus();
    const secondTurn: ScriptedResponse = (req): StreamEvent[] => {
      expect(JSON.stringify(req.messages.at(-1)?.content)).toContain('User denied');
      return textResponse('明白') as StreamEvent[];
    };
    const { loop } = makeLoop({
      mode: 'ask',
      events,
      script: [toolUseResponse([{ id: 't1', name: 'bash', input: { command: 'rm x' } }]), secondTurn],
    });
    events.on('permission_request', (e) => e.resolve({ allow: false, feedback: '太危险' }));
    const log = collect(events);
    await loop.run('delete x');
    expect(textOf(log)).toContain('明白');
  });

  it('PreToolUse 钩子可以否决工具调用', async () => {
    const hooks = new HookRunner();
    hooks.register('PreToolUse', (payload: { toolName: string }) => {
      if (payload.toolName === 'bash') return { veto: '本环境禁止 bash' };
    });
    const { loop, events } = makeLoop({
      hooks,
      mode: 'yolo',
      script: [toolUseResponse([{ id: 't1', name: 'bash', input: { command: 'ls' } }]), textResponse('ok')],
    });
    const log = collect(events);
    await loop.run('ls');
    const result = log.find((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>;
    expect(result.result.content).toContain('Vetoed');
  });

  it('达到 maxTurns 时停止', async () => {
    await writeFile(join(tmp, 'x'), 'data');
    const { loop, events } = makeLoop({
      mode: 'auto',
      maxTurns: 3,
      script: Array(15).fill(toolUseResponse([{ id: 't', name: 'read_file', input: { path: 'x' } }])),
    });
    const log = collect(events);
    await loop.run('loop forever');
    expect(log.at(-1)).toMatchObject({ type: 'loop_end', reason: 'max_turns' });
  });

  it('缓存断点随轮次前移，工具列表在首次请求后冻结', async () => {
    await writeFile(join(tmp, 'hello.txt'), 'file-content-42');
    const { loop, provider, tools } = makeLoop({
      script: [
        (req) => {
          tools.register({
            name: 'extra_tool',
            description: 'should not appear in later requests',
            inputSchema: { type: 'object' },
            risk: 'read',
            async execute() {
              return { content: '' };
            },
          });
          expect(req.cache?.messageBreakpoints).toEqual([0]);
          expect(req.cache?.system).toBe(true);
          expect(req.cache?.tools).toBe(true);
          return toolUseResponse([{ id: 't1', name: 'read_file', input: { path: 'hello.txt' } }]);
        },
        textResponse('读取完成'),
      ],
    });
    await loop.run('读一下 hello.txt');
    expect(provider.requests[1].cache?.messageBreakpoints).toEqual([0, 2]);
    expect(provider.requests[1].cache?.system).toBe(true);
    expect(provider.requests[1].cache?.tools).toBe(true);
    expect(provider.requests[1].tools).toEqual(provider.requests[0].tools);
    expect(provider.requests[0].tools.some((t) => t.name === 'extra_tool')).toBe(false);
  });

  it('压缩发生在下一次用户输入的开头，并重置读断点', async () => {
    await writeFile(join(tmp, 'x'), 'data');
    let agentTurns = 0;
    const { loop, provider, events, context } = makeLoop({
      maxTurns: 8,
      script: [
        (req) => {
          if (req.system.includes('压缩器')) return textResponse('早期摘要');
          agentTurns++;
          if (agentTurns <= 4) {
            return toolUseResponse([{ id: `t${agentTurns}`, name: 'read_file', input: { path: 'x' } }]);
          }
          return textResponse('done');
        },
      ],
    });
    const compactAt: number[] = [];
    events.on('compacted', () => compactAt.push(provider.requests.length));
    await loop.run('build history');
    expect(compactAt).toEqual([]);
    expect(loop.getMessages().length).toBeGreaterThanOrEqual(8);

    context.setThreshold(1);
    const before = provider.requests.length;
    const result = await loop.run('next');
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 20 });
    expect(compactAt).toEqual([before + 1]);
    const summary = provider.requests[before];
    expect(summary.system).toContain('压缩器');
    expect(summary.cache).toBeUndefined();
    const agentReq = provider.requests[before + 1];
    // 请求保存调用时的独立快照，读断点落在本次请求的最后一条消息上。
    expect(agentReq.cache?.messageBreakpoints).toEqual([agentReq.messages.length - 1]);
    expect(agentReq.messages.at(-1)?.role).toBe('user');
    expect(JSON.stringify(loop.getMessages()[0]?.content)).toContain('早期对话摘要');
  });

  it('同一次 run 里，体积超过阈值但未到 1.5 倍时不在工具轮次中间压缩', async () => {
    await writeFile(join(tmp, 'x'), 'data');
    let probeTurns = 0;
    let tokensWhenLong = 0;
    const probe = makeLoop({
      maxTurns: 8,
      script: [
        () => {
          probeTurns++;
          return probeTurns <= 4
            ? toolUseResponse([{ id: `p${probeTurns}`, name: 'read_file', input: { path: 'x' } }])
            : textResponse('done');
        },
      ],
    });
    probe.events.on('turn_end', () => {
      const messages = probe.loop.getMessages();
      if (messages.length >= 8 && tokensWhenLong === 0) tokensWhenLong = estimateTokens(messages);
    });
    await probe.loop.run('probe');
    expect(tokensWhenLong).toBeGreaterThan(3);

    let turns = 0;
    const events = new EventBus();
    const { loop } = makeLoop({
      events,
      compactThreshold: tokensWhenLong - 1,
      maxTurns: 8,
      script: [
        () => {
          turns++;
          return turns <= 4
            ? toolUseResponse([{ id: `t${turns}`, name: 'read_file', input: { path: 'x' } }])
            : textResponse('done');
        },
      ],
    });
    let compacted = 0;
    events.on('compacted', () => compacted++);
    await loop.run('stay raw');
    expect(compacted).toBe(0);
    expect(JSON.stringify(loop.getMessages()[0]?.content)).not.toContain('早期对话摘要');
    expect(estimateTokens(loop.getMessages())).toBeGreaterThan(tokensWhenLong - 1);
    expect(estimateTokens(loop.getMessages())).toBeLessThanOrEqual((tokensWhenLong - 1) * 1.5);
  });
});
