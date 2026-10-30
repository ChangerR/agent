import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { definePlugin, type ToolContext } from '../../src/sdk/index.js';
import type { Agent } from '../../src/runtime/agent.js';
import { sensitivePath, within } from '../../src/tools/search-scope.js';
import { gitEnvironment, resolveGitExecutable } from './git-executable.js';

const MAX_FILES = 200;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runGit(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  resolveGit: typeof resolveGitExecutable,
) {
  const executable = await resolveGit(cwd);
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        signal,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        env: gitEnvironment(),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** 这里只检查预览的物理边界；文件内容始终由 ToolExecutor 内的 read_file 读取。 */
async function assertPreviewFile(cwd: string, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
    throw new Error('仅支持项目内的相对文件路径');
  const root = await realpath(cwd);
  const candidate = resolve(root, path);
  if (sensitivePath(candidate, [], 'read'))
    throw new Error('该文件属于受保护内容，不能在预览中读取');
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('仅支持项目内的普通文件');
  if (stat.size > MAX_READ_BYTES) throw new Error('文件超过 2 MiB，不能在预览中完整读取');
  const actual = await realpath(candidate);
  if (!within(root, actual) || sensitivePath(actual, [], 'read'))
    throw new Error('文件路径超出项目或属于受保护内容');
  signal.throwIfAborted();
}

async function localGitDiff(context: ToolContext, resolveGit = resolveGitExecutable) {
  if (!context.invokeTool) return { content: '检查需要唯一执行器的子工具入口。', isError: true };
  const { cwd, signal } = context;
  const listing = await context.invokeTool('glob', { pattern: '**/*' });
  if (listing.isError) return listing;
  const allowed: string[] = [];
  for (const path of listing.content.split('\n').slice(0, MAX_FILES)) {
    signal.throwIfAborted();
    if (!path || path.startsWith('(') || path.startsWith('.')) continue;
    try {
      await assertPreviewFile(cwd, path, signal);
    } catch {
      signal.throwIfAborted();
      continue;
    }
    // Git 不得绕过逐文件的 deny、ask 与执行钩子；任一失败立即结算整次检查。
    const check = await context.invokeTool('read_file', { path, limit: 1 });
    if (check.isError) return check;
    allowed.push(path);
  }
  if (!allowed.length) return { content: '没有本次已授权且可读取的普通项目文件。' };
  // 审批可能等待很久；执行 Git 前再收窄一次物理边界。
  for (const path of allowed) await assertPreviewFile(cwd, path, signal);
  const diff = await runGit(
    cwd,
    [
      '--no-pager',
      '--no-optional-locks',
      '--literal-pathspecs',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'diff.external=',
      '-c',
      'core.pager=cat',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      'HEAD',
      '--',
      ...allowed,
    ],
    signal,
    resolveGit,
  );
  return {
    content: diff || '当前已授权普通文件与 HEAD 相同。未跟踪、已删除、隐藏和受保护文件未纳入。',
  };
}

/** 桌面 Git 检查通过 manifest/setup 挂载，子工具继承同一次执行的授权和取消信号。 */
export function inspectionPlugin(resolveGit = resolveGitExecutable) {
  return definePlugin({
    manifest: { id: 'agentlab.desktop-inspection', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.tool('desktop_git_diff', {
        name: 'desktop_git_diff',
        description:
          'Inspect Git changes against HEAD for up to 200 ordinary project files authorized by glob/read_file. Excludes deleted, hidden, ignored and protected files. Includes pre-existing user changes; untracked files are not included.',
        risk: 'read',
        isConcurrencySafe: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        analyzeInput: () => ({
          patternTarget: 'ordinary-tracked-worktree',
          summary: '检查项目普通文件的 Git 差异（含已有改动，最多 200 个文件）',
        }),
        execute: (_input, context) => localGitDiff(context, resolveGit),
      });
    },
  });
}

export async function inspectProject({
  agent,
  kind,
  path,
  signal,
}: {
  agent: Pick<Agent, 'cwd' | 'invokeTool'>;
  kind: 'files' | 'read' | 'diff';
  path?: string;
  signal: AbortSignal;
}) {
  try {
    if (kind === 'read') await assertPreviewFile(agent.cwd, path ?? '', signal);
    return await agent.invokeTool(
      kind === 'files' ? 'glob' : kind === 'read' ? 'read_file' : 'desktop_git_diff',
      kind === 'files' ? { pattern: '**/*' } : kind === 'read' ? { path, limit: 500 } : {},
      signal,
    );
  } catch (error) {
    return { content: errorMessage(error), isError: true };
  }
}
