/** Linux 隔离副本执行插件：宿主项目不挂载进可写空间，失败绝不降级执行。 */
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { definePlugin, type ExecutionBoundary, type ProcessExecution } from '../../sdk/index.js';
import { collectSearchFiles } from '../../tools/search-scope.js';
import { permissionHash } from '../../core/permission/grants.js';

const execFileAsync = promisify(execFile);
const binary = '/usr/bin/bwrap';

async function systemMounts(): Promise<string[]> {
  const args = [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--ro-bind',
    '/usr',
    '/usr',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/home/agent',
    '--setenv',
    'HOME',
    '/home/agent',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
  ];
  for (const path of ['/bin', '/sbin', '/lib', '/lib64']) {
    try {
      const stat = await lstat(path);
      args.push(
        ...(stat.isSymbolicLink()
          ? ['--symlink', await readlink(path), path]
          : ['--ro-bind', path, path]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    if ((await lstat('/etc/ld.so.cache')).isFile())
      args.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return args;
}

/** 快照复用搜索的真实路径与敏感目录边界，不复制链接、硬链接及凭据。 */
export async function copyExecutionSnapshot(
  cwd: string,
  destination: string,
  entries: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const files = await collectSearchFiles(cwd, cwd, '**/*', entries, signal);
  if (files.length > 20000) throw new Error('sandbox_snapshot_budget');
  let bytes = 0;
  for (const file of files) {
    signal.throwIfAborted();
    const handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (!stat.isFile() || stat.nlink !== 1 || identity !== file.identity)
        throw new Error('approval_stale');
      bytes += stat.size;
      if (bytes > 100 * 1024 * 1024) throw new Error('sandbox_snapshot_budget');
      const content = await handle.readFile();
      const after = await handle.stat();
      if (after.ctimeMs !== stat.ctimeMs || after.size !== stat.size)
        throw new Error('approval_stale');
      const target = join(destination, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: stat.mode & 0o777 });
    } finally {
      await handle.close();
    }
  }
}

export function projectSnapshotExecution(
  cwd: string,
  entries: readonly string[] = [],
): ProcessExecution {
  let probe: Promise<ExecutionBoundary> | undefined;
  const revision = permissionHash({
    platform: process.platform,
    cwd: resolve(cwd),
    entries,
    version: 1,
  });
  const status = async (signal: AbortSignal): Promise<ExecutionBoundary> => {
    signal.throwIfAborted();
    probe ??= (async () => {
      let available = false;
      if (process.platform === 'linux')
        try {
          const mounts = await systemMounts();
          await execFileAsync(binary, [...mounts, '--', '/usr/bin/true'], {
            timeout: 3000,
            maxBuffer: 8192,
            env: {},
          });
          available = true;
        } catch {
          /* 探针失败是能力不可用，不以版本号或平台字符串冒充支持。 */
        }
      return {
        id: 'project-snapshot',
        revision,
        available,
        reasonCode: available ? undefined : 'sandbox_unavailable',
        description:
          '项目隔离副本执行；无网络、无真实 HOME、无凭据，文件修改不回写宿主项目；不复制依赖目录和链接',
      };
    })();
    const result = await probe;
    signal.throwIfAborted();
    return result;
  };
  return {
    supports: (tool) =>
      tool.ownerPlugin === 'agentlab.local-tools' &&
      tool.version === '1.0.0' &&
      tool.name === 'bash',
    status,
    async execute(request, signal) {
      if (!(await status(signal)).available)
        return {
          content: 'sandbox_unavailable: 当前宿主未通过隔离探针，命令未执行；未回退宿主执行',
          isError: true,
        };
      if (
        resolve(request.cwd) !== resolve(cwd) ||
        !['bash', '/bin/bash', '/usr/bin/bash'].includes(request.file)
      )
        return { content: 'sandbox_scope_mismatch: 进程入口或项目已变化', isError: true };
      const root = await mkdtemp(join(tmpdir(), 'agentlab-execution-'));
      try {
        const workspace = join(root, 'workspace');
        await mkdir(workspace, { mode: 0o700 });
        await copyExecutionSnapshot(cwd, workspace, entries, signal);
        const args = [
          ...(await systemMounts()),
          '--bind',
          workspace,
          '/workspace',
          '--chdir',
          '/workspace',
          '--',
          '/bin/bash',
          '--noprofile',
          '--norc',
          '-p',
          ...request.args,
        ];
        return await new Promise((done) => {
          const child = spawn(binary, args, {
            env: {},
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let output = '',
            truncated = false,
            settled = false,
            timedOut = false;
          const kill = () => {
            if (child.pid)
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
          };
          const receive = (value: Buffer) => {
            const text = value.toString('utf8');
            const remaining = Math.max(0, 60000 - output.length);
            output += text.slice(0, remaining);
            if (text.length > remaining) truncated = true;
          };
          child.stdout.on('data', receive);
          child.stderr.on('data', receive);
          const timer = setTimeout(
            () => {
              timedOut = true;
              kill();
            },
            Math.max(1, Math.min(request.timeoutMs, 300000)),
          );
          const finish = (failed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', kill);
            done({
              content: `${output}${truncated ? '\n[输出已截断]' : ''}\n[项目隔离副本；文件改动未回写]${timedOut ? '\n[执行超时]' : ''}`,
              isError: failed || timedOut || signal.aborted,
            });
          };
          signal.addEventListener('abort', kill, { once: true });
          if (signal.aborted) kill();
          child.once('error', () => finish(true));
          child.once('close', (code) => finish(code !== 0));
        });
      } catch (error) {
        return {
          content: signal.aborted
            ? 'Tool cancelled'
            : `sandbox_start_failed: ${error instanceof Error && ['approval_stale', 'sandbox_snapshot_budget'].includes(error.message) ? error.message : '隔离环境准备失败'}；命令未降级到宿主执行`,
          isError: true,
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export function projectExecutionPlugin(cwd: string, entries: readonly string[]) {
  return definePlugin({
    manifest: { id: 'agentlab.execution', version: '1.0.0', apiVersion: 1 },
    config: { schema: z.object({}), ownedFields: [], applyMode: 'newSession' },
    setup(ctx) {
      const execution = projectSnapshotExecution(cwd, entries);
      ctx.provide.execution('project-snapshot', execution);
      ctx.provide.settings('execution-status', {
        title: '进程执行隔离',
        description:
          'capabilities.execution=project-snapshot 启用隔离副本；仅 Linux 通过探针后可用，不支持时不自动降级。',
        schema: { type: 'object' },
        applyMode: 'newSession',
        read: (signal) => execution.status(signal),
      });
    },
  });
}
