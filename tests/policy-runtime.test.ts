import { mkdtempProject as mkdtemp } from './helpers/project.js';
/** 同一真实 runtime 的模型调用计数；全部 FakeProvider 与临时文件。 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import type { AgentEvent } from '../src/core/events.js';
async function runFixture(scoped: boolean, path = 'src/a.ts', reviewerAllows = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-policy-runtime-')); await mkdir(join(cwd, 'src')); await writeFile(join(cwd, 'src/a.ts'), 'old');
  let reviews = 0; let human = 0;
  const provider = new FakeProvider([request => {
    if (!request.tools.length) {
      reviews++;
      return textResponse(JSON.stringify({ decision: reviewerAllows ? 'allow' : 'ask', reasonCode: 'fixture_review', reason: 'offline fixture' }));
    }
    return typeof request.messages.at(-1)?.content === 'string'
      ? toolUseResponse([{ id: 'scoped-write', name: 'write_file', input: { path, content: 'new content' } }]) : textResponse('done');
  }]);
  const plugin = definePlugin({ manifest: { id: 'test.policy-provider', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.provider('test-policy', { name: 'test-policy', capabilities: provider.capabilities, stream: provider.stream.bind(provider) }); } });
  const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: { provider: 'test-policy', model: 'offline-model', permissionMode: 'auto',
    pluginConfig: { 'agentlab.policy': { writeRoots: scoped ? ['src'] : [] } } } });
  const events: AgentEvent[] = []; agent.events.onAll(event => events.push(event)); agent.events.on('permission_request', event => { human++; event.resolve({ allow: false }); });
  try {
    expect((await agent.loop.run(`Edit only ${path} as requested`)).reason).toBe('completed');
    return { reviews, human, content: await readFile(join(cwd, path), 'utf8').catch(() => undefined), events };
  } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
}
it('显式 src 写入授权省去模型审批，未授权写入仍经审批', async () => {
  const unscoped = await runFixture(false); const deterministic = await runFixture(true);
  expect(unscoped.reviews).toBe(1); expect(deterministic.reviews).toBe(0);
  expect(deterministic.human).toBe(0); expect(deterministic.content).toBe('new content'); expect(unscoped.content).toBe(deterministic.content);
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

it('默认策略识别 runtime 装配的内置文件工具，auto 安全读取不询问', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-policy-read-'));
  await writeFile(join(cwd, 'ordinary.txt'), 'verified read');
  const agent = await createAgent(cwd, { autoSaveSessions: false, config: { provider: 'fake', permissionMode: 'auto' } });
  let requests = 0;
  agent.events.on('permission_request', event => { requests++; event.resolve({ allow: false }); });
  try {
    expect(agent.plugins.selected('policy')?.id).toBe('deterministic');
    expect(agent.plugins.selected('reviewer')?.id).toBe('model');
    expect(agent.tools.get('read_file')).toMatchObject({ ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
    const result = await agent.invokeTool('read_file', { path: 'ordinary.txt' }, new AbortController().signal);
    expect(result.isError).toBeUndefined(); expect(result.content).toContain('verified read'); expect(requests).toBe(0);
    expect(agent.permission.getAuditLog().some(entry => entry.decision.reasonCode === 'safe_read')).toBe(true);
  } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
