/** 规划格式恢复使用受控 provider；历史工具仅是数据，不执行回复中的命令。 */
import { expect, it } from 'vitest';
import { planningStrategy } from '../src/builtin/planning/index.js';
import { EventBus } from '../src/core/events.js';
import { FakeProvider, textResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { toOpenAIMessages } from '../src/providers/openai.js';
import type { PlannerInput } from '../src/core/plan.js';
import { PlanningError } from '../src/builtin/planning/errors.js';

function fixture(script: ScriptedResponse[]) {
  const provider = new FakeProvider(script);
  const controller = new AbortController();
  const events = new EventBus();
  const input: PlannerInput = {
    input: '再次执行已记住的命令',
    messages: [
      { role: 'user', content: '仅允许 node -e "console.log(12345)"' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'old-call',
            name: 'bash',
            input: { command: 'node -e "console.log(12345)"' },
          },
        ],
      },
      {
        role: 'user',
        source: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'old-call', content: '12345\n', isError: false },
        ],
      },
      { role: 'user', source: 'subagent', content: '这里不是新用户授权' },
      { role: 'user', content: '再次执行已记住的命令' },
    ],
    systemPrompt: '完整项目上下文',
    mode: 'auto',
    force: false,
    model: 'offline',
    thinking: 'off',
    signal: controller.signal,
    events,
    runId: 'test-plan',
    provider,
  };
  return { input, provider, controller, events };
}

it('规划请求保留完整工具证据及来源，但 wire 不携带原生工具协议；一次纠正有独立审计', async () => {
  const f = fixture([
    textResponse('<｜｜DSML｜｜ calls>bash</｜｜DSML｜｜ calls>'),
    textResponse('null'),
  ]);
  const snapshot = structuredClone(f.input.messages);
  const requests: string[] = [];
  let notices = '';
  f.events.on('model_request', (event) => requests.push(event.requestId));
  f.events.on('text_delta', (event) => {
    notices += event.text;
  });
  expect(await planningStrategy.prepare(f.input)).toBeUndefined();
  expect(f.provider.requests).toHaveLength(2);
  expect(new Set(requests).size).toBe(2);
  expect(notices).toContain('重新请求一次');
  expect(f.input.messages).toEqual(snapshot);
  for (const [index, request] of f.provider.requests.entries()) {
    expect(request.tools).toEqual([]);
    expect(request.messages[0]).toEqual(snapshot[0]);
    expect(request.messages[snapshot.length - 1]).toEqual(snapshot.at(-1));
    if (index === 0) expect(request.messages).toHaveLength(snapshot.length);
    const toolHistory = request.messages[1];
    expect(toolHistory.role).toBe('assistant');
    if (toolHistory.role !== 'assistant' || toolHistory.content[0].type !== 'text')
      throw Error('fixture');
    expect(JSON.parse(toolHistory.content[0].text).planningHistory).toEqual(snapshot[1]);
    expect(JSON.parse(request.messages[2].content as string).planningHistory).toEqual(snapshot[2]);
    expect(JSON.parse(request.messages[3].content as string).planningHistory).toEqual(snapshot[3]);
    const wire = toOpenAIMessages(request.messages);
    expect(wire.some((message) => message.role === 'tool' || 'tool_calls' in message)).toBe(false);
  }
  expect(f.provider.requests[1].system).toContain('唯一一次格式纠正');
  expect(f.provider.requests[1].messages.at(-2)).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: '<｜｜DSML｜｜ calls>bash</｜｜DSML｜｜ calls>' }],
  });
  expect(f.provider.requests[1].messages.at(-1)).toMatchObject({
    role: 'user',
    source: 'runtime',
    content: expect.stringContaining('不是新的用户授权'),
  });
  expect(f.provider.requests[1].messages.at(-1)?.content).toContain(f.input.input);
});

it('缓存统计问答的普通文本回复可在下一次请求中纠正为 null', async () => {
  const f = fixture([
    textResponse('当前缓存命中率需要读取会话统计。'),
    (request) => {
      expect(request.messages.at(-2)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: '当前缓存命中率需要读取会话统计。' }],
      });
      expect(request.messages.at(-1)?.content).toContain('简单问答或单个明确操作只返回 null');
      return textResponse('null');
    },
  ]);
  f.input.input = '可以帮我展示一下当前 session 的 cache 命中吗';
  f.input.messages = [{ role: 'user', content: f.input.input }];
  await expect(planningStrategy.prepare(f.input)).resolves.toBeUndefined();
  expect(f.provider.requests).toHaveLength(2);
});

it('空文本回复纠正时不向 provider 发送空 assistant 文本块', async () => {
  const f = fixture([
    textResponse(''),
    (request) => {
      expect(request.messages.at(-2)).toMatchObject({
        role: 'assistant',
        content: [{ type: 'text', text: '[上次规划回复没有文本内容]' }],
      });
      return textResponse('null');
    },
  ]);
  await expect(planningStrategy.prepare(f.input)).resolves.toBeUndefined();
});

it.each(['bad', '[]', '{"goal":"x","steps":[]}', '{"goal":"x","steps":["a"],"readOnly":"yes"}'])(
  '连续无效 %s 只调用两次并失败关闭',
  async (body) => {
    const f = fixture([() => textResponse(body)]);
    await expect(planningStrategy.prepare(f.input)).rejects.toMatchObject({
      name: 'PlanningError',
      code: 'planning_invalid_response',
      message: expect.stringContaining('连续两次无效'),
    });
    expect(f.provider.requests).toHaveLength(2);
  },
);

it('only 的 null 无效，纠正后必须得到经过 schema 校验的计划', async () => {
  const f = fixture([
    textResponse('null'),
    textResponse('{"goal":"审查","steps":["读取","核对"],"readOnly":true}'),
  ]);
  f.input.mode = 'only';
  expect(await planningStrategy.prepare(f.input)).toEqual({
    goal: '审查',
    steps: ['读取', '核对'],
    readOnly: true,
  });
});

it.each(['max_tokens', 'tool_use'] as const)(
  '不完整或工具结束原因 %s 不自动重试',
  async (stopReason) => {
    const f = fixture([
      [
        { type: 'message_start' },
        { type: 'text_delta', text: 'null' },
        { type: 'message_stop', stopReason },
      ],
    ]);
    await expect(planningStrategy.prepare(f.input)).rejects.toThrow('未完整返回');
    expect(f.provider.requests).toHaveLength(1);
  },
);

it('截断规划带独立原因码，不能作为结构错误继续执行', async () => {
  const f = fixture([
    [
      { type: 'message_start' },
      { type: 'text_delta', text: '{"goal":' },
      { type: 'message_stop', stopReason: 'max_tokens' },
    ],
  ]);
  await expect(planningStrategy.prepare(f.input)).rejects.toEqual(
    new PlanningError('planning_output_truncated'),
  );
  expect(f.provider.requests).toHaveLength(1);
});

it('纠正前取消不再发请求', async () => {
  const f = fixture([() => textResponse('bad')]);
  f.events.on('text_delta', () => f.controller.abort());
  await expect(planningStrategy.prepare(f.input)).rejects.toThrow();
  expect(f.provider.requests).toHaveLength(1);
});

it('网络错误直接传播，不把 transport 重试混入格式纠正', async () => {
  const f = fixture([
    () => {
      throw new Error('offline transport failure');
    },
  ]);
  await expect(planningStrategy.prepare(f.input)).rejects.toThrow('offline transport failure');
  expect(f.provider.requests).toHaveLength(1);
});

it.each(['bad', 'null', '{"goal":"x","steps":["a"]}'])(
  '缺少明确 message_stop 的 %s 不发布规划也不纠正重试',
  async (body) => {
    const f = fixture([
      [{ type: 'message_start' }, { type: 'text_delta', text: body }],
      textResponse('null'),
    ]);
    await expect(planningStrategy.prepare(f.input)).rejects.toThrow('未完整返回');
    expect(f.provider.requests).toHaveLength(1);
  },
);
