/** Linux 真实 PTY：util-linux script 负责终端，Node 只收发字节，不模拟终端。 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function createPtyProject() {
  const version = spawnSync('script', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !version.stdout.includes('util-linux')) {
    throw new Error('Linux PTY 回归需要 util-linux 的 script；请安装 util-linux 后重新运行 pnpm test。');
  }
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'agent-node-pty-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  try {
    mkdirSync(home); mkdirSync(project); mkdirSync(join(project, '.git'));
    // 复制实际启动文件，不生成另一份 dev 定义、不使用 tsx 内部 loader。
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src', 'tsconfig.json']) cpSync(join(repo, name), join(project, name), { recursive: true });
    cpSync(join(repo, 'node_modules'), join(project, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '', TERM: 'xterm-256color',
    // 复用已安装依赖的隔离副本；pnpm 11 的原目录元数据仅告警，禁止测试偷偷联网重装。
    pnpm_config_verify_deps_before_run: 'warn', AGENTLAB_SCREEN: 'alt', NO_COLOR: '1', XDG_DATA_HOME: join(home, '.local/share'), COREPACK_ENABLE_NETWORK: '0' };
  return { root, home, project, repo,
    launch() {
      // stty 只设窗口大小；被测命令确实是当前项目原样的 pnpm dev。
      const child = spawn('script', ['-qefc', 'stty rows 40 cols 140; exec pnpm dev', '/dev/null'], {
        cwd: project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = ''; let failure: Error | undefined;
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
      child.on('error', error => { failure = error; });
      const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
      return {
        get output() { return output; },
        key(value: string) { child.stdin.write(value); },
        send(value: string) { child.stdin.write(value + '\r'); },
        async wait(predicate: () => boolean, description: string) {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            if (predicate()) return;
            if (failure || child.exitCode !== null || child.signalCode !== null) throw failure ?? new Error(`PTY 提前退出 (${child.exitCode}): ${output.slice(-6000)}`);
            await delay(20);
          }
          throw new Error(`${description}\nPTY 输出末尾:\n${output.slice(-6000)}`);
        },
        async close() {
          child.stdin.write('\x03');
          const closed = await Promise.race([exited.then(() => true), delay(1500).then(() => false)]);
          if (!closed && child.pid) {
            try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
            if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) {
              try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
              if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) throw new Error('PTY 进程未能退出');
            }
          }
        },
      };
    },
    dispose() { rmSync(root, { recursive: true, force: true }); },
    readConfig() { return JSON.parse(readFileSync(join(project, 'agent.config.json'), 'utf8')); },
  };
}
