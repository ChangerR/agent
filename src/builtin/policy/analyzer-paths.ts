/** 真实路径、调用目录和 writeRoots。不做命令或文件种类判断。 */
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import { foreignPath, sensitivePath, within } from '../../tools/search-scope.js';
import {
  described,
  hash,
  operationKey,
  windowsAmbiguousPath,
  type AnalyzerContext,
  type OpenedAnalysis,
} from './analyzer-types.js';

export type ResolvedTarget = Awaited<ReturnType<typeof resolveTarget>>;

/** 真实路径的歧义也是人工约束，不能回退成通用 complete 结果供精确规则 / yolo / reviewer 放行。 */
export function windowsPathUnverified(analysis: ToolAnalysis): ToolAnalysis {
  if (analysis.reasonCode === 'native_windows_unverified') return analysis;
  return {
    ...analysis,
    completeness: 'unknown',
    reasonCode: 'native_windows_unverified',
    evidence: [
      {
        source: 'platform-support',
        detail: 'Windows 调用目录或真实目标包含未经验证的歧义路径形态，必须人工确认。',
      },
      ...(analysis.evidence ?? []),
    ],
  };
}

/** 绑定调用目录。目录本身是歧义 Windows 路径时停住。不含 writeRoots。 */
export async function bindCwd(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  signal: AbortSignal,
): Promise<OpenedAnalysis> {
  const environment: Record<string, string> = {
    $operation: operationKey(input),
    $policyOptions: hash({ writeRoots: ctx.writeRoots, pluginEntries: ctx.pluginEntries }),
  };
  const actualCwd = await realpath(resolve(input.cwd));
  environment[`path:${resolve(input.cwd)}`] = await pathFingerprint(resolve(input.cwd), signal);
  if (ctx.platform === 'win32' && [resolve(input.cwd), actualCwd].some(windowsAmbiguousPath)) {
    return {
      environment,
      actualCwd,
      stop: windowsPathUnverified({
        ...described(environment),
        completeness: 'unknown',
        effects: [{ kind: 'unknown', target: actualCwd, scope: 'unknown' }],
        targets: [actualCwd],
      }),
    };
  }
  return { environment, actualCwd };
}

async function bindWriteRoots(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  environment: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const rootPaths = await validateWriteRoots(input.cwd, ctx.writeRoots, ctx.pluginEntries, signal);
  environment['$writeRoots'] = JSON.stringify(rootPaths);
  for (const path of ctx.writeRoots)
    environment[`writeRoot:${resolve(input.cwd, path)}`] = await pathFingerprint(
      resolve(input.cwd, path),
      signal,
    );
}

/** 调用目录绑定之后再记 writeRoots。歧义目录在 bindCwd 里已经停住。 */
export async function prepare(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  signal: AbortSignal,
): Promise<OpenedAnalysis> {
  const opened = await bindCwd(ctx, input, signal);
  if (!opened.stop) await bindWriteRoots(ctx, input, opened.environment, signal);
  return opened;
}

/** Windows 上未做通用文件分析的操作：只绑定调用目录，然后要求人工确认。 */
export async function windowsUnverified(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const opened = await bindCwd(ctx, input, signal);
  if (opened.stop) return opened.stop;
  return {
    ...described(opened.environment),
    completeness: 'unknown',
    effects: [{ kind: 'unknown', scope: 'unknown' }],
    reasonCode: 'native_windows_unverified',
    evidence: [
      {
        source: 'platform-support',
        detail:
          '未验证原生 Windows ADS/设备名/尾随点路径与 PowerShell 语义，不授予确定性文件权限。',
      },
    ],
  };
}

/** 只读验证显式作用域授权；项目外、敏感根或非目录根均不能启用。 */
export async function validateWriteRoots(
  cwd: string,
  roots: readonly string[],
  pluginEntries: readonly string[] = [],
  signal = new AbortController().signal,
): Promise<readonly string[]> {
  if (roots.length > 32) throw new Error('writeRoots 最多允许 32 个目录');
  const actualCwd = await realpath(resolve(cwd));
  const result: string[] = [];
  for (const root of roots) {
    signal.throwIfAborted();
    if (typeof root !== 'string' || !root.trim() || root.includes('\0') || foreignPath(root))
      throw new Error('writeRoots 必须是可验证的项目目录路径');
    const path = resolve(cwd, root);
    const target = await resolveTarget(path, signal);
    if (
      !within(actualCwd, target.actual) ||
      sensitivePath(
        path,
        pluginEntries.map((entry) => resolve(cwd, entry)),
      ) ||
      sensitivePath(target.actual, [])
    )
      throw new Error(`writeRoots 不允许项目外或敏感目录: ${root}`);
    if (target.exists && !(await lstat(target.actual)).isDirectory())
      throw new Error(`writeRoots 目标必须为目录: ${root}`);
    if (!target.exists && !(await lstat(target.parent)).isDirectory())
      throw new Error(`writeRoots 的现有父路径必须为目录: ${root}`);
    result.push(target.actual);
  }
  return [...new Set(result)].sort();
}

export async function resolveTarget(
  path: string,
  signal: AbortSignal,
  links = new Set<string>(),
): Promise<{
  actual: string;
  parent: string;
  exists: boolean;
  regularFile: boolean;
  directory: boolean;
  links: number;
}> {
  signal.throwIfAborted();
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink()) {
      if (links.has(path) || links.size > 40) throw new Error('Symbolic link cycle');
      links.add(path);
      return resolveTarget(resolve(dirname(path), await readlink(path)), signal, links);
    }
    const actual = await realpath(path);
    const stat = await lstat(actual);
    return {
      actual,
      parent: dirname(actual),
      exists: true,
      regularFile: stat.isFile(),
      directory: stat.isDirectory(),
      links: stat.isFile() ? stat.nlink : 1,
    };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    const resolvedParent = await resolveTarget(parent, signal, links);
    return {
      actual: join(resolvedParent.actual, relative(parent, path)),
      parent: resolvedParent.exists ? resolvedParent.actual : resolvedParent.parent,
      exists: false,
      regularFile: false,
      directory: false,
      links: 0,
    };
  }
}

export async function pathFingerprint(
  path: string,
  signal: AbortSignal,
  links = new Set<string>(),
): Promise<string> {
  signal.throwIfAborted();
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) {
      if (links.has(path) || links.size > 40) throw new Error('Symbolic link cycle');
      links.add(path);
      const link = await readlink(path);
      return `link:${link}:${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${await pathFingerprint(resolve(dirname(path), link), signal, links)}`;
    }
    const actual = await realpath(path);
    const identity = `${actual}:${info.dev}:${info.ino}:${info.mode}`;
    if (info.isDirectory()) return identity;
    const metadata = `${identity}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    return info.isFile() && info.size <= 1024n * 1024n
      ? `${metadata}:${createHash('sha256')
          .update(await readFile(path, { signal }))
          .digest('hex')}`
      : metadata;
  } catch (error) {
    signal.throwIfAborted();
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return `missing:${await pathFingerprint(parent, signal, links)}`;
  }
}
