import { fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = process.argv[2] ? resolve(process.argv[2]) : join(root, 'desktop/dist');
const temporary = await mkdtemp(join(tmpdir(), 'agentlab-desktop-smoke-'));
const project = join(temporary, 'project'),
  home = join(temporary, 'home');
await mkdir(project);
await mkdir(home);
await writeFile(join(project, 'README.md'), '# Node sidecar smoke test\n');
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ANTHROPIC_API_KEY: 'test-only-never-sent',
  OPENAI_API_KEY: 'test-only-never-sent',
  AGENTLAB_DEMO_KEY: 'test-only-never-sent',
};
delete env.ANTHROPIC_AUTH_TOKEN;
delete env.OPENAI_BASE_URL;
const child = fork(join(output, 'worker/index.mjs'), [], {
  execPath: join(output, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  cwd: project,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let state;
const pending = new Map(),
  waiters = new Set();
const deadline = setTimeout(() => {
  console.error('Sidecar smoke 超时');
  child.kill();
  process.exitCode = 1;
}, 30_000);
const ready = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.on('message', (message) => {
    if (message.type === 'ready') resolve();
    if (message.type === 'state') {
      state = message.state;
      for (const check of [...waiters]) check();
    }
    if (message.type === 'reply') {
      const call = pending.get(message.id);
      if (call) {
        pending.delete(message.id);
        message.error ? call.reject(new Error(message.error)) : call.resolve();
      }
    }
  });
  child.once('exit', (code) => {
    if (code) reject(new Error('worker exit ' + code));
  });
});
child.stderr.on('data', (data) => process.stderr.write(data));
function request(action) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    child.send({ id, action });
  });
}
function waitFor(predicate) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) {
        waiters.delete(check);
        resolve();
      }
    };
    waiters.add(check);
  });
}
const binding = () => ({ generation: state.generation, sessionId: state.sessionId });
try {
  await ready;
  await request({ type: 'init', cwd: project, demo: true, generation: randomUUID() });
  assert.ok(state.tools.some((t) => t.name === 'bash')); // tree-sitter 模块已在 Node sidecar 加载。
  await request({ type: 'submit', ...binding(), invocationId: randomUUID(), text: '演示工具审批' });
  await waitFor(() => state.approvals.length === 1);
  await assert.rejects(access(join(project, 'demo-note.txt')));
  const approval = state.approvals[0].id;
  await request({ type: 'approve', ...binding(), approvalId: approval, allow: true });
  await waitFor(() => !state.busy);
  assert.ok(!state.error, state.error);
  assert.match(await readFile(join(project, 'demo-note.txt'), 'utf8'), /真实 ToolExecutor/);
  assert.ok(state.sessions.some((s) => s.id === state.sessionId));
  await assert.rejects(
    request({ type: 'approve', ...binding(), approvalId: approval, allow: true }),
  );
  const usageBeforeStats = structuredClone(state.usage);
  await request({ type: 'submit', ...binding(), invocationId: randomUUID(), text: '/stats' });
  await waitFor(() => !state.busy);
  assert.ok(!state.error, state.error);
  assert.ok(!state.interaction);
  assert.match(state.rows.at(-1).text, /缓存命中率/);
  assert.deepEqual(state.usage, usageBeforeStats); // 统计命令不新增模型请求用量。
  await request({ type: 'dispose' });
  child.disconnect();
  console.log(
    'Sidecar smoke 通过：原生模块、审批前无写入、批准后真实写入、会话保存、过期审批拒绝、直接查询缓存统计。\n验证项目：' +
      project,
  );
} finally {
  clearTimeout(deadline);
  if (child.connected) child.disconnect();
}
