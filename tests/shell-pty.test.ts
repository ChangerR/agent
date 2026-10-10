/** 真实终端入口而非 MemoryTerminal：pnpm dev、保存 auto、退出与新进程再次执行。 */
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
const pythonAvailable = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0;
it.runIf(pythonAvailable)('pnpm dev PTY 只读 shell 零审批且 auto 设置跨进程持久化', async () => {
  const { stdout } = await exec('python3', [fileURLToPath(new URL('../scripts/shell-pty-regression.py', import.meta.url))], { timeout: 45000 });
  const report = JSON.parse(stdout);
  expect(report.command).toBe('ls -la && echo "---" && cat package.json');
  expect(report.launch).toBe('pnpm dev');
  expect(report.runs).toHaveLength(2);
  for (const run of report.runs) {
    expect(run).toMatchObject({ persistedMode: 'auto', judge: 0, manual: 0, executed: 1 });
    expect(run.results[0].content).toContain('shell-pty-fixture');
  }
}, 50000);
