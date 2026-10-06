/**
 * grep 工具。有 rg 时走 ripgrep，没有时退回内置扫描。
 * 两种路径都跳过 node_modules、.git、dist，并最多返回 100 条。
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import fg from 'fast-glob';
import { findRg } from '../core/platform.js';
import type { Tool } from '../core/registry.js';
import { fsCaseSensitive, matchPath, normalizeGrepLine, textStyle } from './text.js';

const MAX_RESULTS = 100;

export function buildRgArgs(input: { pattern: string; glob?: string; caseInsensitive?: boolean }): string[] {
  // --crlf 让 $ 和行号把 \r\n 当成一个换行，LF 文件不受影响。
  const args = ['--line-number', '--no-heading', '--color=never', '--crlf', '--max-columns=300', '--max-count=100'];
  if (input.caseInsensitive) args.push('--ignore-case');
  if (input.glob) args.push('--glob', input.glob);
  args.push('--glob', '!**/node_modules/**', '--glob', '!**/.git/**', '--glob', '!**/dist/**', '--regexp', input.pattern);
  return args;
}

/** 让 bash 工具也能直接调用 rg：PATH 里没有时补上它所在的目录。 */
export function envWithRg(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rg = findRg();
  if (!rg) return env;
  const dir = dirname(rg);
  const next: NodeJS.ProcessEnv = { ...env };
  let seen = false;
  for (const key of ['PATH', 'Path'] as const) {
    const value = next[key];
    if (value === undefined) continue;
    seen = true;
    if (!value.split(delimiter).includes(dir)) next[key] = `${dir}${delimiter}${value}`;
  }
  if (!seen) next.PATH = dir;
  return next;
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with ripgrep (the rg command). Returns path:line:text. Respects .gitignore. If rg is not installed, falls back to a built-in scan.',
  risk: 'read',
  isConcurrencySafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern, passed to rg --regexp' },
      path: { type: 'string', description: 'Directory to search, default cwd' },
      glob: { type: 'string', description: 'File filter, e.g. "*.ts"' },
      case_insensitive: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  analyzeInput(input) {
    const pattern = String(input.pattern ?? '');
    return { patternTarget: pattern, summary: `grep: /${pattern}/` };
  },
  async execute(input, ctx) {
    const pattern = String(input.pattern ?? '');
    const searchCwd = input.path ? resolve(ctx.cwd, String(input.path)) : ctx.cwd;
    const glob = input.glob === undefined ? undefined : matchPath(String(input.glob));
    const bin = findRg();
    if (bin) {
      const rg = await runRg(
        bin,
        buildRgArgs({ pattern, glob, caseInsensitive: Boolean(input.case_insensitive) }),
        searchCwd,
        ctx.signal,
      );
      if (!rg.missing) return formatRg(rg);
    }
    return searchBuiltin(pattern, searchCwd, glob, Boolean(input.case_insensitive));
  },
};

interface RgRun {
  missing: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function runRg(bin: string, args: string[], cwd: string, signal: AbortSignal): Promise<RgRun> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    const kill = () => child.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    const finish = (result: RgRun) => {
      signal.removeEventListener('abort', kill);
      resolvePromise(result);
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ missing: error.code === 'ENOENT', code: null, stdout: '', stderr: error.message });
    });
    child.on('close', (code) => {
      finish({
        missing: false,
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function formatRg(result: RgRun): { content: string; isError?: boolean } {
  if (result.code !== 0 && result.code !== 1) {
    const message = (result.stderr || result.stdout || 'rg failed').trim();
    return { content: message, isError: true };
  }
  const lines = result.stdout
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => normalizeGrepLine(line));
  if (lines.length === 0) return { content: '(no matches)' };
  const clipped = lines.slice(0, MAX_RESULTS);
  const text = clipped.join('\n');
  return { content: lines.length > MAX_RESULTS ? `${text}\n[truncated]` : text };
}

async function searchBuiltin(
  pattern: string,
  cwd: string,
  glob: string | undefined,
  caseInsensitive: boolean,
): Promise<{ content: string; isError?: boolean }> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
  const files = await fg(glob ?? '**/*', {
    cwd,
    onlyFiles: true,
    dot: false,
    caseSensitiveMatch: fsCaseSensitive(),
    ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
  });
  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= MAX_RESULTS) break;
    let text: string;
    try {
      text = textStyle(await readFile(resolve(cwd, file), 'utf-8')).body;
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
      if (re.test(lines[i])) hits.push(`${file}:${i + 1}: ${lines[i]}`);
    }
  }
  return { content: hits.length > 0 ? hits.join('\n') : '(no matches)' };
}
