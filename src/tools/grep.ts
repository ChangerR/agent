/**
 * grep 工具。有 rg 时走 ripgrep，没有时退回内置扫描。
 * 两种路径都跳过 node_modules、.git、dist，并最多返回 100 条。
 */
import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { authorizedSearchFiles, authorizedSearchTarget, collectSearchFiles, searchPluginEntries, type SearchFile } from './search-scope.js';
import { findRg } from '../core/platform.js';
import type { Tool } from '../core/registry.js';
import { matchPath, normalizeGrepLine, textStyle } from './text.js';

const MAX_RESULTS = 100;

export function buildRgArgs(input: { pattern: string; glob?: string; caseInsensitive?: boolean }): string[] {
  // --crlf 让 $ 和行号把 \r\n 当成一个换行，LF 文件不受影响。
  const args = ['--no-config', '--no-follow', '--no-pre', '--with-filename', '--line-number', '--no-heading', '--color=never', '--crlf', '--max-columns=300', '--max-count=100'];
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

export function createGrepTool(pluginEntries: readonly string[] = []): Tool { return {
  name: 'grep',
  description:
    'Search ordinary project files with ripgrep; returns path:line:text. Excludes hidden/sensitive files, configured plugin entries, symlinks, node_modules and dist. Respects project and nested .gitignore, including explicit glob filters. Ignores ripgrep configuration. Without rg, uses the same bounded file list with a JavaScript regex scan.',
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
    const protectedEntries = await searchPluginEntries(ctx.cwd, pluginEntries);
    const files = authorizedSearchFiles(await collectSearchFiles(ctx.cwd, searchCwd, glob ?? '**/*', protectedEntries, ctx.signal, true, (file) => authorizedSearchTarget(file.absolute, ctx.analysis)), ctx.analysis);
    if (!files.length) return { content: '(no matches)' };
    const bin = findRg();
    if (bin) {
      const outputs: string[] = [];
      let missing = false;
      // 显式文件列表，空列表绝不变回目录递归；分批避免操作系统 argv 长度上限。
      for (let offset = 0; offset < files.length; offset += 128) {
        ctx.signal.throwIfAborted();
        const rg = await runRg(bin,
          [...buildRgArgs({ pattern, caseInsensitive: Boolean(input.case_insensitive) }), '--', ...files.slice(offset, offset + 128).map((file) => file.absolute)],
          searchCwd, ctx.signal);
        if (rg.missing) { missing = true; break; }
        if (rg.code !== 0 && rg.code !== 1) return formatRg(rg);
        outputs.push(rg.stdout);
        if (outputs.join('').split('\n').filter(Boolean).length > MAX_RESULTS) break;
      }
      if (!missing) {
        const prefix = (await realpath(searchCwd)).replace(/\\/g, '/') + '/';
        const stdout = outputs.join('').split('\n').map((line) => {
          const normalized = normalizeGrepLine(line);
          return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
        }).join('\n');
        return formatRg({ missing: false, code: 0, stdout, stderr: '' });
      }
    }
    return searchBuiltin(pattern, files, Boolean(input.case_insensitive), ctx.signal);
  },
}; }

export const grepTool = createGrepTool();

interface RgRun {
  missing: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function runRg(bin: string, args: string[], cwd: string, signal: AbortSignal): Promise<RgRun> {
  return new Promise((resolvePromise) => {
    // rg 是宿主提供的工具依赖，不运行项目提供的配置/预处理器或动态加载环境。
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:RIPGREP_CONFIG_PATH|LD_.*|DYLD_.*)$/.test(key)));
    const child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  files: readonly SearchFile[],
  caseInsensitive: boolean,
  signal: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
  const hits: string[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    if (hits.length >= MAX_RESULTS) break;
    let text: string;
    try {
      text = textStyle(await readFile(file.absolute, { encoding: 'utf-8', signal })).body;
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < MAX_RESULTS; i++) {
      if (re.test(lines[i])) hits.push(`${file.path}:${i + 1}: ${lines[i]}`);
    }
  }
  return { content: hits.length > 0 ? hits.join('\n') : '(no matches)' };
}
