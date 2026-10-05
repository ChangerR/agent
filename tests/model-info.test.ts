/**
 * 模型规格联动测试：setModel 时压缩阈值与 maxTokens 应随模型窗口调整。
 */
import { describe, expect, it } from 'vitest';
import { ContextManager } from '../src/core/context/manager.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { AgentLoop } from '../src/core/loop.js';
import { PermissionEngine } from '../src/core/permission/engine.js';
import { ToolRegistry } from '../src/core/registry.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';

function makeLoop(modelInfo?: (model: string) => { contextWindow: number; maxOutputTokens: number } | undefined) {
  const context = new ContextManager({ compactThreshold: 120_000 });
  const provider = new FakeProvider([textResponse('ok')]);
  const loop = new AgentLoop({
    provider,
    model: 'unknown-model',
    tools: new ToolRegistry(),
    permission: new PermissionEngine({ mode: 'yolo', rules: { allow: [], ask: [], deny: [] } }),
    hooks: new HookRunner(),
    events: new EventBus(),
    context,
    systemPrompt: 'test',
    maxTurns: 1,
    cwd: process.cwd(),
    modelInfo,
  });
  return { loop, context, provider };
}

describe('模型规格联动', () => {
  it('小窗口切回大窗口恢复配置上限，切未知模型恢复默认输出预算', async () => {
    const { loop, context, provider } = makeLoop((model) => model === 'small'
      ? { contextWindow: 1000, maxOutputTokens: 128 }
      : model === 'big' ? { contextWindow: 200_000, maxOutputTokens: 512 } : undefined);
    loop.setModel('small');
    expect(context.threshold).toBe(800);
    loop.setModel('big');
    expect(context.threshold).toBe(120_000);
    loop.setModel('unknown');
    expect(context.threshold).toBe(120_000);
    await loop.run('hi');
    expect(provider.requests[0].maxTokens).toBeUndefined();
  });

  it('未知模型：阈值保持配置值', async () => {
    const { loop, context, provider } = makeLoop(() => undefined);
    loop.setModel('some-new-model');
    expect(context.threshold).toBe(120_000);
    await loop.run('hi');
    expect(provider.requests[0].maxTokens).toBeUndefined();
  });

  it('已知小窗口模型：阈值压到窗口的 80%，maxTokens 用模型上限', async () => {
    const { loop, context, provider } = makeLoop((m) =>
      m === 'deepseek-chat' ? { contextWindow: 65_536, maxOutputTokens: 8192 } : undefined,
    );
    loop.setModel('deepseek-chat');
    expect(context.threshold).toBe(Math.floor(65_536 * 0.8));
    await loop.run('hi');
    expect(provider.requests[0].maxTokens).toBe(8192);
  });

  it('已知大窗口模型：配置值更小时不放大阈值', () => {
    const { loop, context } = makeLoop((m) =>
      m === 'claude-sonnet-4-5' ? { contextWindow: 200_000, maxOutputTokens: 64_000 } : undefined,
    );
    loop.setModel('claude-sonnet-4-5');
    expect(context.threshold).toBe(120_000); // 200k*0.8=160k > 配置的 120k，保持 120k
  });
});
