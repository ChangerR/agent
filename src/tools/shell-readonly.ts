/** 只读 shell 的同一份分析/执行契约：语法、选项、文件边界与宿主环境一起验证。 */
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import Parser from 'tree-sitter';
import Bash from 'tree-sitter-bash';
import type { ToolAnalysis } from '../sdk/capabilities.js';
import { foreignPath, searchPluginEntries, sensitivePath, within } from './search-scope.js';

const TRUSTED_PATH = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'];
const LIMIT = 20_000;
type Effect = ToolAnalysis['effects'][number];
type Scope = NonNullable<Effect['scope']>;
type ReadKind = 'content' | 'metadata' | 'git';
export interface ReadOnlyShellAnalysis {
  complete: boolean;
  reasonCode: string;
  effects: ToolAnalysis['effects'];
  targets: string[];
  command?: string;
  environment: Record<string, string>;
  commands: string[][];
  unresolved: string[];
}
class Unverified extends Error { constructor(readonly reasonCode: string) { super(reasonCode); } }
const fail = (reason: string): never => { throw new Unverified(reason); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/** 不继承启动脚本、导出的函数、动态加载器、搜索配置和 Git 注入变量。 */
export function readOnlyShellEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: TRUSTED_PATH.join(':'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1',
  };
}
async function systemBinary(name: string): Promise<string | undefined> {
  for (const dir of TRUSTED_PATH) {
    const path = join(dir, name);
    try {
      const actual = await realpath(path);
      const stat = await lstat(actual);
      if (!stat.isFile()) continue;
      await access(actual, constants.X_OK);
      return actual;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return undefined;
}
export async function trustedShellPath(): Promise<string | undefined> { return systemBinary('bash'); }

interface Entry { raw: string; actual: string; exists: boolean; directory: boolean; regular: boolean; link: boolean; nlink: number }
class Boundary {
  readonly environment: Record<string, string> = {};
  readonly effects: Effect[] = [];
  readonly targets = new Set<string>();
  count = 0;
  constructor(readonly root: string, readonly entries: readonly string[], readonly signal: AbortSignal) {}
  async identity(path: string): Promise<Entry> {
    this.signal.throwIfAborted();
    if (++this.count > LIMIT) fail('shell_scope_limit');
    const raw = path.startsWith('/') ? path : `${this.root}/${path}`;
    try {
      const first = await lstat(raw, { bigint: true });
      const actual = await realpath(raw);
      const stat = await lstat(actual, { bigint: true });
      this.environment[`path:${raw}`] = `${actual}:${first.dev}:${first.ino}:${first.mode}:${first.size}:${first.mtimeNs}:${first.ctimeNs}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      return { raw, actual, exists: true, directory: stat.isDirectory(), regular: stat.isFile(), link: first.isSymbolicLink(), nlink: Number(stat.nlink) };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(raw);
      if (parent === raw) throw error;
      const ancestor = await this.identity(parent);
      const actual = join(ancestor.actual, basename(raw));
      this.environment[`path:${raw}`] = `missing:${actual}`;
      return { raw, actual, exists: false, directory: false, regular: false, link: false, nlink: 0 };
    }
  }
  scope(entry: Entry, kind: ReadKind): Scope {
    const gitMetadata = kind === 'git' && within(resolve(this.root, '.git'), entry.raw) && within(resolve(this.root, '.git'), entry.actual);
    if (kind !== 'metadata' && !gitMetadata && (sensitivePath(entry.raw, this.entries) || sensitivePath(entry.actual, this.entries))) return 'sensitive';
    return within(this.root, entry.raw) && within(this.root, entry.actual) ? 'project' : 'external';
  }
  async target(raw: string, kind: ReadKind): Promise<Entry> {
    if (foreignPath(raw)) fail('foreign_platform_path');
    const entry = await this.identity(raw.startsWith('/') ? raw : `${this.root}/${raw}`);
    const scope = this.scope(entry, kind);
    this.effects.push({ kind: 'read', target: entry.actual, scope });
    this.targets.add(entry.actual);
    if (kind !== 'metadata' && entry.exists && !entry.directory && (!entry.regular || entry.nlink !== 1)) fail(entry.nlink > 1 ? 'hardlink_alias_unverified' : 'shell_special_file');
    return entry;
  }
  async file(raw: string, kind: ReadKind = 'content'): Promise<void> {
    if (raw === '-') return; // 标准输入只能来自受同一 AST 验证的管道，或空输入。
    const entry = await this.target(raw, kind);
    if (entry.directory) fail('shell_directory_content_unverified');
  }
  /** 元数据与内容扫描不混淆；普通文件内容扫描从不悄悄删去敏感候选项。 */
  async tree(raw: string, kind: ReadKind, hidden = true, recursive = true, ignores = false): Promise<void> {
    const root = await this.target(raw, kind);
    if (!root.directory || !root.exists) return;
    const seen = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      this.signal.throwIfAborted();
      if (seen.has(dir)) return;
      seen.add(dir);
      if (ignores) await this.ignoreFiles(dir);
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!hidden && item.name.startsWith('.')) continue;
        const path = join(dir, item.name);
        // find -P、grep -r、rg --no-follow 不跟随遍历途中发现的符号链接。
        if (item.isSymbolicLink()) {
          if (kind === 'git') { await this.target(path, kind); fail('shell_git_symlink_unverified'); }
          await this.identity(path); continue;
        }
        const entry = await this.target(path, kind);
        if (entry.directory && recursive) await walk(entry.actual);
      }
    };
    await walk(root.actual);
  }
  async ignoreFiles(dir: string): Promise<void> {
    for (const name of ['.gitignore', '.ignore', '.rgignore', '.git/info/exclude']) {
      const entry = await this.identity(join(dir, name));
      if (entry.exists) await this.file(entry.raw, name === '.git/info/exclude' ? 'git' : 'content');
    }
  }
  async binary(name: string): Promise<string> {
    const path = await systemBinary(name);
    if (!path || within(this.root, path)) fail('shell_binary_unavailable');
    await this.identity(path!);
    return path!;
  }
}

type ValueRule = RegExp | readonly string[] | ((value: string) => boolean);
interface Spec { short?: string; long?: readonly string[]; shortValues?: Record<string, ValueRule>; longValues?: Record<string, ValueRule>; optionalLong?: Record<string, ValueRule> }
interface Options { operands: string[]; flags: Set<string>; values: Map<string, string[]> }
const number = /^\d+$/;
const amount = /^[+-]?\d+(?:[bBkKmMgGtTpPeEzZyY]|[KMGTPEZY]i?B?)?$/;
const textValue = (value: string) => value.length > 0 && !value.includes('\0');
function permitted(value: string, rule: ValueRule): boolean { return rule instanceof RegExp ? rule.test(value) : typeof rule === 'function' ? rule(value) : rule.includes(value); }
function options(args: readonly string[], spec: Spec): Options {
  const result: Options = { operands: [], flags: new Set(), values: new Map() };
  let ended = false;
  const value = (flag: string, arg: string | undefined, rule: ValueRule) => {
    if (arg === undefined || !permitted(arg, rule)) fail('shell_option_value_unverified');
    result.flags.add(flag); result.values.set(flag, [...(result.values.get(flag) ?? []), arg!]);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (ended || arg === '-' || !arg.startsWith('-')) { result.operands.push(arg); continue; }
    if (arg === '--') { ended = true; continue; }
    if (arg.startsWith('--')) {
      const at = arg.indexOf('='); const flag = at < 0 ? arg : arg.slice(0, at); const inline = at < 0 ? undefined : arg.slice(at + 1);
      if (spec.long?.includes(flag) && inline === undefined) { result.flags.add(flag); continue; }
      const rule = spec.longValues?.[flag];
      if (rule) { value(flag, inline ?? args[++i], rule); continue; }
      const optional = spec.optionalLong?.[flag];
      if (optional) { result.flags.add(flag); if (inline !== undefined) value(flag, inline, optional); continue; }
      fail('shell_option_not_supported');
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = `-${arg[j]}`; const rule = spec.shortValues?.[arg[j]];
      if (rule) { value(flag, arg.slice(j + 1) || args[++i], rule); break; }
      if (!spec.short?.includes(arg[j])) fail('shell_option_not_supported');
      result.flags.add(flag);
    }
  }
  return result;
}
const anyFlag = (parsed: Options, ...flags: string[]) => flags.some((flag) => parsed.flags.has(flag));
const allValues = (parsed: Options, ...flags: string[]) => flags.flatMap((flag) => parsed.values.get(flag) ?? []);

async function simpleCommand(name: string, args: string[], boundary: Boundary, piped: boolean): Promise<string[]> {
  if (name === 'pwd') {
    if (args.some((arg) => !['-L', '-P'].includes(arg))) fail('shell_option_not_supported');
    await boundary.target('.', 'metadata'); return args;
  }
  if (name === 'echo') return args;
  if (name === 'printf') {
    if (!['%s', '%s\\n'].includes(args[0] ?? '')) fail('shell_printf_format');
    return args;
  }
  if (name === 'ls') {
    const parsed = options(args, { short: 'aAlhtrSUXdisFpQq1mxCnogBNbcuvR', long: ['--all', '--almost-all', '--directory', '--human-readable', '--inode', '--numeric-uid-gid', '--recursive', '--reverse', '--size', '--classify', '--literal', '--quote-name', '--hide-control-chars'],
      shortValues: { I: textValue, w: number, T: number }, longValues: { '--ignore': textValue, '--hide': textValue, '--width': number, '--tabsize': number, '--sort': ['none', 'size', 'time', 'version', 'extension'], '--time': ['atime', 'access', 'use', 'ctime', 'status', 'birth', 'creation'], '--format': ['across', 'commas', 'horizontal', 'long', 'single-column', 'verbose', 'vertical'], '--quoting-style': ['literal', 'shell', 'shell-always', 'shell-escape', 'shell-escape-always', 'c', 'escape'] },
      optionalLong: { '--color': ['always', 'auto', 'never'], '--hyperlink': ['never'] } });
    for (const path of parsed.operands.length ? parsed.operands : ['.']) {
      if (anyFlag(parsed, '-d', '--directory')) await boundary.target(path, 'metadata');
      else await boundary.tree(path, 'metadata', true, anyFlag(parsed, '-R', '--recursive'));
    }
    return args;
  }
  if (name === 'cat' || name === 'head' || name === 'tail' || name === 'wc') {
    const specs: Record<string, Spec> = {
      cat: { short: 'AbEnstTuv', long: ['--show-all', '--number-nonblank', '--show-ends', '--number', '--squeeze-blank', '--show-tabs', '--show-nonprinting'] },
      head: { short: 'qvz', shortValues: { n: amount, c: amount }, long: ['--quiet', '--silent', '--verbose', '--zero-terminated'], longValues: { '--lines': amount, '--bytes': amount } },
      tail: { short: 'qvz', shortValues: { n: amount, c: amount }, long: ['--quiet', '--silent', '--verbose', '--zero-terminated'], longValues: { '--lines': amount, '--bytes': amount } },
      wc: { short: 'clmwL', long: ['--bytes', '--chars', '--lines', '--words', '--max-line-length'] },
    };
    const parsed = options(args, specs[name]);
    for (const path of parsed.operands) await boundary.file(path);
    return args;
  }
  if (name === 'find') return findCommand(args, boundary);
  if (name === 'grep' || name === 'rg') return searchCommand(name, args, boundary, piped);
  if (name === 'git') return gitCommand(args, boundary);
  return fail('shell_command_not_supported');
}

async function findCommand(args: string[], boundary: Boundary): Promise<string[]> {
  const roots: string[] = []; let i = 0;
  if (args[0] === '-P') i++;
  for (; i < args.length && !args[i].startsWith('-') && !['!', '(', ')', ','].includes(args[i]); i++) roots.push(args[i]);
  const flags = new Set(['-print', '-print0', '-ls', '-prune', '-quit', '-true', '-false', '-a', '-and', '-o', '-or', '-not', '!', '(', ')', ',', '-depth', '-xdev', '-mount', '-daystart', '-noleaf', '-ignore_readdir_race', '-noignore_readdir_race']);
  const values: Record<string, ValueRule> = { '-name': textValue, '-iname': textValue, '-path': textValue, '-ipath': textValue, '-wholename': textValue, '-iwholename': textValue, '-regex': textValue, '-iregex': textValue, '-type': /^[bcdpflsD]$/, '-maxdepth': number, '-mindepth': number, '-size': amount, '-mtime': /^[+-]?\d+$/, '-mmin': /^[+-]?\d+$/, '-atime': /^[+-]?\d+$/, '-amin': /^[+-]?\d+$/, '-ctime': /^[+-]?\d+$/, '-cmin': /^[+-]?\d+$/, '-links': /^[+-]?\d+$/, '-inum': /^[+-]?\d+$/, '-uid': /^[+-]?\d+$/, '-gid': /^[+-]?\d+$/, '-perm': /^[-/]?[0-7]{1,4}$/, '-printf': textValue, '-regextype': ['emacs', 'posix-awk', 'awk', 'posix-basic', 'posix-egrep', 'egrep', 'posix-extended'] };
  for (; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) continue;
    if (arg === '-newer' || arg === '-anewer' || arg === '-cnewer' || arg === '-samefile') {
      const path = args[++i]; if (!path) fail('shell_option_value_unverified'); await boundary.target(path, 'metadata'); continue;
    }
    const rule = values[arg]; if (!rule || args[i + 1] === undefined || !permitted(args[++i], rule)) fail('shell_option_not_supported');
  }
  for (const root of roots.length ? roots : ['.']) await boundary.tree(root, 'metadata');
  return args;
}

async function searchCommand(name: string, args: string[], boundary: Boundary, piped: boolean): Promise<string[]> {
  const grep: Spec = { short: 'EFGPinwxlLcqsvHhobaIzrZ', shortValues: { e: textValue, f: textValue, A: number, B: number, C: number, m: number, d: ['read', 'skip', 'recurse'], D: ['skip'] },
    long: ['--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--ignore-case', '--no-ignore-case', '--word-regexp', '--line-regexp', '--line-number', '--with-filename', '--no-filename', '--only-matching', '--quiet', '--silent', '--invert-match', '--count', '--files-with-matches', '--files-without-match', '--no-messages', '--text', '--binary', '--initial-tab', '--null', '--null-data', '--recursive', '--line-buffered'],
    longValues: { '--regexp': textValue, '--file': textValue, '--after-context': number, '--before-context': number, '--context': number, '--max-count': number, '--directories': ['read', 'skip', 'recurse'], '--devices': ['skip'], '--binary-files': ['binary', 'text', 'without-match'], '--include': textValue, '--exclude': textValue, '--exclude-dir': textValue },
    optionalLong: { '--color': ['always', 'auto', 'never'], '--colour': ['always', 'auto', 'never'] } };
  const rg: Spec = { short: 'FUivwxlLcqsnNoHaIS', shortValues: { E: ['auto', 'none', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'latin1', 'ascii'], e: textValue, f: textValue, A: number, B: number, C: number, m: number, g: textValue, t: textValue, T: textValue, j: number, M: number },
    long: ['--fixed-strings', '--ignore-case', '--case-sensitive', '--smart-case', '--word-regexp', '--line-regexp', '--line-number', '--no-line-number', '--column', '--with-filename', '--no-filename', '--heading', '--no-heading', '--only-matching', '--quiet', '--invert-match', '--count', '--count-matches', '--files-with-matches', '--files-without-match', '--no-messages', '--text', '--null', '--null-data', '--line-buffered', '--crlf', '--multiline', '--multiline-dotall', '--pcre2', '--no-unicode', '--unicode', '--stats', '--json', '--trim', '--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-parent', '--no-ignore-dot', '--no-ignore-exclude', '--no-ignore-global', '--no-config', '--no-follow', '--no-pre'],
    longValues: { '--regexp': textValue, '--file': textValue, '--after-context': number, '--before-context': number, '--context': number, '--max-count': number, '--glob': textValue, '--iglob': textValue, '--type': textValue, '--type-not': textValue, '--threads': number, '--max-columns': number, '--max-depth': number, '--max-filesize': amount, '--color': ['always', 'auto', 'never', 'ansi'], '--encoding': ['auto', 'none', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'latin1', 'ascii'], '--engine': ['default', 'pcre2', 'auto'], '--sort': ['path', 'modified', 'accessed', 'created', 'none'], '--sortr': ['path', 'modified', 'accessed', 'created', 'none'], '--replace': textValue } };
  const parsed = options(args, name === 'grep' ? grep : rg);
  // -L 对 grep 是输出文件名；对 rg 是跟随链接，不能误用共享选项表。
  if (name === 'rg' && anyFlag(parsed, '-L')) fail('shell_follow_not_supported');
  const patternFiles = allValues(parsed, '-f', '--file');
  for (const path of patternFiles) await boundary.file(path);
  const paths = [...parsed.operands];
  if (!allValues(parsed, '-e', '--regexp').length && !patternFiles.length) { if (!paths.length) fail('shell_missing_pattern'); paths.shift(); }
  const recursive = name === 'rg' || anyFlag(parsed, '-r', '--recursive') || allValues(parsed, '-d', '--directories').includes('recurse');
  if (!paths.length && recursive && (name === 'grep' || !piped || patternFiles.includes('-'))) paths.push('.');
  for (const path of paths) {
    if (path === '-') continue;
    const entry = await boundary.target(path, 'content');
    if (!entry.directory) continue;
    if (!recursive) { if (allValues(parsed, '-d', '--directories').includes('skip')) continue; fail('shell_directory_content_unverified'); }
    // 过滤器/ignore 规则只减少候选；这里取保守超集，敏感候选要求确认，原命令不被重写成删减文件列表。
    if (name === 'rg') {
      let ancestor = entry.actual;
      while (true) { await boundary.ignoreFiles(ancestor); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
    }
    await boundary.tree(path, 'content', name === 'grep' || anyFlag(parsed, '--hidden', '-g', '--glob', '--iglob'), true, name === 'rg');
  }
  return name === 'rg' ? ['--no-config', '--no-follow', '--no-pre', '--no-ignore-global', ...args] : args;
}

/** 让受信任 Git 解析自身索引；固定只读参数不加载项目脚本。 */
const execFileAsync = promisify(execFile);
async function gitTrackedPaths(boundary: Boundary, tree = false): Promise<string[]> {
  const binary = await boundary.binary('git');
  const { stdout } = await execFileAsync(binary, [...GIT_SAFE_OPTIONS, ...(tree ? ['ls-tree', '-r', '-z', 'HEAD'] : ['ls-files', '--cached', '--stage', '-z'])], {
    cwd: boundary.root, env: readOnlyShellEnvironment(), signal: boundary.signal, timeout: 5_000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer',
  });
  const text = stdout.toString('utf8');
  if (!Buffer.from(text).equals(stdout)) fail('shell_git_filename_unverified');
  const result: string[] = [];
  for (const record of text.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'); const header = record.slice(0, tab); const name = record.slice(tab + 1);
    if (tab < 0 || !(tree ? /^(?:100644|100755|120000|160000) (?:blob|commit) [a-f0-9]+$/ : /^(?:100644|100755|120000|160000) [a-f0-9]+ [0-3]$/).test(header)) fail('shell_git_index_unverified');
    if (header.startsWith('160000 ')) fail('shell_git_submodule_unverified');
    if (name.startsWith('/') || name.split('/').some((part) => !part || part === '.' || part === '..') || name.includes('\\')) fail('shell_git_filename_unverified');
    result.push(name);
  }
  return [...new Set(result)].sort();
}
const GIT_SAFE_OPTIONS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'diff.external=', '-c', 'diff.trustExitCode=false', '-c', 'diff.orderFile=/dev/null', '-c', 'submodule.recurse=false', '-c', 'core.quotePath=true'];
async function gitCommand(args: string[], boundary: Boundary): Promise<string[]> {
  const subcommand = args[0];
  if (subcommand !== 'status' && subcommand !== 'diff') fail('shell_git_command_not_supported');
  let paths: string[] = [];
  if (subcommand === 'status') {
    const parsed = options(args.slice(1), { short: 'sbz', long: ['--short', '--branch', '--show-stash', '--long', '--verbose', '--no-renames', '--renames', '--null'], shortValues: { u: ['no', 'normal', 'all'] }, optionalLong: { '--porcelain': ['1', '2', 'v1', 'v2'], '--untracked-files': ['no', 'normal', 'all'], '--ignored': ['traditional', 'matching', 'no'], '--ignore-submodules': ['all'] } });
    paths = parsed.operands;
    // status -v 输出 diff，不能把它当纯文件名枚举。
    if (anyFlag(parsed, '--verbose')) fail('shell_git_option_not_supported');
  } else {
    const separator = args.indexOf('--');
    const flags = separator < 0 ? args.slice(1) : args.slice(1, separator);
    paths = separator < 0 ? [] : args.slice(separator + 1);
    const parsed = options(flags, { short: 'pUswbz', long: ['--patch', '--no-patch', '--raw', '--numstat', '--shortstat', '--stat', '--summary', '--name-only', '--name-status', '--check', '--binary', '--full-index', '--abbrev', '--no-prefix', '--relative', '--text', '--ignore-space-at-eol', '--ignore-space-change', '--ignore-all-space', '--ignore-blank-lines', '--exit-code', '--quiet', '--cached', '--staged', '--no-renames', '--minimal', '--patience', '--histogram', '--no-ext-diff', '--no-textconv'],
      shortValues: { U: number }, longValues: { '--unified': number, '--inter-hunk-context': number, '--diff-algorithm': ['myers', 'minimal', 'patience', 'histogram'], '--diff-filter': /^[ACDMRTUXBacdmrtuxb*]+$/, '--src-prefix': textValue, '--dst-prefix': textValue, '--line-prefix': textValue }, optionalLong: { '--color': ['always', 'auto', 'never'], '--word-diff': ['color', 'plain', 'porcelain', 'none'], '--ignore-submodules': ['all'] } });
    // 版本参数可能读取任意历史树；只支持明确的 HEAD 或当前索引/工作区。
    if (parsed.operands.some((arg) => arg !== 'HEAD') || parsed.operands.length > 1) fail('shell_git_revision_unverified');
  }
  const gitDir = await boundary.target('.git', 'git');
  if (!gitDir.exists || !gitDir.directory || gitDir.link || !within(boundary.root, gitDir.actual)) fail('shell_git_repository_unverified');
  // gitfile/worktree/alternates 都可能把对象或配置解析转到项目外。
  for (const name of ['commondir', 'gitdir', 'objects/info/alternates', 'objects/info/http-alternates']) {
    if ((await boundary.identity(join(gitDir.actual, name))).exists) fail('shell_git_repository_unverified');
  }
  // 只验证 Git 使用的固定入口；禁用的 hooks 与整个对象库不是待执行代码，不能每次全量遍历。
  for (const name of ['index', 'HEAD', 'packed-refs', 'refs', 'objects', 'info', 'info/attributes', 'info/exclude']) {
    const entry = await boundary.target(join(gitDir.actual, name), 'git');
    if (entry.link || !within(gitDir.actual, entry.actual)) fail('shell_git_symlink_unverified');
  }
  for (const name of ['config', 'config.worktree']) {
    const entry = await boundary.target(join(gitDir.actual, name), 'git');
    if (!entry.exists) continue;
    if (!entry.regular || entry.nlink !== 1 || entry.link || !within(gitDir.actual, entry.actual)) fail('shell_git_configuration_unverified');
    if ((await lstat(entry.actual)).size > 256 * 1024) fail('shell_git_configuration_unverified');
    const text = await readFile(entry.actual, { encoding: 'utf8', signal: boundary.signal });
    if (text.length > 256 * 1024 || /\\\r?\n/.test(text)) fail('shell_git_configuration_unverified');
    const sections = [...text.matchAll(/^\s*\[([^\]]+)\]/gm)].map((match) => match[1].trim().toLowerCase());
    if (sections.some((section) => /^(?:include|includeif|extensions|filter)(?:\s|\.|$)/.test(section)) || /^\s*(?:promisor|partialclonefilter)\s*=/im.test(text)) fail('shell_git_configuration_unverified');
    // 配置文件只允许常见声明式节；local config 也不能改变仓库根或对象读取位置。
    if (sections.some((section) => !/^(?:core|remote|branch|user|push|pull|fetch|diff|merge|status|color|advice|init|credential|filter|submodule|alias|url)(?:\s|\.|$)/.test(section)) || /^\s*(?:worktree|attributesfile|excludesfile)\s*=/im.test(text) || /^\s*bare\s*=\s*true\s*(?:[#;].*)?$/im.test(text)) fail('shell_git_configuration_unverified');
  }
  if (subcommand === 'diff') {
    // diff 会输出对象内容，额外验证对象/引用存储；超过扫描预算时明确回退，不假定外部对象安全。
    await boundary.tree(join(gitDir.actual, 'objects'), 'git');
    await boundary.tree(join(gitDir.actual, 'refs'), 'git');
  }
  const tracked = await gitTrackedPaths(boundary);
  if (subcommand === 'diff' && args.some((arg) => ['HEAD', '--cached', '--staged'].includes(arg))) tracked.push(...await gitTrackedPaths(boundary, true));
  for (const path of paths) {
    if (path.startsWith(':') || /[*?[\]]/.test(path)) fail('shell_git_pathspec_unverified');
    const entry = await boundary.target(path, subcommand === 'diff' ? 'content' : 'metadata');
    if (entry.directory && subcommand === 'diff') await boundary.tree(path, 'content');
  }
  const selected = (path: string) => paths.length === 0 || paths.some((base) => within(resolve(boundary.root, base), resolve(boundary.root, path)));
  for (const path of tracked.filter(selected)) {
    const entry = await boundary.target(path, subcommand === 'status' ? 'metadata' : 'content');
    if (entry.regular && entry.nlink !== 1) fail('hardlink_alias_unverified');
    // Git 的符号链接内容是链接文本，不应解引用到另一个文件；保守升级任何链接。
    if (entry.link) fail('shell_git_symlink_unverified');
    if (entry.directory) fail('shell_git_submodule_unverified');
  }
  // ignore/attributes 是 Git 可能读取的项目配置，不执行其中指令；仍验证其物理边界。
  const configDirs = new Set([boundary.root]);
  for (const path of tracked) {
    let dir = dirname(resolve(boundary.root, path));
    while (within(boundary.root, dir)) { configDirs.add(dir); if (dir === boundary.root) break; dir = dirname(dir); }
  }
  // status 的未跟踪文件遍历仅产生文件名/状态；不扫描已被 Git 排除的 node_modules 等目录。
  for (const dir of [...configDirs].sort()) {
    for (const name of ['.gitignore', '.gitattributes']) {
      const entry = await boundary.identity(join(dir, name));
      if (entry.exists) await boundary.file(entry.raw);
    }
  }
  return [...GIT_SAFE_OPTIONS, subcommand, ...(subcommand === 'diff' ? ['--no-ext-diff', '--no-textconv'] : []), ...args.slice(1)];
}

/** 解码仅发生在 AST 已证明为字面量的节点；不另写 Shell 词法器。 */
function literal(node: Parser.SyntaxNode): string {
  switch (node.type) {
    case 'command_name':
      if (node.namedChildCount !== 1) return fail('shell_dynamic_command');
      return literal(node.namedChildren[0]);
    case 'raw_string': return node.text.slice(1, -1);
    case 'string':
      if (node.namedChildren.some((child) => child.type !== 'string_content')) return fail('shell_expansion');
      return node.text.slice(1, -1).replace(/\\([$`"\\\n])/g, (_match, char: string) => char === '\n' ? '' : char);
    case 'concatenation': return node.namedChildren.map(literal).join('');
    case 'number':
    case 'word': {
      // 去掉已经由 Bash AST 识别的转义对再检查展开符；引号内的通配符保持字面量。
      const unescaped = node.text.replace(/\\[\s\S]/g, '');
      if (/[*?[\]{}~$`]/.test(unescaped)) return fail('shell_expansion');
      return node.text.replace(/\\\n/g, '').replace(/\\([\s\S])/g, '$1');
    }
    default: return fail(`shell_unresolved_${node.type}`);
  }
}

export async function analyzeReadOnlyShell(command: string, cwd: string, pluginEntries: readonly string[], signal: AbortSignal): Promise<ReadOnlyShellAnalysis> {
  signal.throwIfAborted();
  const unresolved: string[] = []; const commands: string[][] = [];
  const empty = (reasonCode: string): ReadOnlyShellAnalysis => ({ complete: false, reasonCode, effects: [{ kind: 'unknown', scope: 'unknown' }], targets: [], environment: {}, commands, unresolved: [reasonCode] });
  if (typeof command !== 'string' || !command.trim() || command.length > 32_768 || command.includes('\0')) return empty('shell_input_limit');
  if (process.platform === 'win32') return empty('native_windows_unverified');
  if (/\\\r?\n/.test(command)) unresolved.push('shell_line_continuation_unverified');
  const boundary = new Boundary(await realpath(resolve(cwd)), await searchPluginEntries(cwd, pluginEntries), signal);
  const parser = new Parser(); parser.setLanguage(Bash);
  let tree: Parser.Tree;
  try { tree = parser.parse(command); } catch { return empty('shell_parse_error'); }
  const normalized = new Map<number, string>();
  const record = (error: unknown) => {
    signal.throwIfAborted();
    unresolved.push(error instanceof Unverified ? error.reasonCode : 'shell_filesystem_unverified');
  };
  try { await boundary.binary('bash'); await boundary.target('.', 'metadata'); } catch (error) { record(error); }
  let nodes = 0;
  const collect = async (node: Parser.SyntaxNode, piped = false): Promise<void> => {
    signal.throwIfAborted(); if (++nodes > 4096) fail('shell_ast_limit');
    if (node.type === 'command') {
      try {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) fail('shell_dynamic_command');
        const name = literal(nameNode!);
        const argNodes = node.namedChildren.filter((child) => child.id !== nameNode!.id && child.type !== 'variable_assignment');
        const args = argNodes.map(literal);
        commands.push([name, ...args]);
        if (name.includes('/')) fail('shell_command_path_unverified');
        const argv = await simpleCommand(name, args, boundary, piped);
        const prefix = ['echo', 'pwd', 'printf'].includes(name) ? ['builtin', name] : [await boundary.binary(name)];
        normalized.set(node.id, [...prefix, ...argv].map(quote).join(' '));
        if (node.namedChildren.some((child) => child.type === 'variable_assignment')) fail('shell_assignment');
      } catch (error) { record(error); }
    }
    for (let i = 0; i < node.namedChildren.length; i++) await collect(node.namedChildren[i], node.type === 'pipeline' ? i > 0 : piped);
  };
  try { await collect(tree.rootNode); } catch (error) { record(error); }
  const render = (node: Parser.SyntaxNode): string => {
    if (node.hasError || node.isMissing) return fail('shell_parse_error');
    if (node.type === 'comment') return '';
    if (node.type === 'command') {
      if (node.namedChildren.some((child) => child.type === 'variable_assignment')) return fail('shell_assignment');
      return normalized.get(node.id) ?? fail('shell_command_unverified');
    }
    if (node.type === 'program') {
      if (node.children.some((child) => !child.isNamed && ![';', '\n'].includes(child.type))) return fail('shell_async_or_control');
      return node.namedChildren.map(render).filter(Boolean).join('; ');
    }
    if (node.type === 'list' || node.type === 'pipeline') {
      const parts: string[] = [];
      for (const child of node.children) {
        if (child.isNamed) parts.push(render(child));
        else if (node.type === 'list' && ['&&', '||'].includes(child.type) || node.type === 'pipeline' && child.type === '|') parts.push(child.type);
        else return fail('shell_async_or_control');
      }
      return parts.join(' ');
    }
    return fail(`shell_unresolved_${node.type}`);
  };
  let safeCommand: string | undefined;
  try { safeCommand = render(tree.rootNode); if (!safeCommand) fail('shell_empty_command'); } catch (error) { record(error); }
  if (tree.rootNode.hasError) unresolved.push('shell_parse_error');
  const complete = unresolved.length === 0 && Boolean(safeCommand);
  const effects = [...new Map(boundary.effects.map((effect) => [`${effect.kind}:${effect.scope}:${effect.target}`, effect])).values()];
  if (!complete) effects.push({ kind: 'unknown', scope: 'unknown' });
  const reasonCode = !complete ? unresolved[0] ?? 'shell_unverified' : effects.some((effect) => effect.scope === 'sensitive') ? 'sensitive_path' : effects.some((effect) => effect.scope === 'external') ? 'outside_project' : 'bounded_readonly_shell';
  boundary.environment.$executionEnvironment = digest(readOnlyShellEnvironment());
  return { complete, reasonCode, effects, targets: [...boundary.targets].sort(), ...(complete ? { command: safeCommand } : {}),
    environment: Object.fromEntries(Object.entries(boundary.environment).sort(([a], [b]) => a.localeCompare(b))), commands, unresolved: [...new Set(unresolved)] };
}
