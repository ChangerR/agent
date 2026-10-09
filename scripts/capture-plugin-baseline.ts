/** 固定源码目录执行离线兼容场景；用于生成/核对迁移前的真实事件与历史基线。 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
export async function capturePluginBaseline(root: string) {
  const module = (path: string) => import(pathToFileURL(resolve(root, 'src', path)).href);
  const [{ AgentLoop }, { EventBus }, { HookRunner }, { ToolRegistry }, { PermissionEngine }, { AutoJudge }, { ContextManager }, { FakeProvider, textResponse, toolUseResponse }] = await Promise.all([
    module('core/loop.ts'), module('core/events.ts'), module('core/hooks.ts'), module('core/registry.ts'), module('core/permission/engine.ts'), module('core/permission/judge.ts'), module('core/context/manager.ts'), module('providers/fake.ts'),
  ]);
  const results = [];
  for (const scenario of ['read', 'deny', 'ask-allow', 'ask-deny', 'review', 'rewrite'] as const) {
    const events = new EventBus(); const hooks = new HookRunner(); const tools = new ToolRegistry();
    const trace: unknown[] = []; let executions = 0;
    tools.register({ name: 'fixture_tool', description: 'deterministic fixture', risk: scenario === 'read' ? 'read' : 'write', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      execute: async (input: { value: string }) => { executions++; return { content: `result:${input.value}` }; } });
    if (scenario === 'rewrite') hooks.register('PreToolUse', () => ({ input: { value: 'rewritten' } }));
    const permission = new PermissionEngine({ mode: 'auto', rules: { allow: [], ask: scenario.startsWith('ask') ? ['fixture_tool'] : [], deny: scenario === 'deny' ? ['fixture_tool'] : [] } });
    const reviewer = new FakeProvider([textResponse('{"verdict":"allow","reason":"fixture"}')]);
    const types = ['model_usage', 'text_delta', 'assistant_message', 'tool_call', 'tool_result', 'permission_decision', 'permission_request', 'turn_end', 'loop_end'];
    for (const type of types) events.on(type, (event: Record<string, any>) => {
      if (type === 'permission_request') { trace.push({ type, toolName: event.request.toolName, input: event.request.input, source: event.request.decisionSource }); event.resolve({ allow: scenario !== 'ask-deny' }); return; }
      if (type === 'model_usage') { trace.push({ type, purpose: event.purpose, usage: event.usage }); return; }
      if (type === 'permission_decision') { trace.push({ type, phase: event.phase, input: event.input, decision: { kind: event.decision.kind, source: event.decision.source } }); return; }
      if (type === 'loop_end') { trace.push({ type, reason: event.reason, turns: event.turns, usage: event.usage }); return; }
      trace.push(event);
    });
    const loop = new AgentLoop({ provider: new FakeProvider([toolUseResponse([{ id: 'fixture-1', name: 'fixture_tool', input: { value: 'original' } }]), textResponse('complete')]), model: 'fixture', tools, permission, hooks, events, context: new ContextManager({ compactThreshold: 100000 }), systemPrompt: 'fixture', maxTurns: 5, cwd: '/offline-fixture', autoJudge: new AutoJudge(reviewer, 'review-fixture') });
    const run = await loop.run('Perform the fixture operation');
    results.push({ scenario, trace, messages: loop.getMessages(), executions, reviewerCalls: reviewer.requests.length, run });
    await loop.dispose();
  }
  return JSON.parse(JSON.stringify(results));
}
if (process.argv[1]?.endsWith('capture-plugin-baseline.ts')) {
  const result = await capturePluginBaseline(process.argv[2] ?? process.cwd());
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n');
  else console.log(JSON.stringify(result, null, 2));
}
