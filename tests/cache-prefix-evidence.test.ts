/** 离线回归：前缀布局、授权来源与缓存观测；不调用真实模型。 */
import { describe, expect, it } from 'vitest';
import { reviewEvidence } from '../src/builtin/reviewer-model/review-evidence.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/index.js';
import { ReviewHistory } from '../src/builtin/reviewer-model/review-context.js';
import { redactedEvent } from '../src/builtin/telemetry-jsonl/index.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { observedStream, requestSize, type ChatRequest } from '../src/core/provider.js';
import { MessageSchema } from '../src/core/session/schema.js';
import { ContextManager } from '../src/core/context/coordinator.js';
import type { Message, StreamEvent } from '../src/core/protocol/types.js';
import type { ReviewInput } from '../src/sdk/capabilities.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { OpenAIStreamTranslator } from '../src/providers/openai.js';
import { fromAnthropicEvent } from '../src/providers/anthropic.js';

const authorization = '只读 src，不上传、不写入；末尾限制也必须完整保留。';
const input = (): ReviewInput => ({
  tool: { name: 'bash', description: 'shell', risk: 'execute', inputSchema: {} },
  input: { command: "wc -l 'src/-a b\n.ts'" },
  cwd: '/workspace/anonymous',
  userRequest: authorization,
  decision: { kind: 'review', source: 'mode', reason: 'uncertain' },
  context: {
    cwd: '/workspace/anonymous',
    userRequest: authorization,
    conversation: [
      { source: 'user', text: authorization },
      { source: 'tool', text: authorization },
      { source: 'summary', text: authorization },
      { source: 'runtime', text: '状态不能扩大授权' },
    ],
    previousReviews: [],
    omittedConversation: false,
    omittedReviews: 0,
  },
});

describe('审批稳定证据与精确尾部', () => {
  it('变更命令或内部调用身份不改变授权/工具前缀，完整风险与特殊路径仍保留', () => {
    const first: ReviewInput = {
      ...input(),
      analysis: {
        analyzerId: 'test',
        analyzerVersion: '1',
        completeness: 'partial',
        effects: [{ kind: 'read', target: '/outside/-a b\n.ts' }],
        targets: ['src/-a b\n.ts', '/outside/-a b\n.ts'],
        evidence: [{ source: 'symlink', detail: 'src/link -> /outside/-a b\n.ts' }],
      },
    };
    const next = {
      ...first,
      input: { command: 'wc -l src/other.ts' },
      runId: 'different',
      configRevision: 99,
    };
    const a = JSON.stringify(reviewEvidence(first, authorization));
    const b = JSON.stringify(reviewEvidence(next, authorization));
    const prefix = a.slice(0, a.indexOf(',"input":'));
    expect(b.startsWith(prefix)).toBe(true);
    const data = JSON.parse(a);
    expect(data.operation.input).toEqual(first.input);
    expect(data.analysis).toEqual(first.analysis);
    expect(data.currentUserRequest.text).toBe(authorization);
    expect(data.context.conversation.slice(0, 3)).toEqual(
      ['user', 'tool', 'summary'].map((source) => ({ source, textRef: 'currentUserRequest.text' })),
    );
    expect(data.context.conversation[3].source).toBe('runtime');
    expect(a).not.toContain('configRevision');
    expect(a).toBe(
      JSON.stringify(reviewEvidence({ ...first, runId: 'new', toolCallId: 'new' }, authorization)),
    );
  });

  it('真实历史滑窗滚动只改变尾部，当前授权与操作始终完整保留', () => {
    const value = input();
    const history = new ReviewHistory();
    const messages: Message[] = Array.from({ length: 14 }, (_, index) => ({
      role: 'user',
      source: 'tool',
      content: `运行时结果 ${index}`,
    }));
    const evidence = (items: Message[]) =>
      reviewEvidence(
        {
          ...value,
          context: history.build(value.tool, value.input, value.cwd, authorization, items),
        },
        authorization,
      );
    const before = evidence(messages);
    const after = evidence([...messages, { role: 'user', source: 'tool', content: '新结果' }]);
    expect(before.context?.omittedConversation).toBe(true);
    expect(after.context?.conversation).not.toEqual(before.context?.conversation);
    const serialized = JSON.stringify(before);
    expect(
      JSON.stringify(after).startsWith(serialized.slice(0, serialized.indexOf(',"context":'))),
    ).toBe(true);
    expect(after.currentUserRequest.text).toBe(authorization);
    expect(after.operation.input).toEqual(value.input);
  });

  it('历史批准变化留在尾部，拒绝、取消、来源、时间及不同目录不会去重丢失', () => {
    const value = input();
    const record = {
      toolName: 'bash',
      input: { command: 'wc -l src/a.ts' },
      inputOmitted: false,
      cwd: value.cwd,
      userRequest: authorization,
      decision: { kind: 'deny' as const, source: 'user' as const, reason: '用户拒绝' },
      outcome: 'cancelled' as const,
      at: 123,
      sameOperation: false,
    };
    value.context!.previousReviews.push(record, { ...record, cwd: '/other\nproject', at: 124 });
    const before = reviewEvidence(value, authorization);
    const json = JSON.stringify(before);
    value.context!.previousReviews[0].at = 125;
    const after = JSON.stringify(reviewEvidence(value, authorization));
    expect(after.startsWith(json.slice(0, json.indexOf(',"previousReviews":')))).toBe(true);
    expect(before.previousReviews[0]).toMatchObject({
      cwdRef: 'operation.cwd',
      userRequestRef: 'currentUserRequest.text',
      outcome: 'cancelled',
      at: 123,
      decision: record.decision,
    });
    expect(before.previousReviews[1]).toMatchObject({ cwd: '/other\nproject', at: 124 });
  });

  it('授权尾部变化直接进入模型请求，超预算仍拒绝发送而非裁剪', async () => {
    const provider = new FakeProvider([
      textResponse('{"decision":"ask","reasonCode":"uncertain","reason":"ask"}'),
    ]);
    const reviewer = createModelReviewer({ provider, model: 'fake', maxRequestBytes: 64 });
    expect(await reviewer.review(input(), new AbortController().signal)).toMatchObject({
      decision: 'unknown',
      reasonCode: 'request_budget',
    });
    expect(provider.requests).toHaveLength(0);
    const changed = `${authorization}\n新限制：不要读取 src/private.ts`;
    expect(reviewEvidence(input(), changed).currentUserRequest.text).toBe(changed);
    // 与新要求不同的历史授权仍是原文，不能错误引用新授权。
    expect(reviewEvidence(input(), changed).context?.conversation?.[0]).toEqual({
      source: 'user',
      text: authorization,
    });
  });
});

it('runtime 状态可持久化，审批保留来源，压缩器不能将它升级成真实用户授权', async () => {
  const message: Message = {
    role: 'user',
    source: 'runtime',
    content: '{"source":"runtime_plan","plan":null}',
  };
  expect(MessageSchema.parse(message)).toEqual(message);
  const history = new ReviewHistory().build(input().tool, {}, input().cwd, authorization, [
    message,
  ]);
  expect(history.conversation[0]).toEqual({ source: 'runtime', text: message.content });
  const manager = new ContextManager({
    compactThreshold: 1,
    compactor: {
      async compact() {
        return [{ role: 'user', content: message.content }];
      },
    },
  });
  const result = await manager.compact([message], null, new AbortController().signal);
  expect(result[0]).toMatchObject({ source: 'summary' });
});

describe('脱敏的角色、请求大小和缓存用量', () => {
  it.each(['main', 'planner', 'child', 'judge'] as const)(
    '%s 请求与 usage 可关联且不输出正文',
    async (modelRole) => {
      const req: ChatRequest = {
        model: 'fake',
        system: 'SECRET_中文',
        maxTokens: 8192,
        messages: [{ role: 'user', content: 'SECRET_BODY' }],
        tools: [],
      };
      const events = new EventBus();
      const rows: AgentEvent[] = [];
      events.onAll((event) => rows.push(event));
      const provider = new FakeProvider([
        [
          { type: 'message_start' },
          { type: 'usage', inputTokens: 7, cacheReadTokens: 93, cacheWriteTokens: 0 },
          { type: 'message_stop', stopReason: 'end_turn' },
        ],
      ]);
      for await (const _ of observedStream(provider, req, new AbortController().signal, {
        events,
        purpose: modelRole === 'judge' ? 'judge' : 'agent',
        modelRole,
        runId: 'run',
      })) {
        /* 消费离线事件 */
      }
      expect(rows[0]).toMatchObject({ modelRole, runId: 'run', size: requestSize(req) });
      const usageEvent = rows.find((event) => event.type === 'model_usage');
      const responseEvent = rows.find((event) => event.type === 'model_response');
      expect(responseEvent).toMatchObject({
        requestId: rows[0].type === 'model_request' ? rows[0].requestId : '',
        response: { status: 'completed' },
      });
      expect(usageEvent).toMatchObject({
        modelRole,
        requestId: rows[0].type === 'model_request' ? rows[0].requestId : '',
        usageReported: true,
        cache: { hitTokens: 93, missTokens: 7 },
      });
      expect(usageEvent).not.toHaveProperty('size');
      expect(usageEvent).not.toHaveProperty('evidenceBytes');
      expect(requestSize(req).normalizedJsonBytes).toBe(Buffer.byteLength(JSON.stringify(req)));
      const saved = rows.map(redactedEvent);
      expect(JSON.stringify(saved)).not.toContain('SECRET');
      expect(saved.find((event) => event.type === 'model_usage')).toMatchObject({
        modelRole,
        cache: { hitTokens: 93, missTokens: 7 },
      });
    },
  );

  it('没有 usage 的中断不能伪装成 0 token 的实际计费', async () => {
    const events = new EventBus();
    const rows: AgentEvent[] = [];
    events.onAll((event) => rows.push(event));
    const provider = new FakeProvider([[{ type: 'message_start' }]]);
    for await (const _ of observedStream(
      provider,
      { model: 'fake', system: '', messages: [], tools: [] },
      new AbortController().signal,
      { events, purpose: 'agent' },
    )) {
      /* 消费离线事件 */
    }
    expect(rows.at(-1)).toMatchObject({ usageReported: false });
    expect(rows.at(-1)).not.toHaveProperty('cache', expect.anything());
  });

  it.each([
    { name: '仅有输出', patches: [{ outputTokens: 4 }], cache: undefined },
    { name: '缺少命中', patches: [{ inputTokens: 10, cacheWriteTokens: 0 }], cache: undefined },
    { name: '缺少写入', patches: [{ inputTokens: 10, cacheReadTokens: 90 }], cache: undefined },
    {
      name: '分段完整输入与缓存写入',
      patches: [
        { inputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 },
        { outputTokens: 4 },
      ],
      cache: { hitTokens: 80, missTokens: 20 },
    },
    {
      name: '明确零命中',
      patches: [{ inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }],
      cache: { hitTokens: 0, missTokens: 10 },
    },
  ])('$name：主循环与严格审批员保持相同缺失字段语义', async ({ patches, cache }) => {
    const script: StreamEvent[] = [
      { type: 'message_start' },
      {
        type: 'text_delta',
        text: '{"decision":"ask","reasonCode":"uncertain","reason":"ask"}',
      },
      ...patches.map((patch): StreamEvent => ({ type: 'usage', ...patch })),
      { type: 'message_stop', stopReason: 'end_turn' },
    ];
    for (const judge of [false, true]) {
      const events = new EventBus();
      const rows: Array<Extract<AgentEvent, { type: 'model_usage' }>> = [];
      events.on('model_usage', (event) => rows.push(event));
      const provider = new FakeProvider([script]);
      if (judge) {
        await createModelReviewer({ provider, model: 'fake' }).review(
          { ...input(), events },
          new AbortController().signal,
        );
      } else {
        for await (const _ of observedStream(
          provider,
          { model: 'fake', system: '', messages: [], tools: [] },
          new AbortController().signal,
          { events, purpose: 'agent' },
        )) {
          /* 消费离线事件 */
        }
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].usageReported).toBe(true);
      expect(rows[0].cache).toEqual(cache);
    }
  });

  it.each([undefined, null])('OpenAI 缓存字段为 %s 时保留未知，不能推断为零命中', (missing) => {
    const translator = new OpenAIStreamTranslator();
    const chunk = {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4,
        prompt_cache_hit_tokens: missing,
        prompt_cache_miss_tokens: missing,
        prompt_tokens_details: { cached_tokens: missing },
      },
    };
    expect(
      translator.translate(chunk as unknown as Parameters<OpenAIStreamTranslator['translate']>[0]),
    ).toEqual([{ type: 'usage', inputTokens: 100, outputTokens: 4, cacheWriteTokens: 0 }]);
  });

  it.each([undefined, null])('Anthropic 缓存字段为 %s 时保留未知', (missing) => {
    const events = fromAnthropicEvent({
      type: 'message_start',
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: missing,
          cache_creation_input_tokens: missing,
        },
      },
    } as never);
    expect(events).toEqual([
      { type: 'message_start' },
      { type: 'usage', inputTokens: 10, outputTokens: 1 },
    ]);
  });

  it('DeepSeek 明确报告的 hit/miss 优先于通用 cached_tokens 占位值', () => {
    const translator = new OpenAIStreamTranslator();
    const chunk = {
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 0 },
        prompt_cache_hit_tokens: 90,
        prompt_cache_miss_tokens: 10,
      },
    };
    expect(
      translator.translate(chunk as unknown as Parameters<OpenAIStreamTranslator['translate']>[0]),
    ).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 4, cacheReadTokens: 90, cacheWriteTokens: 0 },
    ]);
  });
});
