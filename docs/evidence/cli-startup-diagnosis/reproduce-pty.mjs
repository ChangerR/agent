/** 同环境交替跑 master / App 的相同 CLI/PTY 组；只用仓库离线假 provider。 */
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [baselineArg, appArg, outputArg] = process.argv.slice(2);
if (baselineArg === '--help' || !baselineArg || !appArg || !outputArg) {
  console.log(
    '用法：node reproduce-pty.mjs BASELINE_WORKTREE APP_WORKTREE EMPTY_OUTPUT_DIR（仅独立 Linux 云端；固定 2 worker、6 文件、master/App/App/master 四轮）',
  );
  process.exit(baselineArg === '--help' ? 0 : 2);
}
if (process.platform !== 'linux') throw new Error('本对照仅用于独立 Linux 云端。');
const baseline = resolve(baselineArg),
  app = resolve(appArg),
  output = resolve(outputArg);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('请提供新的空证据目录。');
const require = createRequire(join(app, 'package.json'));
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const preload = fileURLToPath(new URL('./trace-child.cjs', import.meta.url));
const cases = [
  ['master', baseline],
  ['app', app],
  ['app', app],
  ['master', baseline],
];
const files = [
  'tests/permission-settings-restart.test.ts',
  'tests/bash-readonly-pty.test.ts',
  'tests/cli-pty.test.ts',
  'tests/planning-pty.test.ts',
  'tests/powershell-permission-pty.test.ts',
  'tests/subagents-pty.test.ts',
];
let stop = false,
  active;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stop = true;
    active?.kill('SIGINT');
  });
const ps = () =>
  spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,sid=,stat=,comm=,args='], { encoding: 'utf8' })
    .stdout.trim()
    .split('\n')
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
      return (
        m && {
          pid: +m[1],
          ppid: +m[2],
          pgid: +m[3],
          sid: +m[4],
          state: m[5],
          comm: m[6],
          args: m[7],
        }
      );
    })
    .filter(Boolean);
const resources = async () => ({
  cpu: await readFile('/sys/fs/cgroup/cpu.stat', 'utf8'),
  pids: (await readFile('/sys/fs/cgroup/pids.current', 'utf8')).trim(),
  memory_events: await readFile('/sys/fs/cgroup/memory.events', 'utf8'),
  load: (await readFile('/proc/loadavg', 'utf8')).trim(),
});
const results = [];
for (let i = 0; i < cases.length; i++) {
  if (stop) break;
  const [label, cwd] = cases[i];
  const tag = `${i + 1}-${label}`;
  const trace = join(output, tag + '-children.jsonl');
  const home = join(output, tag + '-home');
  await mkdir(home, { recursive: true });
  await writeFile(trace, '');
  const before = await resources();
  const start = performance.now();
  const args = [vitest, 'run', ...files, '--maxWorkers=2', '--minWorkers=1'];
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    NODE_OPTIONS: '--require=' + JSON.stringify(preload),
    AGENTLAB_CHILD_TRACE: trace,
  };
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  active = child;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (text) => {
    stdout += text;
  });
  child.stderr.setEncoding('utf8').on('data', (text) => {
    stderr += text;
  });
  const known = new Set([child.pid]);
  const seen = new Map();
  let ended = false;
  const closed = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      ended = true;
      reject(error);
    });
    child.once('close', (code, signal) => {
      ended = true;
      resolve({ code, signal });
    });
  });
  const monitor = (async () => {
    while (!ended) {
      const rows = ps();
      for (let pass = 0; pass < 8; pass++)
        for (const row of rows) if (known.has(row.ppid)) known.add(row.pid);
      for (const row of rows) if (known.has(row.pid)) seen.set(row.pid, row);
      await delay(200);
    }
  })();
  const exit = await closed;
  active = undefined;
  await monitor;
  const after = await resources();
  const survivors = ps().filter((row) => known.has(row.pid));
  const events = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const entry = {
    tag,
    label,
    cwd,
    args,
    exit,
    duration_ms: performance.now() - start,
    before,
    after,
    observed_processes: seen.size,
    live_survivors: survivors.filter((row) => !row.state.startsWith('Z')),
    zombie_survivors: survivors.filter((row) => row.state.startsWith('Z')),
    spawns: events.filter((e) => e.event === 'spawn').length,
    closes: events.filter((e) => e.event === 'close').map(({ stdout, stderr, ...e }) => e),
  };
  await writeFile(join(output, tag + '.log'), stdout + stderr);
  await writeFile(
    join(output, tag + '-processes.json'),
    JSON.stringify([...seen.values()], null, 2) + '\n',
  );
  results.push(entry);
  await writeFile(join(output, 'comparison.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(entry));
}
