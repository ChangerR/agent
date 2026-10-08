/** 同一真实 runtime 的模型调用计数；全部 FakeProvider 与临时文件。 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import type { AgentEvent } from '../src/core/events.js';
async function runFixture(v2: boolean, path = 'src/a.ts', reviewerAllows = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-v2-runtime-')); await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src/a.ts'), 'old');
  let reviews = 0; let human = 0;
  const provider = new FakeProvider([request => {
    if (!request.tools.length) {
      reviews++;
      return textResponse(request.system.includes('恰好三个字符串字段')
        ? JSON.stringify({ decision: reviewerAllows ? 'allow' : 'ask', reasonCode: 'fixture_review', reason: 'offline fixture' })
        : JSON.stringify({ verdict: reviewerAllows ? 'allow' : 'ask', reason: 'offline fixture' }));
    }
    return typeof request.messages.at(-1)?.content === 'string'
      ? toolUseResponse([{ id: 'scoped-write', name: 'write_file', input: { path, content: 'new content' } }]) : textResponse('done');
  }]);
  const plugin = definePlugin({ manifest: { id: 'test.v2-provider', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.provider('test-v2', { name: 'test-v2', capabilities: provider.capabilities, stream: provider.stream.bind(provider) }); } });
  const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: { provider: 'test-v2', model: 'offline-model', permissionMode: 'auto',
    capabilities: v2 ? { policy: 'deterministic-v2', reviewer: 'model-v2' } : {}, pluginConfig: { 'agentlab.policy-deterministic-v2': { writeRoots: ['src'] } } } });
  const events: AgentEvent[] = []; agent.events.onAll(event => events.push(event)); agent.events.on('permission_request', event => { human++; event.resolve({ allow: false }); });
  try {
    expect((await agent.loop.run(`Edit only ${path} as requested`)).reason).toBe('completed');
    return { reviews, human, content: await readFile(join(cwd, path), 'utf8').catch(() => undefined), events };
  } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
}
it('显式 src 写入授权将 legacy 一次模型审批减为零，真实工具结果相同', async () => {
  const legacy = await runFixture(false); const deterministic = await runFixture(true);
  expect(legacy.reviews).toBe(1); expect(deterministic.reviews).toBe(0);
  expect(deterministic.human).toBe(0); expect(deterministic.content).toBe('new content'); expect(legacy.content).toBe(deterministic.content);
  expect(deterministic.events.some(event => event.type === 'permission_decision' && event.decision.kind === 'allow' && event.decision.reasonCode?.includes('write'))).toBe(true);
});
it('写入授权不覆盖敏感目标，未命中范围只可保守进入 reviewer/人工确认', async () => {
  const protectedTarget = await runFixture(true, 'src/.env', false);
  expect(protectedTarget.reviews).toBe(0); expect(protectedTarget.human).toBe(1); expect(protectedTarget.content).toBeUndefined();
  const ungranted = await runFixture(true, 'outside.txt', false);
  expect(ungranted.reviews).toBe(1); expect(ungranted.human).toBe(1); expect(ungranted.content).toBeUndefined();
  const request = ungranted.events.find(event => event.type === 'model_request' && event.purpose === 'judge');
  const usage = ungranted.events.find(event => event.type === 'model_usage' && event.purpose === 'judge');
  expect(request).toMatchObject({ runId: expect.any(String), toolCallId: 'scoped-write', toolRequestId: expect.any(String) });
  expect(usage).toMatchObject({ requestId: request?.type === 'model_request' ? request.requestId : undefined });
});
