// 仅供隔离 FakeProvider 测试使用；被动观察 Node 内建子进程频道，不替换 spawn/exec。
const dc = require('node:diagnostics_channel');
const fs = require('node:fs');
const trace = process.env.AGENTLAB_CHILD_TRACE;
const record = (event) => {
  if (trace) fs.appendFileSync(trace, JSON.stringify({ observer: process.pid, ...event }) + '\n');
};
dc.subscribe('child_process', ({ process: child }) => {
  const start = performance.now();
  let observed = false;
  let stdout = '';
  let stderr = '';
  let firstOutput;
  let nodeCommand;
  let prompt;
  child.once('spawn', () => {
    const args = child.spawnargs ?? [];
    observed =
      child.spawnfile === 'script' || args.some((arg) => /(?:^|\/)src\/cli\/index\.ts$/.test(arg));
    if (!observed) return;
    record({ event: 'spawn', pid: child.pid, file: child.spawnfile, args, at: Date.now() });
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-6000);
      if (firstOutput === undefined) {
        firstOutput = performance.now() - start;
        record({ event: 'first-output', pid: child.pid, ms: firstOutput });
      }
      if (nodeCommand === undefined && stdout.includes('node --import tsx src/cli/index.ts')) {
        nodeCommand = performance.now() - start;
        record({ event: 'node-command', pid: child.pid, ms: nodeCommand });
      }
      if (prompt === undefined && stdout.includes('Enter 发送')) {
        prompt = performance.now() - start;
        record({ event: 'prompt', pid: child.pid, ms: prompt });
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-6000);
    });
  });
  child.on('error', (error) => {
    if (observed)
      record({
        event: 'error',
        pid: child.pid,
        code: error.code,
        signal: error.signal,
        killed: error.killed,
        message: error.message,
        ms: performance.now() - start,
        stdout,
        stderr,
      });
  });
  child.once('close', (code, signal) => {
    if (observed)
      record({
        event: 'close',
        pid: child.pid,
        code,
        signal,
        killed: child.killed,
        ms: performance.now() - start,
        firstOutput,
        nodeCommand,
        prompt,
        stdout,
        stderr,
      });
  });
});
