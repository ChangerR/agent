/** 实际 CLI 同环境冷启动容量对照；保持原始 10 秒 execFile 上限，仅离线 /permissions。 */
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
const [baselineArg, appArg, outputArg, countArg = '8'] = process.argv.slice(2);
if (baselineArg === '--help' || !baselineArg || !appArg || !outputArg) {
  console.log(
    '用法：node reproduce-cold-cli.mjs BASELINE_WORKTREE APP_WORKTREE EMPTY_OUTPUT_DIR [8|12]（仅独立 Linux 云端；原始 10 秒子进程限制，不调用模型）',
  );
  process.exit(baselineArg === '--help' ? 0 : 2);
}
if (process.platform !== 'linux') throw new Error('本对照仅用于独立 Linux 云端。');
const baseline = resolve(baselineArg),
  app = resolve(appArg),
  output = resolve(outputArg);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('请提供新的空证据目录。');
const directory = await mkdtemp(join(tmpdir(), 'agent-cli-cold-probe-'));
const count = Number(countArg);
if (![8, 12].includes(count)) throw new Error('固定容量对照仅允许 8 或 12 并发。');
const resultsFile = join(output, 'comparison.json');
const require = createRequire(join(app, 'package.json'));
const loader = require.resolve('tsx');
const types = [
  ['master', baseline],
  ['app', app],
];
const cases = [];
for (let i = 0; i < count + 2; i++) {
  const [label, source] = types[i % 2];
  const root = join(directory, String(i) + '-' + label);
  const project = join(root, 'project'),
    home = join(root, 'home');
  await mkdir(project, { recursive: true });
  await mkdir(join(project, '.git'));
  await mkdir(join(project, 'src/nested'), { recursive: true });
  await mkdir(join(home, '.agent'), { recursive: true });
  for (const file of ['src', 'package.json', 'tsconfig.json'])
    await cp(join(source, file), join(project, file), { recursive: true });
  await symlink(join(app, 'node_modules'), join(project, 'node_modules'), 'dir');
  await writeFile(join(home, '.agent/config.json'), JSON.stringify({ provider: 'fake' }));
  await writeFile(join(project, 'agent.config.json'), JSON.stringify({ permissionMode: 'auto' }));
  cases.push({ label, project, home, id: i });
}
const metrics = async () => ({
  cpu: await readFile('/sys/fs/cgroup/cpu.stat', 'utf8'),
  memory: await readFile('/sys/fs/cgroup/memory.events', 'utf8'),
  pids: (await readFile('/sys/fs/cgroup/pids.current', 'utf8')).trim(),
});
async function run(item, phase) {
  const start = performance.now();
  const args = [
    '--import',
    loader,
    join(item.project, 'src/cli/index.ts'),
    '--command',
    '/permissions',
    '--json',
  ];
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      args,
      {
        cwd: join(item.project, 'src/nested'),
        env: { HOME: item.home, USERPROFILE: item.home, PATH: process.env.PATH },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {}
        resolve({
          phase,
          id: item.id,
          label: item.label,
          pid: child.pid,
          ms: performance.now() - start,
          code: error ? (error.code ?? null) : 0,
          signal: error?.signal ?? null,
          killed: error?.killed ?? false,
          error: error?.message,
          stdout,
          stderr,
          valid: result?.data?.mode === 'auto',
        });
      },
    );
  });
}
const results = [];
for (const [phase, entries, parallel] of [
  ['serial-cold', cases.slice(0, 2), false],
  [`parallel-cold-${count}`, cases.slice(2), true],
  ['serial-warm', cases.slice(0, 2), false],
]) {
  const before = await metrics();
  const start = performance.now();
  const runs = parallel ? await Promise.all(entries.map((c) => run(c, phase))) : [];
  if (!parallel) for (const entry of entries) runs.push(await run(entry, phase));
  const result = { phase, before, after: await metrics(), ms: performance.now() - start, runs };
  results.push(result);
  console.log(JSON.stringify(result));
  await writeFile(resultsFile, JSON.stringify({ directory, results }, null, 2) + '\n');
}
await rm(directory, { recursive: true, force: true });
