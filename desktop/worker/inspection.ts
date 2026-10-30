import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { collectSearchFiles, sensitivePath, within } from '../../src/tools/search-scope.js';
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

export async function listLocalFiles(cwd: string, signal: AbortSignal) {
  const files = await collectSearchFiles(cwd, cwd, '**/*', [], signal);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES)
    .map((file) => file.path)
    .join('\n');
}

export async function readLocalFile(cwd: string, path: string, signal: AbortSignal, limit = 500) {
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
  const content = await readFile(actual, 'utf8');
  return content
    .split(/\r?\n/)
    .slice(0, limit)
    .map((line, index) => `${index + 1}\t${line}`)
    .join('\n');
}

export async function localGitDiff(
  cwd: string,
  signal: AbortSignal,
  resolveGit = resolveGitExecutable,
) {
  const root = await realpath(cwd);
  const common = ['--no-pager', '--no-optional-locks', '--literal-pathspecs'];
  const listing = await runGit(cwd, [...common, 'ls-files', '-z'], signal, resolveGit);
  const allowed: string[] = [];
  for (const path of listing.split('\0')) {
    signal.throwIfAborted();
    if (!path || path.startsWith('.') || allowed.length >= MAX_FILES) continue;
    const candidate = resolve(root, path);
    if (sensitivePath(candidate, [], 'read')) continue;
    try {
      const stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      const actual = await realpath(candidate);
      if (within(root, actual) && !sensitivePath(actual, [], 'read')) allowed.push(path);
    } catch (error) {
      if (
        !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
  }
  if (!allowed.length) return '没有可检查的普通已跟踪文件。';
  return runGit(
    cwd,
    [
      ...common,
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
}

export async function inspectLocalProject({
  cwd,
  kind,
  path,
  signal,
  resolveGit,
}: {
  cwd: string;
  kind: 'files' | 'read' | 'diff';
  path?: string;
  signal: AbortSignal;
  resolveGit?: typeof resolveGitExecutable;
}) {
  try {
    if (kind === 'files') return { content: await listLocalFiles(cwd, signal) };
    if (kind === 'read') return { content: await readLocalFile(cwd, path ?? '', signal) };
    const diff = await localGitDiff(cwd, signal, resolveGit);
    return {
      content: diff || '当前普通已跟踪文件与 HEAD 相同。未跟踪、已删除、隐藏和受保护文件未纳入。',
    };
  } catch (error) {
    return { content: errorMessage(error), error: true };
  }
}
