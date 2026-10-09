/**
 * 为审批绑定已识别的本地环境前提。
 * 未覆盖的 Shell 语义仍标为 unknown；这不是确定性安全分析或沙箱。
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AnalysisInput, ToolAnalyzer } from '../../sdk/capabilities.js';

export function createEnvironmentAnalyzer(): ToolAnalyzer {
  return {
    id: 'operation-environment', version: '1.0.0',
    async analyze(input, signal) {
      const environment = await snapshot(input, signal);
      return { analyzerId: 'operation-environment', analyzerVersion: '1.0.0', completeness: 'unknown',
        effects: [{ kind: 'unknown' }], environment, reasonCode: 'environment_snapshot' };
    },
    async revalidate(analysis, input, signal) {
      return JSON.stringify(analysis.environment) === JSON.stringify(await snapshot(input, signal));
    },
  };
}

async function snapshot({ input, cwd }: AnalysisInput, signal: AbortSignal): Promise<Record<string, string>> {
  const paths = new Set<string>([resolve(cwd)]);
  for (const key of ['path', 'cwd', 'file', 'filePath', 'directory']) {
    const value = input[key];
    if (typeof value === 'string' && value.length && !value.includes('\0')) paths.add(resolve(cwd, value));
  }
  const command = input.command;
  if (typeof command === 'string') {
    // 常见脚本/配置变更必须使等待中的批准失效。复杂语法不据此宣称完整。
    for (const file of ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Makefile', '.git/config', '.git/HEAD', '.npmrc']) paths.add(join(cwd, file));
    // worktree 的 .git 是指针文件，真实配置/HEAD/commondir 也属于环境前提。
    try {
      const dotGit = join(cwd, '.git'); const stat = await lstat(dotGit);
      if (stat.isFile()) {
        paths.add(dotGit);
        const match = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(dotGit, 'utf8'));
        if (match) {
          const gitdir = resolve(cwd, match[1].trim());
          for (const file of ['HEAD', 'config', 'config.worktree', 'commondir']) paths.add(join(gitdir, file));
          try { const common = (await readFile(join(gitdir, 'commondir'), 'utf8')).trim(); if (common) paths.add(resolve(gitdir, common, 'config')); }
          catch { /* commondir 缺失仍由上面的指纹覆盖。 */ }
        }
      }
    } catch { /* 缺失 .git 不是分析失败；已有不可读文件会在指纹阶段失败。 */ }
    for (const match of command.matchAll(/(?:^|\s)["']?((?:\.\.?\/|\/)[^\s"';&|<>]+|[\w./-]+\.(?:[cm]?js|tsx?|sh|py|ps1))(?=["']?(?:\s|$))/g)) {
      paths.add(isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]));
    }
    // 包管理脚本引用的本地文件也保留指纹；没有运行任何项目脚本。
    try {
      const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
      for (const script of Object.values(pkg.scripts ?? {})) if (typeof script === 'string') {
        for (const match of script.matchAll(/(?:^|\s)["']?([\w./-]+\.(?:[cm]?js|tsx?|sh|py|ps1))(?=["']?(?:\s|$))/g)) paths.add(resolve(cwd, match[1]));
      }
    } catch { /* 缺失或无效 package.json 的状态仍由 fingerprintPath 记录。 */ }
  }
  const entries: Array<[string, string]> = [];
  for (const path of [...paths].sort()) { signal.throwIfAborted(); entries.push([path, await fingerprintPath(path, signal)]); }
  return Object.fromEntries(entries);
}

async function fingerprintPath(path: string, signal: AbortSignal): Promise<string> {
  try {
    const stat = await lstat(path, { bigint: true });
    const actual = await realpath(path);
    const identity = `${actual}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (stat.isDirectory()) return `${actual}:${stat.dev}:${stat.ino}:${stat.mode}`;
    if (stat.isSymbolicLink()) return `${identity}:target:${await fingerprintPath(actual, signal)}`;
    if (stat.isFile() && stat.size <= 1024n * 1024n) {
      const data = await readFile(path, { signal });
      return `${identity}:${createHash('sha256').update(data).digest('hex')}`;
    }
    return identity;
  } catch (error) {
    signal.throwIfAborted();
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path);
    return parent === path ? 'missing' : `missing:${await fingerprintPath(parent, signal)}`;
  }
}
