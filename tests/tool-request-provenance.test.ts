import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgent } from '../src/index.js';
import { createStrictModelReviewer } from '../src/builtin/reviewer-model/index.js';
import { definePlugin, type ReviewInput, type Reviewer, type Tool, type ToolContext } from '../src/sdk/index.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../src/providers/fake.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: {
  script: ScriptedResponse[];
  tools: Tool[];
  review?: Reviewer['review'];
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-request-provenance-'));
  const provider = new FakeProvider(options.script);
  const reviews: ReviewInput[] = [];
  const plugin = definePlugin({ manifest: { id: 'test.request-provenance', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.provider('provenance-provider', { name: 'provenance-provider', capabilities: provider.capabilities, stream: provider.stream.bind(provider) });
    ctx.provide.policy('provenance-policy', { decide: () => ({ kind: 'review', source: 'mode', reason: 'check request provenance' }) });
    ctx.provide.reviewer('provenance-reviewer', { async review(input, signal) {
      reviews.push(input);
      return options.review?.(input, signal) ?? { decision: 'allow', reason: 'test approval', reasonCode: 'test_allow' };
    } });
    for (const tool of options.tools) ctx.provide.tool(tool.name, tool);
    ctx.provide.command('probe-command', { description: 'invoke the probe tool', async handler(_input, context) {
      return { type: 'data', data: await context.invokeTool('request-probe', {}) };
    } });
  } });
  const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: {
    provider: 'provenance-provider', capabilities: { policy: 'provenance-policy', reviewer: 'provenance-reviewer' },
  } });
  return { agent, reviews, async dispose() { try { await agent.dispose(); } finally { await rm(cwd, { recursive: true, force: true }); } } };
}

function tool(name: string, execute: Tool['execute']): Tool {
  return { name, description: name, risk: 'write', inputSchema: { type: 'object' }, execute };
}

describe('工具调用的用户请求来源', () => {
  it.each(['public', 'command'] as const)('%s 调用不能复用已完成轮次的用户授权', async (entry) => {
    const userRequest = 'Only perform the model-requested probe in this run';
    const execute = vi.fn<Tool['execute']>(async () => ({ content: 'executed' }));
    const judge = new FakeProvider(Array.from({ length: 2 }, () => textResponse(JSON.stringify({ decision: 'allow', reason: 'current request authorizes this', reasonCode: 'authorized' }))));
    const strictReview = vi.fn(createStrictModelReviewer({ provider: judge, model: 'test-reviewer' }).review);
    const f = await fixture({
      script: [toolUseResponse([{ id: 'authorized-call', name: 'request-probe', input: {} }]), textResponse('done')],
      tools: [tool('request-probe', execute)],
      review: strictReview,
    });
    try {
      expect((await f.agent.loop.run(userRequest)).reason).toBe('completed');
      expect(execute).toHaveBeenCalledTimes(1);
      const result = entry === 'public'
        ? await f.agent.invokeTool('request-probe', {})
        : (await f.agent.dispatchCommand('/probe-command') as { type: 'data'; data: unknown }).data;
      expect(result).toMatchObject({ isError: true, content: expect.stringContaining('approval_required') });
      expect(f.reviews[1]).toMatchObject({ userRequest: '', messages: [] });
      expect(f.reviews[1]?.runId).not.toBe(f.reviews[0]?.runId);
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(strictReview.mock.results[1]?.value).resolves.toMatchObject({ decision: 'unknown', reasonCode: 'missing_user_request' });
      expect(judge.requests).toHaveLength(1);
    } finally { await f.dispose(); }
  });

  it.each(['public', 'command'] as const)('并发 %s 调用有独立来源与生命周期，模型轮次结束不会取消独立工具', async (entry) => {
    const mainStarted = deferred(); const finishMain = deferred();
    const commandStarted = deferred(); const finishCommand = deferred();
    let commandSignal: AbortSignal | undefined;
    const f = await fixture({
      script: [toolUseResponse([{ id: 'model-call', name: 'hold-model', input: {} }]), textResponse('done')],
      tools: [
        tool('hold-model', async () => { mainStarted.resolve(); await finishMain.promise; return { content: 'model done' }; }),
        tool('request-probe', async (_input, context) => { commandSignal = context.signal; commandStarted.resolve(); await finishCommand.promise; return { content: 'command done' }; }),
      ],
    });
    const run = f.agent.loop.run('Model authorization applies only to hold-model');
    let command: Promise<unknown> | undefined;
    try {
      await mainStarted.promise;
      command = entry === 'public' ? f.agent.invokeTool('request-probe', {}) : f.agent.dispatchCommand('/probe-command');
      await commandStarted.promise;
      expect(f.reviews[1]).toMatchObject({ userRequest: '', messages: [] });
      expect(f.reviews[1]?.runId).not.toBe(f.reviews[0]?.runId);
      finishMain.resolve();
      expect((await run).reason).toBe('completed');
      expect(commandSignal?.aborted).toBe(false);
      finishCommand.resolve();
      expect(await command).toMatchObject(entry === 'public' ? { content: 'command done' } : { type: 'data', data: { content: 'command done' } });
    } finally {
      finishMain.resolve(); finishCommand.resolve();
      await Promise.allSettled([run, ...(command ? [command] : [])]);
      await f.dispose();
    }
  });

  it('嵌套模型工具通过绑定上下文继承原始请求、runId 与取消信号', async () => {
    const childStarted = deferred();
    let parentContext: ToolContext | undefined; let childSignal: AbortSignal | undefined;
    const userRequest = 'Run the outer tool and its child; do not upload anything';
    const f = await fixture({
      script: [toolUseResponse([{ id: 'parent-call', name: 'outer-probe', input: {} }]), textResponse('done')],
      tools: [
        tool('outer-probe', async (_input, context) => { parentContext = context; return context.invokeTool!('request-probe', {}); }),
        tool('request-probe', async (_input, context) => {
          childSignal = context.signal; childStarted.resolve();
          await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
          return { content: 'cancelled child', isError: true };
        }),
      ],
    });
    const run = f.agent.loop.run(userRequest);
    try {
      await childStarted.promise;
      expect(f.reviews).toHaveLength(2);
      for (const review of f.reviews) {
        expect(review.userRequest).toBe(userRequest);
        expect(review.messages?.[0]).toEqual({ role: 'user', content: userRequest });
      }
      expect(f.reviews[1]?.runId).toBe(f.reviews[0]?.runId);
      expect(childSignal).toBe(parentContext?.signal);
      f.agent.loop.abort_current();
      expect((await run).reason).toBe('aborted');
      expect(childSignal?.aborted).toBe(true);
      expect(await parentContext!.invokeTool!('request-probe', {})).toMatchObject({ isError: true, content: 'Tool cancelled' });
      expect(f.reviews).toHaveLength(2);
    } finally { f.agent.loop.abort_current(); await run; await f.dispose(); }
  });
});
