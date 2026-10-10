/** 搜索的共同执行边界：用户 glob 只过滤结果，绝不决定文件系统遍历根。 */
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { Minimatch } from 'minimatch';
import type { ToolAnalysis } from '../sdk/capabilities.js';
import { fsCaseSensitive } from './text.js';

const SENSITIVE_DIRECTORIES = ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', 'credentials', 'secrets', '.codex', '.agentlab', '.agent'];
/** 只保护写入：说明文件、项目配置与 plugins 目录不含凭据，可读；但不能被模型静默改写（提示注入持久化/扩权）。 */
const WRITE_PROTECTED_DIRECTORIES = ['plugins'];
const WRITE_PROTECTED_FILE = /^(?:agents\.md|claude\.md|agent\.config\.json)$/;
export type SensitiveAccess = 'read' | 'write';
/**
 * access 默认 'write'（最保守）。配置的插件入口、凭据/密钥、.git 等元数据和 mcp.json（可能含 env/headers token）读写都受保护；
 * AGENTS.md、CLAUDE.md、agent.config.json 与 plugins 目录只在写入时受保护。
 */
export function sensitivePath(path: string, configuredEntries: readonly string[], access: SensitiveAccess = 'write'): boolean {
  if (configuredEntries.some((entry) => resolve(entry) === resolve(path))) return true;
  const parts = path.replace(/\\/g, '/').toLowerCase().split('/');
  const basename = parts.at(-1) ?? '';
  if (access === 'write' && (parts.some((part) => WRITE_PROTECTED_DIRECTORIES.includes(part)) || WRITE_PROTECTED_FILE.test(basename))) return true;
  return parts.some((part) => SENSITIVE_DIRECTORIES.includes(part))
    || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|mcp\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/.test(basename);
}
/** 目录不可读（EACCES/EPERM）时工具同样无法读取其中内容；枚举跳过它，分析与执行共用同一函数，范围一致。 */
const UNREADABLE = ['EACCES', 'EPERM'];
/**
 * 指向搜索根内部的绝对 glob 转为相对 pattern；分析与执行共用，避免绝对 pattern 被误判为项目外且永远无匹配。
 * 含 `..`、其他平台路径或不在任一根内的 pattern 原样返回，仍按项目外处理。
 */
export function projectRelativePattern(pattern: string, roots: readonly string[]): string {
  if (!isAbsolute(pattern) || foreignPath(pattern) || pattern.split(/[\\/]/).includes('..')) return pattern;
  const wildcard = pattern.search(/[*?[\]{}()!+@]/);
  const literal = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  for (const root of roots) {
    const rest = relative(root, pattern);
    if (rest && within(root, literal) && within(root, resolve(root, rest))) return rest.split(sep).join('/');
  }
  return pattern;
}
export function within(root: string, path: string): boolean {
  const rest = relative(root, path); return rest === '' || rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}
export function foreignPath(path: string): boolean {
  return process.platform !== 'win32' && (/^[A-Za-z]:/.test(path) || path.includes('\\'));
}
/** 这些明确的越界/敏感请求仍由策略要求确认，不当成空的普通搜索授予。 */
export function searchPatternScope(pattern: string, cwd: string, entries: readonly string[]): 'project' | 'external' | 'sensitive' {
  if (isAbsolute(pattern) || foreignPath(pattern) || pattern.split(/[/{} ,]/).includes('..')) return 'external';
  if (sensitivePath(resolve(cwd, pattern), entries, 'read')
    || pattern.split(/[/{} ,]/).some((part) => sensitivePath(resolve(cwd, part), [], 'read'))) return 'sensitive';
  return 'project';
}
export interface SearchFile {
  path: string;
  absolute: string;
  mtimeMs: number;
  identity: string;
}
/** 搜索内容只快照元数据；解析项目内的普通 .gitignore，并显式报告这些读取，不执行搜索程序。 */
export async function collectSearchFiles(
  projectCwd: string, searchCwd: string, pattern: string, configuredEntries: readonly string[], signal: AbortSignal,
  matchBase = false, onIgnoreFile?: (file: SearchFile) => void,
): Promise<SearchFile[]> {
  signal.throwIfAborted();
  const project = await realpath(projectCwd);
  const root = await realpath(searchCwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  });
  if (!root || !within(project, root) || sensitivePath(searchCwd, configuredEntries, 'read') || sensitivePath(root, configuredEntries, 'read')) return [];
  if (!(await lstat(root)).isDirectory()) return [];
  interface IgnoreLayer { root: string; matcher: Ignore }
  const layers: IgnoreLayer[] = [];
  const addIgnore = async (dir: string, parents: readonly IgnoreLayer[]): Promise<IgnoreLayer[]> => {
    signal.throwIfAborted();
    const path = resolve(dir, '.gitignore');
    if (sensitivePath(path, configuredEntries, 'read')) return [...parents];
    try {
      const stat = await lstat(path);
      // .gitignore 只作为解析输入；不追随配置链接，也不执行其中内容。
      if (!stat.isFile() || stat.nlink !== 1 || !within(project, await realpath(path))) return [...parents];
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) return [...parents];
        onIgnoreFile?.({ path: relative(project, path), absolute: path, mtimeMs: opened.mtimeMs,
          identity: `${opened.dev}:${opened.ino}:${opened.mode}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}` });
        const text = await handle.readFile({ encoding: 'utf8' });
        signal.throwIfAborted();
        return [...parents, { root: dir, matcher: ignore({ ignorecase: !fsCaseSensitive() }).add(text) }];
      } finally { await handle.close(); }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP', ...UNREADABLE].includes((error as NodeJS.ErrnoException).code ?? '')) return [...parents];
      throw error;
    }
  };
  const ignored = (path: string, directory: boolean, active: readonly IgnoreLayer[]): boolean => {
    let excluded = false;
    for (const layer of active) {
      const name = relative(layer.root, path).replace(/\\/g, '/') + (directory ? '/' : '');
      const result = layer.matcher.test(name);
      if (result.ignored) excluded = true;
      else if (result.unignored) excluded = false;
    }
    return excluded;
  };
  // path 指向子目录时也保留项目到该目录的 ignore 规则；不读取项目外的全局配置。
  let ancestor = project;
  let active = await addIgnore(ancestor, layers);
  for (const part of relative(project, root).split(sep).filter(Boolean)) {
    ancestor = resolve(ancestor, part);
    if (ignored(ancestor, true, active)) return [];
    active = await addIgnore(ancestor, active);
  }
  const normalizedPattern = projectRelativePattern(pattern, [searchCwd, root]).replace(/^(?:\.\/)+/, '');
  const matcher = new Minimatch(normalizedPattern, { dot: false, nocase: !fsCaseSensitive(), matchBase });
  const recursiveBasename = matchBase && !normalizedPattern.includes('/');
  const result: SearchFile[] = [];
  const walk = async (dir: string, rules: readonly IgnoreLayer[]): Promise<void> => {
    signal.throwIfAborted();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (UNREADABLE.includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
      const raw = resolve(dir, entry.name);
      const name = relative(root, raw).replace(/\\/g, '/');
      // 仅在已知目录树内剪枝，pattern 不会成为新的遍历根或外部路径。
      if (entry.isDirectory() ? !recursiveBasename && !matcher.negate && !matcher.match(name, true) : !matcher.match(name)) continue;
      if (entry.isSymbolicLink() || sensitivePath(raw, configuredEntries, 'read') || ignored(raw, entry.isDirectory(), rules)) continue;
      try {
        const stat = await lstat(raw);
        if (stat.isSymbolicLink()) continue;
        const actual = await realpath(raw);
        if (!within(root, actual) || !within(project, actual) || sensitivePath(actual, configuredEntries, 'read')) continue;
        if (stat.isDirectory()) { await walk(actual, await addIgnore(actual, rules)); continue; }
        if (!stat.isFile() || stat.nlink !== 1) continue;
        result.push({ path: name, absolute: actual, mtimeMs: stat.mtimeMs,
          identity: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` });
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP', ...UNREADABLE].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
  };
  await walk(root, active);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function searchPluginEntries(cwd: string, entries: readonly string[]): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of entries) {
    const path = resolve(cwd, entry); paths.push(path);
    try { paths.push(await realpath(path)); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return paths;
}

/** 执行时重验范围可以缩小，不能在批准后第三次枚举时悄悄加入新目标。 */
export function authorizedSearchTarget(path: string, analysis?: ToolAnalysis): void {
  if (analysis && !analysis.targets?.includes(path)) throw new Error('approval_stale: search file set changed; run the search again');
}
export function authorizedSearchFiles(files: SearchFile[], analysis?: ToolAnalysis): SearchFile[] {
  if (!analysis) return files; // 直接工具单测/自定义宿主没有分析时，仍遵守本工具的物理范围。
  const approved = new Set(analysis.targets ?? []);
  if (files.some((file) => !approved.has(file.absolute))) throw new Error('approval_stale: search file set changed; run the search again');
  return files;
}
