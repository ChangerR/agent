/** 真实 OpenAI adapter + ModelReviewer，仅 SDK transport 离线；不加载凭据、不发网络。 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIProvider } from '../src/providers/openai.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/model.js';
import { ReviewHistory } from '../src/builtin/reviewer-model/review-context.js';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { bashTool } from '../src/tools/bash.js';
import type { ReviewInput } from '../src/sdk/index.js';
import type { ChatRequest } from '../src/core/provider.js';
import { EventBus } from '../src/core/events.js';
const transport = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  content: '{"decision":"allow","reasonCode":"authorized","reason":"incomplete',
  finish: 'length',
  tokens: 512,
}));
vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          transport.calls.push(params);
          return (async function* () {
            yield {
              id: 'offline',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'deepseek-flash',
              choices: [{ index: 0, delta: { content: transport.content }, finish_reason: null }],
            };
            yield {
              id: 'offline',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'deepseek-flash',
              choices: [{ index: 0, delta: {}, finish_reason: transport.finish }],
              usage: {
                prompt_tokens: 100,
                completion_tokens: transport.tokens,
                total_tokens: 100 + transport.tokens,
              },
            };
          })();
        },
      },
    };
  },
}));
const roots: string[] = [];
afterEach(async () => {
  transport.calls.length = 0;
  transport.content = '{"decision":"allow","reasonCode":"authorized","reason":"incomplete';
  transport.finish = 'length';
  transport.tokens = 512;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const provider = () =>
  new OpenAIProvider({ apiKey: 'offline-fixture', baseURL: 'https://offline.invalid' });
const input: ReviewInput = {
  tool: { name: 'write_file', description: 'write', risk: 'write', inputSchema: {} },
  input: { path: 'result.txt', content: 'fixture' },
  cwd: '/fixture',
  userRequest: '创建 result.txt。',
  decision: { kind: 'review', source: 'mode', reason: 'review' },
};
it.each([undefined, 512])(
  'maxOutputTokens=%s：相同 length/512 用量和不完整 JSON 均失败关闭',
  async (maxOutputTokens) => {
    const result = await createModelReviewer({
      provider: provider(),
      model: 'deepseek-flash',
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    }).review(input, new AbortController().signal);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].max_tokens).toBe(maxOutputTokens ?? 8192);
    expect(result).toMatchObject({ decision: 'unknown', reasonCode: 'incomplete_response' });
  },
);
it('生产默认 8192 能接收超过故障注入512用量的完整回复，不假设服务器必然截断', async () => {
  transport.content = JSON.stringify({
    decision: 'allow',
    reasonCode: 'authorized',
    reason: '完整离线依据。'.repeat(80),
  });
  transport.finish = 'stop';
  transport.tokens = 700;
  expect(
    await createModelReviewer({ provider: provider(), model: 'deepseek-flash' }).review(
      input,
      new AbortController().signal,
    ),
  ).toMatchObject({ decision: 'allow' });
  expect(transport.calls[0].max_tokens).toBe(8192);
});
it('220路径与规划历史在512和生产8192预算下均完整发送，仅maxTokens数字占用差一字节', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'review-default-'));
  roots.push(cwd);
  await mkdir(join(cwd, 'src'));
  for (let i = 0; i < 220; i++) await writeFile(join(cwd, 'src', `module-${i}.ts`), 'export {};\n');
  const tool = { ...bashTool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' };
  // cat -n 不属于新增的纯内容串联子集，继续由真实 reviewer 审查。
  const args = {
    command: "find src -type f -name '*.ts' -print0 | xargs -0 cat -n 2>/dev/null | wc -l",
  };
  const policy = createDeterministicPolicy({
    cwd,
    mode: 'auto',
    rules: { allow: [], ask: [], deny: [] },
  });
  const analysis = await policy.analyzer!.analyze(
    { tool, input: args, cwd },
    new AbortController().signal,
  );
  const userRequest = '只统计项目内容，禁止修改、联网或读取凭据。';
  const context = new ReviewHistory().build(
    tool,
    args,
    cwd,
    userRequest,
    Array.from({ length: 5 }, (_, i) => ({
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: `plan-${i}`, content: '只读规划依据。'.repeat(100) },
      ],
    })),
  );
  const requests: ChatRequest[] = [];
  const events = new EventBus();
  events.on('model_request', (e) => requests.push(e.request));
  for (const maxOutputTokens of [512, undefined])
    await createModelReviewer({
      provider: provider(),
      model: 'deepseek-flash',
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    }).review(
      {
        tool,
        input: args,
        cwd,
        analysis,
        userRequest,
        context,
        decision: { kind: 'review', source: 'mode', reason: 'unknown' },
        events,
      },
      new AbortController().signal,
    );
  expect(requests).toHaveLength(2);
  expect(requests[1].maxTokens).toBe(8192);
  expect(requests[1].messages).toEqual(requests[0].messages);
  const sizes = requests.map((r) => Buffer.byteLength(JSON.stringify(r)));
  expect(sizes[1] - sizes[0]).toBe(1);
  expect(sizes[1]).toBeLessThan(32768);
  expect(JSON.parse(requests[1].messages[0].content as string).currentUserRequest.text).toBe(
    userRequest,
  );
});
