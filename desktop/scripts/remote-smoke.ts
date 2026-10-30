/** 用户指定 SSH 测试机的隔离验收：本机 mock API，远程不使用真实模型 key。 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { SshHost } from '../main/ssh-host.js';
import { ModelBroker } from '../remote/broker.js';
import { OpenAIProvider } from '../../src/providers/openai.js';
import type { RuntimeSnapshot } from '../shared/protocol.js';

const target = process.argv[2] ?? 'ubuntu@10.100.0.8';
if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(target)) throw new Error('INVALID_TARGET');
const token = randomUUID(),
  remoteRoot = '/tmp/agentlab-ssh-test-' + token;
const key = 'ssh-fixed-fake-key-' + token;
const output = resolve('desktop/.validation/remote');
await mkdir(output, { recursive: true });
function ssh(script: string) {
  return execFileSync(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', target, 'sh -s'],
    { input: script, encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );
}
const fixture = {
  provider: 'openai',
  model: 'ssh-main',
  thinking: 'off',
  compactThreshold: 3000,
  pluginEntries: [remoteRoot + '/network-guard.mjs'],
  permissions: { allow: [], deny: [], ask: ['write_file'] },
  pluginConfig: {
    'agentlab.planning': { mode: 'auto', provider: 'planRoute', model: 'ssh-plan' },
    'agentlab.reviewer-model': { provider: 'judgeRoute', model: 'ssh-judge' },
    'agentlab.compaction-summary': { provider: 'compactRoute', model: 'ssh-compact' },
  },
};
const configEncoded = Buffer.from(JSON.stringify(fixture)).toString('base64');
const guardEncoded = Buffer.from(
  `import net from 'node:net';export default {manifest:{id:'fixture.no-outbound-network',version:'1.0.0',apiVersion:1},setup(){net.Socket.prototype.connect=function(){throw new Error('OUTBOUND_NETWORK_DISABLED')};globalThis.fetch=async()=>{throw new Error('OUTBOUND_NETWORK_DISABLED')};}};`,
).toString('base64');
ssh(
  `set -eu\numask 077\nmkdir -p '${remoteRoot}/project' '${remoteRoot}/home'\nprintf '%s' '${configEncoded}' | base64 -d > '${remoteRoot}/project/agent.config.json'\nprintf '%s' '${guardEncoded}' | base64 -d > '${remoteRoot}/network-guard.mjs'\nprintf 'SSH_REMOTE_READ_OK\\n' > '${remoteRoot}/project/README.md'\nprintf 'OPENAI_API_KEY=remote-fake-never-use\\nOPENAI_BASE_URL=http://127.0.0.1:1\\n' > '${remoteRoot}/project/.env'\n`,
);
const requests: Array<{ model: string; auth: boolean }> = [];
let mainRound = 0;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  requests.push({ model: data.model, auth: req.headers.authorization === 'Bearer ' + key });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta: unknown, reason: string | null = null) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'mock-' + requests.length,
          object: 'chat.completion.chunk',
          created: 1,
          model: data.model,
          choices: [{ index: 0, delta, finish_reason: reason }],
        }) +
        '\n\n',
    );
  let text: string | undefined, tool: { name: string; input: unknown } | undefined;
  if (data.model === 'ssh-plan') text = 'null';
  else if (data.model === 'ssh-judge')
    text = JSON.stringify({
      decision: 'ask',
      reasonCode: 'fixture_ask',
      reason: '隔离 SSH 验收需要人工确认',
    });
  else if (data.model === 'ssh-compact') text = '保留用户要求和已完成工具事实的隔离测试摘要。';
  else {
    mainRound++;
    if (mainRound === 1) tool = { name: 'read_file', input: { path: 'README.md' } };
    else if (mainRound === 2)
      tool = {
        name: 'write_file',
        input: { path: 'result.txt', content: 'SSH_REMOTE_WRITE_OK\n' },
      };
    else if (mainRound === 3)
      tool = { name: 'bash', input: { command: 'printf remote-command-ok' } };
    else text = 'SSH_AGENT_COMPLETE ' + (mainRound > 4 ? 'CHILD_OK' : '');
  }
  if (tool) {
    send({
      tool_calls: [
        {
          index: 0,
          id: 'mock-tool-' + mainRound,
          type: 'function',
          function: { name: tool.name, arguments: JSON.stringify(tool.input) },
        },
      ],
    });
    send({}, 'tool_calls');
  } else {
    send({ content: text!.slice(0, 8) });
    send({ content: text!.slice(8) });
    send({}, 'stop');
  }
  res.write(
    'data: ' +
      JSON.stringify({
        id: 'usage',
        choices: [],
        usage: { prompt_tokens: 40, completion_tokens: 20 },
      }) +
      '\n\n',
  );
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('MOCK_FAILED');
let state: RuntimeSnapshot | undefined, host: SshHost | undefined;
const states: RuntimeSnapshot[] = [];
function makeHost() {
  const broker = new ModelBroker(1000000);
  const h = new SshHost({
    project: { target, path: remoteRoot + '/project', mappings: {} },
    remoteHome: remoteRoot + '/home',
    archive: resolve('desktop/dist/remote/linux-x64.tgz'),
    defaults: { provider: 'openai', model: 'ssh-main' },
    broker,
    configure: async (workspace) =>
      workspace.requirements.map((r) => {
        const provider = new OpenAIProvider({
          baseURL: 'http://127.0.0.1:' + address.port + '/v1',
          apiKey: key,
        });
        return broker.add(provider, {
          name: r.name,
          kind: 'openai',
          routeId: provider.routeId,
          endpoint: 'http://127.0.0.1:' + address.port + '/v1',
          models: Object.fromEntries(
            r.models.map((m) => [m, { contextWindow: 200000, maxOutputTokens: 4096 }]),
          ),
          capabilities: Object.fromEntries(r.models.map((m) => [m, provider.modelCapabilities(m)])),
        });
      }),
    onState: (s) => {
      state = s;
      states.push(structuredClone(s));
    },
    onExit: () => {},
    onStatus: (s) => console.log(s),
  });
  return h;
}
async function wait(test: () => boolean, description: string, timeout = 30000) {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > timeout)
      throw new Error(
        description +
          ': ' +
          JSON.stringify({ phase: state?.phase, error: state?.error, rows: state?.rows }),
      );
    await new Promise((r) => setTimeout(r, 50));
  }
}
const send = async (action: Record<string, unknown>) =>
  host!.request({
    ...action,
    generation: state!.generation,
    sessionId: state!.sessionId,
  } as Parameters<SshHost['request']>[0]);
const result: Record<string, unknown> = { target, remoteRoot };
try {
  host = makeHost();
  await host.connect();
  await wait(() => !!state, '初始快照');
  assert(state!.plugins.some((p) => p.id === 'fixture.no-outbound-network'));
  result.remoteNodeNetworkDisabled = true;
  const sessionId = state!.sessionId;
  await send({
    type: 'submit',
    text: 'READ_WRITE：读取 README.md，写 result.txt 并运行验证命令。',
    invocationId: randomUUID(),
  });
  const seen = new Set<string>();
  const started = Date.now();
  while (state!.busy && Date.now() - started < 60000) {
    for (const approval of state!.approvals) {
      if (seen.has(approval.id)) continue;
      seen.add(approval.id);
      await send({ type: 'approve', approvalId: approval.id, allow: true });
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(state!.busy, false);
  assert.equal(state!.error, undefined);
  assert(state!.rows.some((r) => r.text.includes('SSH_AGENT_COMPLETE')));
  assert.equal(ssh(`cat '${remoteRoot}/project/result.txt'`), 'SSH_REMOTE_WRITE_OK\n');
  assert(state!.rows.some((r) => r.toolName === 'bash' && r.text.includes('remote-command-ok')));
  assert(requests.some((r) => r.model === 'ssh-plan'));
  assert(requests.some((r) => r.model === 'ssh-judge'));
  assert(requests.every((r) => r.auth));
  result.loop = {
    modelRequests: requests.length,
    approvals: seen.size,
    tools: state!.rows
      .filter((r) => r.kind === 'tool')
      .map((r) => ({ name: r.toolName, status: r.status })),
    sessionId,
  };
  const competitor = makeHost();
  let locked = false;
  try {
    await competitor.connect();
  } catch (e) {
    locked = e instanceof Error && e.message === 'PROJECT_BUSY';
  }
  assert(locked);
  result.projectLock = true;
  await send({ type: 'submit', text: '/agents spawn CHILD_PROBE', invocationId: randomUUID() });
  await wait(
    () => requests.filter((r) => r.model === 'ssh-main').length > 4,
    '子 Agent 通过本机模型代理',
  );
  await wait(() => !state!.busy, '子任务命令结算');
  result.childProxy = true;
  for (let i = 0; i < 6 && !requests.some((r) => r.model === 'ssh-compact'); i++) {
    await send({
      type: 'submit',
      text: 'COMPACT_PROBE ' + 'context '.repeat(3000),
      invocationId: randomUUID(),
    });
    await wait(() => !state!.busy, '压缩用上下文轮次结算');
  }
  assert(requests.some((r) => r.model === 'ssh-compact'));
  result.compactProxy = true;
  await host.dispose();
  state = undefined;
  host = makeHost();
  await host.connect();
  await send({ type: 'resume', id: sessionId });
  await wait(() => state!.sessionId === sessionId && !state!.busy, '远程会话恢复');
  result.resume = state!.rows.some((r) => r.text.includes('READ_WRITE'));
  // 待审批时停止；旧审批即便仍持有 ID，也不能在当前运行时通过。
  mainRound = 1;
  await send({ type: 'submit', text: 'CANCEL_PROBE：等待写入审批', invocationId: randomUUID() });
  await wait(() => !!state!.approvals.length, '取消用审批');
  const approval = state!.approvals[0];
  await send({ type: 'stop' });
  await wait(() => !state!.busy, '停止结算');
  await assert.rejects(send({ type: 'approve', approvalId: approval.id, allow: true }));
  result.staleApprovalRejected = true;
  // 再次等待审批并强制断开本次测试拥有的 SSH 子进程，验证远程结算释放锁。
  mainRound = 1;
  await send({ type: 'submit', text: 'DISCONNECT_PROBE', invocationId: randomUUID() });
  await wait(() => !!state!.approvals.length, '断线用审批');
  const disconnectedApproval = state!.approvals[0];
  (host as unknown as { child: { kill(): void } }).child.kill();
  await new Promise((r) => setTimeout(r, 1200));
  state = undefined;
  host = makeHost();
  await host.connect();
  await send({ type: 'resume', id: sessionId });
  await wait(() => state!.sessionId === sessionId && !state!.busy, '断线后恢复');
  assert.equal(state!.approvals.length, 0);
  await assert.rejects(send({ type: 'approve', approvalId: disconnectedApproval.id, allow: true }));
  result.disconnectRecovery = true;
  await host.dispose();
  const leaked = ssh(
    `grep -R -l '${key}' '${remoteRoot}/home' '${remoteRoot}/project' 2>/dev/null || true`,
  );
  assert.equal(leaked.trim(), '');
  result.remoteKeyLeak = false;
  result.requests = requests;
  result.ok = true;
} finally {
  await host?.dispose().catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await writeFile(resolve(output, 'ssh-smoke.json'), JSON.stringify(result, null, 2));
  await writeFile(resolve(output, 'snapshots.json'), JSON.stringify(states));
}
console.log(JSON.stringify(result, null, 2));
