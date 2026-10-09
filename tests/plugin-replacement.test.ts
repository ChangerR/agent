import { SummaryCompactor } from '../src/builtin/compaction-summary/implementation.js';
import { mkdtempProject } from './helpers/project.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgent } from '../src/index.js';
import type { AgentEvent } from '../src/core/events.js';
import { EventBus } from '../src/core/events.js';
import { AgentLoop } from '../src/core/loop.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry } from '../src/core/registry.js';
import { ContextManager } from '../src/core/context/coordinator.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import { definePlugin, type Policy } from '../src/sdk/index.js';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await mkdtempProject(join(tmpdir(), 'agent-plugin-replacement-')); dirs.push(dir); return dir; }
const example = resolve('plugins/architecture-example/plugin.mjs');
describe('只改配置即可替换默认能力', () => {
  it('从独立 ESM 入口替换策略/noop/store，并贡献工具、命令、设置和上下文', async () => {
    const cwd = await directory();
    await fs.writeFile(join(cwd, 'agent.config.json'), JSON.stringify({ provider: 'architecture-demo', model: 'architecture-demo', compactThreshold: 1, pluginEntries: [example], capabilities: { policy: 'example-policy', reviewer: false, compactor: 'example-noop', sessionStore: 'example-memory' }, pluginConfig: { 'example.replace-capabilities': { prefix: 'configured' } } }));
    const agent = await createAgent(cwd, { autoSaveSessions: false });
    try {
      expect(agent.plugins.selected('policy')?.id).toBe('example-policy');
      const events: AgentEvent[] = []; const off = agent.events.onAll(event => events.push(event));
      const run = await agent.loop.run('Run the example');
      expect(run.reason).toBe('completed');
      expect(events.find(event => event.type === 'tool_result')).toMatchObject({ result: { content: 'configured: model invocation' } });
      expect(events.some(event => event.type === 'compacted')).toBe(false);
      const command = await agent.dispatchCommand('/example-echo command invocation');
      expect(command).toEqual({ type: 'text', text: 'configured: command invocation' });
      const denied = await agent.dispatchCommand('/example blocked');
      expect(denied).toMatchObject({ type: 'text' });
      const state = await agent.settings.find(record => record.id === 'example-state')!.section.read!(new AbortController().signal) as { compactions: number; decisions: number; tools: number };
      expect(state.compactions).toBeGreaterThan(0); expect(state.decisions).toBe(3); expect(state.tools).toBe(2);
      const saved = await agent.session.save(); expect(saved?.path.startsWith('memory:')).toBe(true);
      expect(await fs.stat(agent.paths.sessionsDir).then(() => true, () => false)).toBe(false);
      await agent.session.resume(agent.session.id);
      expect((await agent.session.list()).sessions).toHaveLength(1);
      off();
    } finally { await agent.dispose(); }
  });
  it('插件装配与直接构造使用同一策略时，规范化事件轨迹保持一致', async () => {
    const cwd = await directory();
    const script = () => [toolUseResponse([{ id: 'trace-tool', name: 'trace_read', input: { message: 'read' } }]), textResponse('done')];
    const tool = { name: 'trace_read', description: 'trace tool', risk: 'read' as const, inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, async execute() { return { content: 'read result' }; } };
    const events = new EventBus(); const tools = new ToolRegistry(); tools.register(tool);
    const policy: Policy = { decide: () => ({ kind: 'allow', source: 'config', reason: 'isolated test policy' }) };
    const baseline = new AgentLoop({ cwd, provider: new FakeProvider(script()), model: 'fake', tools, policy, events, hooks: new HookRunner(), context: new ContextManager({ compactor: new SummaryCompactor(), compactThreshold: 100000 }), systemPrompt: '', maxTurns: 5 });
    const directTrace: unknown[] = []; events.onAll(event => { const value = normalized(event); if (value) directTrace.push(value); });
    try { await baseline.run('hello'); } finally { await baseline.dispose(); }
    const provider = new FakeProvider(script());
    const plugin = definePlugin({ manifest: { id: 'test.trace-provider', version: '1.0.0', apiVersion: 1 }, setup(ctx) { ctx.provide.provider('trace-provider', { name: 'trace-provider', capabilities: provider.capabilities, stream: provider.stream.bind(provider) }); ctx.provide.tool('trace_read', tool); ctx.provide.policy('trace-policy', policy); } });
    const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: { provider: 'trace-provider', model: 'fake', permissionMode: 'auto', capabilities: { policy: 'trace-policy', reviewer: false } } });
    try {
      const pluginTrace: unknown[] = []; agent.events.onAll(event => { const value = normalized(event); if (value) pluginTrace.push(value); });
      await agent.loop.run('hello'); expect(pluginTrace).toEqual(directTrace);
    } finally { await agent.dispose(); }
  });
});
function normalized(event: AgentEvent): unknown {
  switch (event.type) {
    case 'model_usage': return { type: event.type, purpose: event.purpose, usage: event.usage };
    case 'text_delta': return event;
    case 'assistant_message': return event;
    case 'tool_call': return event;
    case 'tool_result': return event;
    case 'permission_decision': return { type: event.type, toolName: event.toolName, phase: event.phase, decision: { kind: event.decision.kind, source: event.decision.source } };
    case 'turn_end': return event;
    case 'loop_end': return { type: event.type, reason: event.reason, turns: event.turns, usage: event.usage };
    default: return undefined;
  }
}
