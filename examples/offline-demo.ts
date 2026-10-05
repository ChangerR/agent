/**
 * 离线演示：无需 API key，用 fake provider 跑完整 agent loop。
 *
 * 运行：npx tsx examples/offline-demo.ts [工作目录]
 * 工作目录需有 agent.config.json: { "provider": "fake", "permissionMode": "auto" }
 */
import { createAgent } from '../src/index.js';

const cwd = process.argv[2] ?? process.cwd();

const agent = await createAgent(cwd);
agent.events.on('text_delta', (e) => process.stdout.write(e.text));
agent.events.on('tool_call', (e) => console.log(`\n[tool_call] ${e.toolUse.name} ${JSON.stringify(e.toolUse.input)}`));
agent.events.on('tool_result', (e) => console.log(`[tool_result] ${e.result.content.slice(0, 80)}`));
agent.events.on('permission_request', (e) => {
  console.log(`[permission] ${e.request.summary} → auto-allow`);
  e.resolve({ allow: true });
});
agent.events.on('loop_end', (e) => console.log(`\n[loop_end] ${e.reason}`));

try { await agent.loop.run('帮我读一下 demo.txt'); }
finally { await agent.dispose(); }
