import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopController } from '../desktop/worker/controller.js';
import { createAgent, type Agent } from '../src/index.js';
import { definePlugin } from '../src/sdk/index.js';
import { FakeProvider, textResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { actionSchema, type RuntimeSnapshot } from '../desktop/shared/protocol.js';

describe('桌面宿主与真实 runtime 的离线边界', () => {
  let cwd: string, controller: DesktopController, states: RuntimeSnapshot[];
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'agentlab-desktop-'));
    await writeFile(join(cwd, 'README.md'), '# Desktop test\n');
    states = [];
    controller = new DesktopController((state) => states.push(state));
    await controller.initialize(cwd, true, randomUUID());
  });
  afterEach(async () => {
    await controller.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const latest = () => states.at(-1)!;
  const send = (payload: Record<string, unknown>) =>
    controller.handle({
      ...payload,
      generation: latest().generation,
      sessionId: latest().sessionId,
    });
  const start = () => send({ type: 'submit', text: '离线工具演示', invocationId: randomUUID() });
  const approval = async () => {
    await vi.waitFor(() =>
      expect(
        latest().approvals,
        JSON.stringify({ phase: latest().phase, error: latest().error, rows: latest().rows }),
      ).toHaveLength(1),
    );
    return latest().approvals[0];
  };
  const settled = () => vi.waitFor(() => expect(latest().busy).toBe(false));

  it('只传纯 DTO；用户批准后才写文件，并等待持久化结算', async () => {
    await start();
    const request = await approval();
    await expect(access(join(cwd, 'demo-note.txt'))).rejects.toThrow();
    expect(latest().busy).toBe(true);
    expect(JSON.stringify(latest())).not.toContain('test-only-never-sent');
    expect(JSON.parse(JSON.stringify(latest()))).toEqual(latest());
    await send({ type: 'approve', approvalId: request.id, allow: true });
    await settled();
    expect(await readFile(join(cwd, 'demo-note.txt'), 'utf8')).toContain('真实 ToolExecutor');
    expect(latest().sessions.some((s) => s.id === latest().sessionId)).toBe(true);
    expect(latest().approvals).toHaveLength(0);
    expect(
      latest()
        .rows.filter((r) => r.kind === 'tool')
        .every((r) => r.status === 'completed'),
    ).toBe(true);
    for (let i = 1; i < states.length; i++)
      expect(states[i].seq).toBeGreaterThan(states[i - 1].seq);
  });

  it('取消撤销审批，迟到批准不能写入', async () => {
    await start();
    const request = await approval();
    await send({ type: 'stop' });
    await settled();
    expect(latest().approvals).toHaveLength(0);
    await expect(send({ type: 'approve', approvalId: request.id, allow: true })).rejects.toThrow(
      '审批已结束',
    );
    await expect(access(join(cwd, 'demo-note.txt'))).rejects.toThrow();
  });

  it('其他会话或 generation 不能批准本次请求', async () => {
    await start();
    const request = await approval();
    await expect(
      controller.handle({
        type: 'approve',
        generation: randomUUID(),
        sessionId: latest().sessionId,
        approvalId: request.id,
        allow: true,
      }),
    ).rejects.toThrow('会话已变化');
    await expect(
      controller.handle({
        type: 'approve',
        generation: latest().generation,
        sessionId: 'other-session',
        approvalId: request.id,
        allow: true,
      }),
    ).rejects.toThrow('会话已变化');
    expect(latest().approvals[0].id).toBe(request.id);
    await send({ type: 'approve', approvalId: request.id, allow: false, feedback: '不要创建文件' });
    await settled();
    await expect(access(join(cwd, 'demo-note.txt'))).rejects.toThrow();
  });

  it('重入和重复提交不会重复运行工具', async () => {
    const invocationId = randomUUID();
    await send({ type: 'submit', text: '演示', invocationId });
    const request = await approval();
    await expect(
      send({ type: 'submit', text: '重入', invocationId: randomUUID() }),
    ).rejects.toThrow('尚未结算');
    await send({ type: 'approve', approvalId: request.id, allow: false });
    await settled();
    await expect(send({ type: 'submit', text: '演示', invocationId })).rejects.toThrow('已提交');
  });

  it('模型设置沿用原子配置提交并保留未知字段', async () => {
    await writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ custom: { keep: true } }));
    await send({ type: 'setting', field: 'model', value: 'fake-desktop-custom' });
    await settled();
    expect(latest().error).toBeUndefined();
    expect(latest().model).toBe('fake-desktop-custom');
    expect(latest().models).toContain('fake-desktop-custom');
    expect(JSON.parse(await readFile(join(cwd, 'agent.config.json'), 'utf8'))).toMatchObject({
      model: 'fake-desktop-custom',
      custom: { keep: true },
    });
  });

  it('命令交互可取消，停止不遗留 Promise', async () => {
    await send({ type: 'submit', text: '/model', invocationId: randomUUID() });
    await vi.waitFor(() => expect(latest().interaction).toBeDefined());
    await send({ type: 'stop' });
    await settled();
    expect(latest().interaction).toBeUndefined();
  });

  it('恢复失败保留原会话与历史；成功恢复不重放工具', async () => {
    await start();
    const request = await approval();
    await send({ type: 'approve', approvalId: request.id, allow: false });
    await settled();
    const id = latest().sessionId,
      rows = latest().rows;
    await send({ type: 'resume', id: 'missing-session' });
    await settled();
    expect(latest().sessionId).toBe(id);
    expect(latest().rows).toEqual(rows);
    expect(latest().error).toBeDefined();
    await send({ type: 'resume', id });
    await settled();
    expect(latest().error).toBeUndefined();
    expect(latest().rows.some((r) => r.kind === 'tool')).toBe(true);
    await expect(access(join(cwd, 'demo-note.txt'))).rejects.toThrow();
  });

  it('关闭未决审批时真实结算，共享同一次 dispose', async () => {
    await start();
    await approval();
    const first = controller.dispose();
    const second = controller.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await expect(access(join(cwd, 'demo-note.txt'))).rejects.toThrow();
    await expect(send({ type: 'stop' })).rejects.toThrow('运行时不可用');
  });

  it('保存结算失败时不显示成功，也不将原始异常带给前端', async () => {
    await controller.dispose();
    controller = new DesktopController(
      (state) => states.push(state),
      async (path, options) => {
        const agent = await createAgent(path, options);
        agent.loop.onRunSettled(async () => {
          throw new Error('test-private-value-never-display');
        });
        return agent;
      },
    );
    await controller.initialize(cwd, true, randomUUID());
    await start();
    const request = await approval();
    await send({ type: 'approve', approvalId: request.id, allow: true });
    await settled();
    expect(latest().phase).toBe('操作失败');
    expect(latest().error).toBeDefined();
    expect(JSON.stringify(latest())).not.toContain('test-private-value-never-display');
  });

  it.each([
    {
      responses: [textResponse('bad'), textResponse('still bad')],
      message: '规划结构连续两次无效',
    },
    {
      responses: [[{ type: 'message_start' }, { type: 'text_delta', text: 'null' }]],
      message: '规划未完整返回',
    },
    {
      responses: [[{ type: 'message_stop', stopReason: 'max_tokens' }]],
      message: '达到输出上限',
    },
  ] satisfies Array<{ responses: ScriptedResponse[]; message: string }>)(
    '规划失败显示具体原因 $message；结算后同一会话可继续',
    async ({ responses, message }) => {
      await controller.dispose();
      let logPath = '';
      const provider = new FakeProvider([
        ...responses,
        textResponse('null'),
        textResponse('恢复后正常回答'),
      ]);
      controller = new DesktopController(
        (state) => states.push(state),
        async (path, options) => {
          const agent = await createAgent(path, {
            ...options,
            config: {
              ...options?.config,
              provider: 'offline-planning',
              pluginConfig: { 'agentlab.planning': { mode: 'auto' } },
            },
            plugins: [
              ...(options?.plugins ?? []),
              definePlugin({
                manifest: { id: 'test.desktop-planning', version: '1.0.0', apiVersion: 1 },
                setup(ctx) {
                  ctx.provide.provider('offline-planning', {
                    name: 'offline-planning',
                    capabilities: provider.capabilities,
                    stream: provider.stream.bind(provider),
                  });
                },
              }),
            ],
          });
          logPath = agent.logPath;
          return agent;
        },
      );
      await controller.initialize(cwd, true, randomUUID());
      const sessionId = latest().sessionId;
      await send({ type: 'submit', text: '查看缓存命中', invocationId: randomUUID() });
      await settled();
      expect(latest().phase).toBe('操作失败');
      expect(latest().error).toContain(message);
      expect(latest().error).not.toContain('检查配置与连接');
      expect(latest().rows.some((row) => row.kind === 'tool')).toBe(false);
      expect(latest().sessions.some((session) => session.id === sessionId)).toBe(true);
      expect(provider.requests).toHaveLength(responses.length);
      expect(await readFile(logPath, 'utf8')).toContain('"errorCode":"planning_');
      await send({ type: 'submit', text: '再试一次', invocationId: randomUUID() });
      await settled();
      expect(latest().sessionId).toBe(sessionId);
      expect(latest().phase).toBe('就绪');
      expect(latest().error).toBeUndefined();
      expect(latest().rows.some((row) => row.text === '恢复后正常回答')).toBe(true);
    },
  );

  it('/stats 直接读取会话统计，无模型请求和前端交互；缓存写入不计入命中分母', async () => {
    await controller.dispose();
    let agent!: Agent;
    controller = new DesktopController(
      (state) => states.push(state),
      async (path, options) => {
        agent = await createAgent(path, options);
        return agent;
      },
    );
    await controller.initialize(cwd, true, randomUUID());
    const run = vi.spyOn(agent.loop, 'run');
    await send({ type: 'submit', text: '/stats', invocationId: randomUUID() });
    await settled();
    expect(latest().rows.at(-1)?.text).toContain('暂无输入用量');
    agent.events.emit({
      type: 'model_usage',
      requestId: randomUUID(),
      purpose: 'agent',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 70 },
    });
    await send({ type: 'submit', text: '/stats', invocationId: randomUUID() });
    await settled();
    expect(latest().error).toBeUndefined();
    expect(latest().interaction).toBeUndefined();
    expect(latest().rows.at(-1)?.text).toContain('缓存命中率：75.0%');
    expect(latest().rows.at(-1)?.text).toContain('缓存写入：70 tokens');
    expect(run).not.toHaveBeenCalled();
  });

  it('协议拒绝额外字段与非法审批内容', () => {
    const binding = { generation: latest().generation, sessionId: latest().sessionId };
    expect(() =>
      actionSchema.parse({
        type: 'approve',
        ...binding,
        approvalId: randomUUID(),
        allow: true,
        remember: 'project',
      }),
    ).toThrow();
    expect(() =>
      actionSchema.parse({ type: 'submit', ...binding, invocationId: randomUUID(), text: ' ' }),
    ).toThrow();
  });
});
