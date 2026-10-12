/**
 * bash 只读分析/执行契约：语法、选项、文件边界与宿主环境一起验证。
 * 只认 bash 语法树。Windows PowerShell 的命令形状在 powershell.ts，不要写进这里。
 */
import { access, lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import Parser from 'tree-sitter';
import Bash from 'tree-sitter-bash';
import { minimatch } from 'minimatch';
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
  /** Linux 执行门只继承这些已核验身份的描述符；不重新按动态输出打开文件。 */
  bindings?: ReadOnlyShellBinding[];
  pathFacts: ShellPathFact[];
}
export interface ShellPathFact {
  raw: string;
  actual: string;
  exists: boolean;
  kind: 'directory' | 'file' | 'special' | 'missing';
  symlink: boolean;
  nlink: number;
}
export interface ReadOnlyShellBinding {
  path: string;
  identity: string;
  kind: 'directory' | 'file' | 'discard';
}
class Unverified extends Error {
  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}
const fail = (reason: string): never => {
  throw new Unverified(reason);
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;

/** 不继承启动脚本、导出的函数、动态加载器、搜索配置和 Git 注入变量。 */
export function readOnlyShellEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: TRUSTED_PATH.join(':'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_LITERAL_PATHSPECS: '1',
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
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  return undefined;
}
export async function trustedShellPath(): Promise<string | undefined> {
  return systemBinary('bash');
}

interface Entry {
  raw: string;
  actual: string;
  exists: boolean;
  directory: boolean;
  regular: boolean;
  link: boolean;
  nlink: number;
  identity: string;
}
class Boundary {
  readonly environment: Record<string, string> = {};
  readonly effects: Effect[] = [];
  readonly targets = new Set<string>();
  readonly pathFacts = new Map<string, ShellPathFact>();
  count = 0;
  cwd: string;
  requiresBoundContent = false;
  constructor(
    readonly root: string,
    readonly entries: readonly string[],
    readonly signal: AbortSignal,
  ) {
    this.cwd = root;
  }
  async identity(path: string): Promise<Entry> {
    this.signal.throwIfAborted();
    if (++this.count > LIMIT) fail('shell_scope_limit');
    const raw = path.startsWith('/') ? path : `${this.cwd}/${path}`;
    try {
      const first = await lstat(raw, { bigint: true });
      const actual = await realpath(raw);
      const stat = await lstat(actual, { bigint: true });
      this.environment[`path:${raw}`] =
        `${actual}:${first.dev}:${first.ino}:${first.mode}:${first.size}:${first.mtimeNs}:${first.ctimeNs}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      this.pathFacts.set(raw, {
        raw,
        actual,
        exists: true,
        kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special',
        symlink: first.isSymbolicLink(),
        nlink: Number(stat.nlink),
      });
      return {
        raw,
        actual,
        exists: true,
        directory: stat.isDirectory(),
        regular: stat.isFile(),
        link: first.isSymbolicLink(),
        nlink: Number(stat.nlink),
        identity: `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}`,
      };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(raw);
      if (parent === raw) throw error;
      const ancestor = await this.identity(parent);
      const actual = join(ancestor.actual, basename(raw));
      this.environment[`path:${raw}`] = `missing:${actual}`;
      this.pathFacts.set(raw, {
        raw,
        actual,
        exists: false,
        kind: 'missing',
        symlink: false,
        nlink: 0,
      });
      return {
        raw,
        actual,
        exists: false,
        directory: false,
        regular: false,
        link: false,
        nlink: 0,
        identity: 'missing',
      };
    }
  }
  scope(entry: Entry, kind: ReadKind): Scope {
    const gitMetadata =
      kind === 'git' &&
      within(resolve(this.root, '.git'), entry.raw) &&
      within(resolve(this.root, '.git'), entry.actual);
    if (
      kind !== 'metadata' &&
      !gitMetadata &&
      (sensitivePath(entry.raw, this.entries) || sensitivePath(entry.actual, this.entries))
    )
      return 'sensitive';
    return within(this.root, entry.raw) && within(this.root, entry.actual) ? 'project' : 'external';
  }
  async target(raw: string, kind: ReadKind): Promise<Entry> {
    if (foreignPath(raw)) fail('foreign_platform_path');
    const entry = await this.identity(raw.startsWith('/') ? raw : `${this.cwd}/${raw}`);
    const scope = this.scope(entry, kind);
    this.effects.push({ kind: 'read', target: entry.actual, scope });
    this.targets.add(entry.actual);
    if (
      kind !== 'metadata' &&
      entry.exists &&
      !entry.directory &&
      (!entry.regular || entry.nlink !== 1)
    )
      fail(entry.nlink > 1 ? 'hardlink_alias_unverified' : 'shell_special_file');
    return entry;
  }
  async file(raw: string, kind: ReadKind = 'content'): Promise<void> {
    if (raw === '-') return; // 标准输入只能来自受同一 AST 验证的管道，或空输入。
    const entry = await this.target(raw, kind);
    if (entry.directory) fail('shell_directory_content_unverified');
  }
  /** 元数据与内容扫描不混淆；普通文件内容扫描从不悄悄删去敏感候选项。 */
  async tree(
    raw: string,
    kind: ReadKind,
    hidden = true,
    recursive = true,
    ignores = false,
  ): Promise<void> {
    const root = await this.target(raw, kind);
    if (!root.directory || !root.exists) return;
    const seen = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      this.signal.throwIfAborted();
      if (seen.has(dir)) return;
      seen.add(dir);
      if (ignores) await this.ignoreFiles(dir);
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!hidden && item.name.startsWith('.')) continue;
        const path = join(dir, item.name);
        // find -P、grep -r、rg --no-follow 不跟随遍历途中发现的符号链接。
        if (item.isSymbolicLink()) {
          if (kind === 'git') {
            await this.target(path, kind);
            fail('shell_git_symlink_unverified');
          }
          await this.identity(path);
          continue;
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
      if (entry.exists)
        await this.file(entry.raw, name === '.git/info/exclude' ? 'git' : 'content');
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
interface Spec {
  short?: string;
  long?: readonly string[];
  shortValues?: Record<string, ValueRule>;
  longValues?: Record<string, ValueRule>;
  optionalLong?: Record<string, ValueRule>;
}
interface Options {
  operands: string[];
  operandIndices: number[];
  flags: Set<string>;
  values: Map<string, string[]>;
}
const number = /^\d+$/;
const amount = /^[+-]?\d+(?:[bBkKmMgGtTpPeEzZyY]|[KMGTPEZY]i?B?)?$/;
const FILE_READ_SPECS: Record<string, Spec> = {
  cat: {
    short: 'AbEnstTuv',
    long: [
      '--show-all',
      '--number-nonblank',
      '--show-ends',
      '--number',
      '--squeeze-blank',
      '--show-tabs',
      '--show-nonprinting',
    ],
  },
  head: {
    short: 'qvz',
    shortValues: { n: amount, c: amount },
    long: ['--quiet', '--silent', '--verbose', '--zero-terminated'],
    longValues: { '--lines': amount, '--bytes': amount },
  },
  tail: {
    short: 'qvz',
    shortValues: { n: amount, c: amount },
    long: ['--quiet', '--silent', '--verbose', '--zero-terminated'],
    longValues: { '--lines': amount, '--bytes': amount },
  },
  wc: {
    short: 'clmwL',
    long: ['--bytes', '--chars', '--lines', '--words', '--max-line-length'],
  },
};

const textValue = (value: string) => value.length > 0 && !value.includes('\0');
function permitted(value: string, rule: ValueRule): boolean {
  return rule instanceof RegExp
    ? rule.test(value)
    : typeof rule === 'function'
      ? rule(value)
      : rule.includes(value);
}
function options(args: readonly string[], spec: Spec): Options {
  const result: Options = { operands: [], operandIndices: [], flags: new Set(), values: new Map() };
  let ended = false;
  const value = (flag: string, arg: string | undefined, rule: ValueRule) => {
    if (arg === undefined || !permitted(arg, rule)) fail('shell_option_value_unverified');
    result.flags.add(flag);
    result.values.set(flag, [...(result.values.get(flag) ?? []), arg!]);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (ended || arg === '-' || !arg.startsWith('-')) {
      result.operands.push(arg);
      result.operandIndices.push(i);
      continue;
    }
    if (arg === '--') {
      ended = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const at = arg.indexOf('=');
      const flag = at < 0 ? arg : arg.slice(0, at);
      const inline = at < 0 ? undefined : arg.slice(at + 1);
      if (spec.long?.includes(flag) && inline === undefined) {
        result.flags.add(flag);
        continue;
      }
      const rule = spec.longValues?.[flag];
      if (rule) {
        value(flag, inline ?? args[++i], rule);
        continue;
      }
      const optional = spec.optionalLong?.[flag];
      if (optional) {
        result.flags.add(flag);
        if (inline !== undefined) value(flag, inline, optional);
        continue;
      }
      fail('shell_option_not_supported');
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = `-${arg[j]}`;
      const rule = spec.shortValues?.[arg[j]];
      if (rule) {
        value(flag, arg.slice(j + 1) || args[++i], rule);
        break;
      }
      if (!spec.short?.includes(arg[j])) fail('shell_option_not_supported');
      result.flags.add(flag);
    }
  }
  return result;
}
const anyFlag = (parsed: Options, ...flags: string[]) =>
  flags.some((flag) => parsed.flags.has(flag));
const allValues = (parsed: Options, ...flags: string[]) =>
  flags.flatMap((flag) => parsed.values.get(flag) ?? []);

async function simpleCommand(
  name: string,
  args: string[],
  boundary: Boundary,
  piped: boolean,
): Promise<string[]> {
  if (name === 'pwd') {
    if (args.some((arg) => !['-L', '-P'].includes(arg))) fail('shell_option_not_supported');
    await boundary.target('.', 'metadata');
    return args;
  }
  if (name === 'echo') return args;
  if (name === 'printf') {
    if (!['%s', '%s\\n'].includes(args[0] ?? '')) fail('shell_printf_format');
    return args;
  }
  if (name === 'ls') {
    const parsed = options(args, {
      short: 'aAlhtrSUXdisFpQq1mxCnogBNbcuvR',
      long: [
        '--all',
        '--almost-all',
        '--directory',
        '--human-readable',
        '--inode',
        '--numeric-uid-gid',
        '--recursive',
        '--reverse',
        '--size',
        '--classify',
        '--literal',
        '--quote-name',
        '--hide-control-chars',
      ],
      shortValues: { I: textValue, w: number, T: number },
      longValues: {
        '--ignore': textValue,
        '--hide': textValue,
        '--width': number,
        '--tabsize': number,
        '--sort': ['none', 'size', 'time', 'version', 'extension'],
        '--time': ['atime', 'access', 'use', 'ctime', 'status', 'birth', 'creation'],
        '--format': [
          'across',
          'commas',
          'horizontal',
          'long',
          'single-column',
          'verbose',
          'vertical',
        ],
        '--quoting-style': [
          'literal',
          'shell',
          'shell-always',
          'shell-escape',
          'shell-escape-always',
          'c',
          'escape',
        ],
      },
      optionalLong: { '--color': ['always', 'auto', 'never'], '--hyperlink': ['never'] },
    });
    if (
      boundary.requiresBoundContent &&
      (parsed.operands.some((path) => path !== '.') || anyFlag(parsed, '-R', '--recursive'))
    )
      fail('shell_literal_metadata_binding_unverified');
    for (const path of parsed.operands.length ? parsed.operands : ['.']) {
      if (anyFlag(parsed, '-d', '--directory')) await boundary.target(path, 'metadata');
      else await boundary.tree(path, 'metadata', true, anyFlag(parsed, '-R', '--recursive'));
    }
    return args;
  }
  if (name === 'cat' || name === 'head' || name === 'tail' || name === 'wc') {
    // GNU/BSD 的常见旧式行数写法仍是静态选项，不把负数识别成文件路径。
    const checked =
      (name === 'head' || name === 'tail') && /^-\d+$/.test(args[0] ?? '')
        ? ['-n', args[0].slice(1), ...args.slice(1)]
        : args;
    const parsed = options(checked, FILE_READ_SPECS[name]);
    for (const path of parsed.operands) await boundary.file(path);
    return args;
  }
  if (name === 'find') {
    if (boundary.requiresBoundContent) fail('shell_find_expression_binding_unverified');
    return findCommand(args, boundary);
  }
  if (name === 'grep' || name === 'rg') return searchCommand(name, args, boundary, piped);
  if (name === 'git') {
    if (boundary.requiresBoundContent) fail('shell_literal_read_binding_unverified');
    return gitCommand(args, boundary);
  }
  return fail('shell_command_not_supported');
}

async function findCommand(args: string[], boundary: Boundary): Promise<string[]> {
  const roots: string[] = [];
  let i = 0;
  if (args[0] === '-P') i++;
  for (
    ;
    i < args.length && !args[i].startsWith('-') && !['!', '(', ')', ','].includes(args[i]);
    i++
  )
    roots.push(args[i]);
  const flags = new Set([
    '-print',
    '-print0',
    '-ls',
    '-prune',
    '-quit',
    '-true',
    '-false',
    '-a',
    '-and',
    '-o',
    '-or',
    '-not',
    '!',
    '(',
    ')',
    ',',
    '-depth',
    '-xdev',
    '-mount',
    '-daystart',
    '-noleaf',
    '-ignore_readdir_race',
    '-noignore_readdir_race',
  ]);
  const values: Record<string, ValueRule> = {
    '-name': textValue,
    '-iname': textValue,
    '-path': textValue,
    '-ipath': textValue,
    '-wholename': textValue,
    '-iwholename': textValue,
    '-regex': textValue,
    '-iregex': textValue,
    '-type': /^[bcdpflsD]$/,
    '-maxdepth': number,
    '-mindepth': number,
    '-size': amount,
    '-mtime': /^[+-]?\d+$/,
    '-mmin': /^[+-]?\d+$/,
    '-atime': /^[+-]?\d+$/,
    '-amin': /^[+-]?\d+$/,
    '-ctime': /^[+-]?\d+$/,
    '-cmin': /^[+-]?\d+$/,
    '-links': /^[+-]?\d+$/,
    '-inum': /^[+-]?\d+$/,
    '-uid': /^[+-]?\d+$/,
    '-gid': /^[+-]?\d+$/,
    '-perm': /^[-/]?[0-7]{1,4}$/,
    '-printf': textValue,
    '-regextype': [
      'emacs',
      'posix-awk',
      'awk',
      'posix-basic',
      'posix-egrep',
      'egrep',
      'posix-extended',
    ],
  };
  for (; i < args.length; i++) {
    const arg = args[i];
    if (flags.has(arg)) continue;
    if (arg === '-newer' || arg === '-anewer' || arg === '-cnewer' || arg === '-samefile') {
      const path = args[++i];
      if (!path) fail('shell_option_value_unverified');
      await boundary.target(path, 'metadata');
      continue;
    }
    const rule = values[arg];
    if (!rule || args[i + 1] === undefined || !permitted(args[++i], rule))
      fail('shell_option_not_supported');
  }
  for (const root of roots.length ? roots : ['.']) await boundary.tree(root, 'metadata');
  return args;
}

async function searchCommand(
  name: string,
  args: string[],
  boundary: Boundary,
  piped: boolean,
): Promise<string[]> {
  const grep: Spec = {
    short: 'EFGPinwxlLcqsvHhobaIzrZ',
    shortValues: {
      e: textValue,
      f: textValue,
      A: number,
      B: number,
      C: number,
      m: number,
      d: ['read', 'skip', 'recurse'],
      D: ['skip'],
    },
    long: [
      '--extended-regexp',
      '--fixed-strings',
      '--basic-regexp',
      '--perl-regexp',
      '--ignore-case',
      '--no-ignore-case',
      '--word-regexp',
      '--line-regexp',
      '--line-number',
      '--with-filename',
      '--no-filename',
      '--only-matching',
      '--quiet',
      '--silent',
      '--invert-match',
      '--count',
      '--files-with-matches',
      '--files-without-match',
      '--no-messages',
      '--text',
      '--binary',
      '--initial-tab',
      '--null',
      '--null-data',
      '--recursive',
      '--line-buffered',
    ],
    longValues: {
      '--regexp': textValue,
      '--file': textValue,
      '--after-context': number,
      '--before-context': number,
      '--context': number,
      '--max-count': number,
      '--directories': ['read', 'skip', 'recurse'],
      '--devices': ['skip'],
      '--binary-files': ['binary', 'text', 'without-match'],
      '--include': textValue,
      '--exclude': textValue,
      '--exclude-dir': textValue,
    },
    optionalLong: {
      '--color': ['always', 'auto', 'never'],
      '--colour': ['always', 'auto', 'never'],
    },
  };
  const rg: Spec = {
    short: 'FUivwxlLcqsnNoHaIS',
    shortValues: {
      E: ['auto', 'none', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'latin1', 'ascii'],
      e: textValue,
      f: textValue,
      A: number,
      B: number,
      C: number,
      m: number,
      g: textValue,
      t: textValue,
      T: textValue,
      j: number,
      M: number,
    },
    long: [
      '--fixed-strings',
      '--ignore-case',
      '--case-sensitive',
      '--smart-case',
      '--word-regexp',
      '--line-regexp',
      '--line-number',
      '--no-line-number',
      '--column',
      '--with-filename',
      '--no-filename',
      '--heading',
      '--no-heading',
      '--only-matching',
      '--quiet',
      '--invert-match',
      '--count',
      '--count-matches',
      '--files-with-matches',
      '--files-without-match',
      '--no-messages',
      '--text',
      '--null',
      '--null-data',
      '--line-buffered',
      '--crlf',
      '--multiline',
      '--multiline-dotall',
      '--pcre2',
      '--no-unicode',
      '--unicode',
      '--stats',
      '--json',
      '--trim',
      '--hidden',
      '--no-ignore',
      '--no-ignore-vcs',
      '--no-ignore-parent',
      '--no-ignore-dot',
      '--no-ignore-exclude',
      '--no-ignore-global',
      '--no-config',
      '--no-follow',
      '--no-pre',
    ],
    longValues: {
      '--regexp': textValue,
      '--file': textValue,
      '--after-context': number,
      '--before-context': number,
      '--context': number,
      '--max-count': number,
      '--glob': textValue,
      '--iglob': textValue,
      '--type': textValue,
      '--type-not': textValue,
      '--threads': number,
      '--max-columns': number,
      '--max-depth': number,
      '--max-filesize': amount,
      '--color': ['always', 'auto', 'never', 'ansi'],
      '--encoding': ['auto', 'none', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be', 'latin1', 'ascii'],
      '--engine': ['default', 'pcre2', 'auto'],
      '--sort': ['path', 'modified', 'accessed', 'created', 'none'],
      '--sortr': ['path', 'modified', 'accessed', 'created', 'none'],
      '--replace': textValue,
    },
  };
  const parsed = options(args, name === 'grep' ? grep : rg);
  // -L 对 grep 是输出文件名；对 rg 是跟随链接，不能误用共享选项表。
  if (name === 'rg' && anyFlag(parsed, '-L')) fail('shell_follow_not_supported');
  const patternFiles = allValues(parsed, '-f', '--file');
  for (const path of patternFiles) await boundary.file(path);
  const paths = [...parsed.operands];
  if (!allValues(parsed, '-e', '--regexp').length && !patternFiles.length) {
    if (!paths.length) fail('shell_missing_pattern');
    paths.shift();
  }
  const recursive =
    name === 'rg' ||
    anyFlag(parsed, '-r', '--recursive') ||
    allValues(parsed, '-d', '--directories').includes('recurse');
  if (!paths.length && recursive && (name === 'grep' || !piped || patternFiles.includes('-')))
    paths.push('.');
  if (boundary.requiresBoundContent && [...paths, ...patternFiles].some((path) => path !== '-'))
    fail('shell_literal_read_binding_unverified');
  for (const path of paths) {
    if (path === '-') continue;
    const entry = await boundary.target(path, 'content');
    if (!entry.directory) continue;
    if (!recursive) {
      if (allValues(parsed, '-d', '--directories').includes('skip')) continue;
      fail('shell_directory_content_unverified');
    }
    // 过滤器/ignore 规则只减少候选；这里取保守超集，敏感候选要求确认，原命令不被重写成删减文件列表。
    if (name === 'rg') {
      let ancestor = entry.actual;
      while (true) {
        await boundary.ignoreFiles(ancestor);
        const parent = dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
    }
    await boundary.tree(
      path,
      'content',
      name === 'grep' || anyFlag(parsed, '--hidden', '-g', '--glob', '--iglob'),
      true,
      name === 'rg',
    );
  }
  return name === 'rg'
    ? ['--no-config', '--no-follow', '--no-pre', '--no-ignore-global', ...args]
    : args;
}

/** 让受信任 Git 解析自身索引；固定只读参数不加载项目脚本。 */
const execFileAsync = promisify(execFile);
async function gitTrackedPaths(boundary: Boundary, tree = false): Promise<string[]> {
  const binary = await boundary.binary('git');
  const { stdout } = await execFileAsync(
    binary,
    [
      ...GIT_SAFE_OPTIONS,
      ...(tree ? ['ls-tree', '-r', '-z', 'HEAD'] : ['ls-files', '--cached', '--stage', '-z']),
    ],
    {
      cwd: boundary.root,
      env: readOnlyShellEnvironment(),
      signal: boundary.signal,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'buffer',
    },
  );
  const text = stdout.toString('utf8');
  if (!Buffer.from(text).equals(stdout)) fail('shell_git_filename_unverified');
  const result: string[] = [];
  for (const record of text.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const header = record.slice(0, tab);
    const name = record.slice(tab + 1);
    if (
      tab < 0 ||
      !(
        tree
          ? /^(?:100644|100755|120000|160000) (?:blob|commit) [a-f0-9]+$/
          : /^(?:100644|100755|120000|160000) [a-f0-9]+ [0-3]$/
      ).test(header)
    )
      fail('shell_git_index_unverified');
    if (header.startsWith('160000 ')) fail('shell_git_submodule_unverified');
    if (
      name.startsWith('/') ||
      name.split('/').some((part) => !part || part === '.' || part === '..') ||
      name.includes('\\')
    )
      fail('shell_git_filename_unverified');
    result.push(name);
  }
  return [...new Set(result)].sort();
}
const GIT_SAFE_OPTIONS = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.excludesFile=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'diff.trustExitCode=false',
  '-c',
  'diff.orderFile=/dev/null',
  '-c',
  'submodule.recurse=false',
  '-c',
  'core.quotePath=true',
];
async function gitCommand(args: string[], boundary: Boundary): Promise<string[]> {
  // 只接受关闭 pager 的全局选项；-C/-c/--git-dir 等仍需独立证明。
  if (args[0] === '--no-pager') args = args.slice(1);
  const subcommand = args[0];
  if (!['status', 'diff', 'ls-files'].includes(subcommand)) fail('shell_git_command_not_supported');
  let paths: string[] = [];
  if (subcommand === 'ls-files') {
    // 限定索引中的文件名/阶段元数据，不读取历史 blob 或遍历未跟踪目录。
    paths = options(args.slice(1), {
      short: 'csz',
      long: ['--cached', '--stage', '--deduplicate', '--full-name', '--error-unmatch'],
    }).operands;
  } else if (subcommand === 'status') {
    const parsed = options(args.slice(1), {
      short: 'sbz',
      long: [
        '--short',
        '--branch',
        '--show-stash',
        '--long',
        '--verbose',
        '--no-renames',
        '--renames',
        '--null',
      ],
      shortValues: { u: ['no', 'normal', 'all'] },
      optionalLong: {
        '--porcelain': ['1', '2', 'v1', 'v2'],
        '--untracked-files': ['no', 'normal', 'all'],
        '--ignored': ['traditional', 'matching', 'no'],
        '--ignore-submodules': ['all'],
      },
    });
    paths = parsed.operands;
    // status -v 输出 diff，不能把它当纯文件名枚举。
    if (anyFlag(parsed, '--verbose')) fail('shell_git_option_not_supported');
  } else {
    const separator = args.indexOf('--');
    const flags = separator < 0 ? args.slice(1) : args.slice(1, separator);
    paths = separator < 0 ? [] : args.slice(separator + 1);
    const parsed = options(flags, {
      short: 'pUswbz',
      long: [
        '--patch',
        '--no-patch',
        '--raw',
        '--numstat',
        '--shortstat',
        '--stat',
        '--summary',
        '--name-only',
        '--name-status',
        '--check',
        '--binary',
        '--full-index',
        '--abbrev',
        '--no-prefix',
        '--relative',
        '--text',
        '--ignore-space-at-eol',
        '--ignore-space-change',
        '--ignore-all-space',
        '--ignore-blank-lines',
        '--exit-code',
        '--quiet',
        '--cached',
        '--staged',
        '--no-renames',
        '--minimal',
        '--patience',
        '--histogram',
        '--no-ext-diff',
        '--no-textconv',
      ],
      shortValues: { U: number },
      longValues: {
        '--unified': number,
        '--inter-hunk-context': number,
        '--diff-algorithm': ['myers', 'minimal', 'patience', 'histogram'],
        '--diff-filter': /^[ACDMRTUXBacdmrtuxb*]+$/,
        '--src-prefix': textValue,
        '--dst-prefix': textValue,
        '--line-prefix': textValue,
      },
      optionalLong: {
        '--color': ['always', 'auto', 'never'],
        '--word-diff': ['color', 'plain', 'porcelain', 'none'],
        '--ignore-submodules': ['all'],
      },
    });
    // 版本参数可能读取任意历史树；只支持明确的 HEAD 或当前索引/工作区。
    if (parsed.operands.some((arg) => arg !== 'HEAD') || parsed.operands.length > 1)
      fail('shell_git_revision_unverified');
  }
  const gitDir = await boundary.target('.git', 'git');
  if (!gitDir.exists || !gitDir.directory || gitDir.link || !within(boundary.root, gitDir.actual))
    fail('shell_git_repository_unverified');
  // gitfile/worktree/alternates 都可能把对象或配置解析转到项目外。
  for (const name of [
    'commondir',
    'gitdir',
    'objects/info/alternates',
    'objects/info/http-alternates',
  ]) {
    if ((await boundary.identity(join(gitDir.actual, name))).exists)
      fail('shell_git_repository_unverified');
  }
  // 只验证 Git 使用的固定入口；禁用的 hooks 与整个对象库不是待执行代码，不能每次全量遍历。
  for (const name of [
    'index',
    'HEAD',
    'packed-refs',
    'refs',
    'objects',
    'info',
    'info/attributes',
    'info/exclude',
  ]) {
    const entry = await boundary.target(join(gitDir.actual, name), 'git');
    if (entry.link || !within(gitDir.actual, entry.actual)) fail('shell_git_symlink_unverified');
  }
  for (const name of ['config', 'config.worktree']) {
    const entry = await boundary.target(join(gitDir.actual, name), 'git');
    if (!entry.exists) continue;
    if (!entry.regular || entry.nlink !== 1 || entry.link || !within(gitDir.actual, entry.actual))
      fail('shell_git_configuration_unverified');
    if ((await lstat(entry.actual)).size > 256 * 1024) fail('shell_git_configuration_unverified');
    const text = await readFile(entry.actual, { encoding: 'utf8', signal: boundary.signal });
    if (text.length > 256 * 1024 || /\\\r?\n/.test(text))
      fail('shell_git_configuration_unverified');
    const sections = [...text.matchAll(/^\s*\[([^\]]+)\]/gm)].map((match) =>
      match[1].trim().toLowerCase(),
    );
    if (
      sections.some((section) =>
        /^(?:include|includeif|extensions|filter)(?:\s|\.|$)/.test(section),
      ) ||
      /^\s*(?:promisor|partialclonefilter)\s*=/im.test(text)
    )
      fail('shell_git_configuration_unverified');
    // 配置文件只允许常见声明式节；local config 也不能改变仓库根或对象读取位置。
    if (
      sections.some(
        (section) =>
          !/^(?:core|remote|branch|user|push|pull|fetch|diff|merge|status|color|advice|init|credential|filter|submodule|alias|url)(?:\s|\.|$)/.test(
            section,
          ),
      ) ||
      /^\s*(?:worktree|attributesfile|excludesfile)\s*=/im.test(text) ||
      /^\s*bare\s*=\s*true\s*(?:[#;].*)?$/im.test(text)
    )
      fail('shell_git_configuration_unverified');
  }
  if (subcommand === 'diff') {
    // diff 会输出对象内容，额外验证对象/引用存储；超过扫描预算时明确回退，不假定外部对象安全。
    await boundary.tree(join(gitDir.actual, 'objects'), 'git');
    await boundary.tree(join(gitDir.actual, 'refs'), 'git');
  }
  const tracked = await gitTrackedPaths(boundary);
  if (subcommand === 'diff' && args.some((arg) => ['HEAD', '--cached', '--staged'].includes(arg)))
    tracked.push(...(await gitTrackedPaths(boundary, true)));
  for (const path of paths) {
    if (path.startsWith(':') || /[*?[\]]/.test(path)) fail('shell_git_pathspec_unverified');
    const entry = await boundary.target(path, subcommand === 'diff' ? 'content' : 'metadata');
    if (entry.directory && subcommand === 'diff') await boundary.tree(path, 'content');
  }
  const selected = (path: string) =>
    paths.length === 0 ||
    paths.some((base) => within(resolve(boundary.root, base), resolve(boundary.root, path)));
  for (const path of tracked.filter(selected)) {
    const entry = await boundary.target(path, subcommand === 'diff' ? 'content' : 'metadata');
    if (entry.regular && entry.nlink !== 1) fail('hardlink_alias_unverified');
    // Git 的符号链接内容是链接文本，不应解引用到另一个文件；保守升级任何链接。
    if (entry.link) fail('shell_git_symlink_unverified');
    if (entry.directory) fail('shell_git_submodule_unverified');
  }
  // ignore/attributes 是 Git 可能读取的项目配置，不执行其中指令；仍验证其物理边界。
  const configDirs = new Set([boundary.root]);
  for (const path of tracked) {
    let dir = dirname(resolve(boundary.root, path));
    while (within(boundary.root, dir)) {
      configDirs.add(dir);
      if (dir === boundary.root) break;
      dir = dirname(dir);
    }
  }
  // status 的未跟踪文件遍历仅产生文件名/状态；不扫描已被 Git 排除的 node_modules 等目录。
  for (const dir of [...configDirs].sort()) {
    for (const name of ['.gitignore', '.gitattributes']) {
      const entry = await boundary.identity(join(dir, name));
      if (entry.exists) await boundary.file(entry.raw);
    }
  }
  return [
    ...GIT_SAFE_OPTIONS,
    subcommand,
    ...(subcommand === 'diff' ? ['--no-ext-diff', '--no-textconv'] : []),
    ...args.slice(1),
  ];
}

/** 解码仅发生在 AST 已证明为字面量的节点；不另写 Shell 词法器。 */
function literal(node: Parser.SyntaxNode): string {
  switch (node.type) {
    case 'command_name':
      if (node.namedChildCount !== 1) return fail('shell_dynamic_command');
      return literal(node.namedChildren[0]);
    case 'raw_string':
      return node.text.slice(1, -1);
    case 'string':
      if (node.namedChildren.some((child) => child.type !== 'string_content'))
        return fail('shell_expansion');
      return node.text
        .slice(1, -1)
        .replace(/\\([$`"\\\n])/g, (_match, char: string) => (char === '\n' ? '' : char));
    case 'concatenation':
      return node.namedChildren.map(literal).join('');
    case 'number':
    case 'word': {
      // 去掉已经由 Bash AST 识别的转义对再检查展开符；引号内的通配符保持字面量。
      const unescaped = node.text.replace(/\\[\s\S]/g, '');
      if (/[*?[\]{}~$`]/.test(unescaped)) return fail('shell_expansion');
      return node.text.replace(/\\\n/g, '').replace(/\\([\s\S])/g, '$1');
    }
    default:
      return fail(`shell_unresolved_${node.type}`);
  }
}

interface FileSelection {
  roots: Array<{ label: string; entry: Entry }>;
  files: Array<{ operand: string; entry: Entry }>;
  predicates: string[];
  nullTerminated: boolean;
}

/** 仅证明隐式 AND 的普通文件选择；其他 find 表达式仍由原只读分析或 reviewer 处理。 */
function fileFindSpec(args: readonly string[]) {
  let i = args[0] === '-P' ? 1 : 0;
  const roots: string[] = [];
  while (i < args.length && !args[i].startsWith('-') && !['!', '(', ')', ','].includes(args[i]))
    roots.push(args[i++]);
  const predicates = args.slice(i);
  const names: string[] = [];
  let regular = false;
  let print: 'line' | 'nul' | undefined;
  while (i < args.length) {
    const flag = args[i++];
    if ((flag === '-print' || flag === '-print0') && i === args.length) {
      print = flag === '-print0' ? 'nul' : 'line';
      break;
    }
    const value = args[i++];
    if (flag === '-type' && value === 'f') regular = true;
    else if (flag === '-name' && value !== undefined && !/[?\[\]{}\\/\0]/.test(value))
      names.push(value);
    else return undefined;
  }
  if (!regular) return undefined;
  if (roots.some((root) => !root || root.endsWith('/'))) return undefined;
  return {
    roots: roots.length ? roots : ['.'],
    names,
    predicates: print ? predicates.slice(0, -1) : predicates,
    nullTerminated: print === 'nul',
  };
}

async function selectFiles(args: string[], boundary: Boundary): Promise<FileSelection> {
  const spec = fileFindSpec(args) ?? fail('shell_substitution_find_unverified');
  const selection: FileSelection = {
    roots: [],
    files: [],
    predicates: [...spec.predicates],
    nullTerminated: spec.nullTerminated,
  };
  for (const label of spec.roots) {
    const root = await boundary.target(label, 'metadata');
    if (!root.exists || !root.directory || root.link) fail('shell_find_root_unverified');
    if (boundary.scope(root, 'metadata') !== 'project') fail('outside_project');
    selection.roots.push({ label: label.replace(/\/+$/, '') || '/', entry: root });
    const walk = async (dir: string, suffix: string): Promise<void> => {
      boundary.signal.throwIfAborted();
      // 不把不可往返的文件名字节当成另一个 Unicode 路径。
      for (const item of await readdir(dir, { withFileTypes: true, encoding: 'buffer' })) {
        const name = item.name.toString('utf8');
        if (!Buffer.from(name).equals(item.name)) fail('shell_find_filename_unverified');
        const path = join(dir, name);
        const child = suffix ? `${suffix}/${name}` : name;
        if (item.isSymbolicLink()) {
          await boundary.identity(path); // find -P 不跟随发现的链接。
          continue;
        }
        const entry = await boundary.target(path, 'metadata');
        if (entry.link || boundary.scope(entry, 'metadata') !== 'project')
          fail('shell_find_changed');
        if (entry.directory) await walk(entry.actual, child);
        else if (
          entry.regular &&
          spec.names.every((pattern) =>
            minimatch(name, pattern, {
              dot: true,
              nonegate: true,
              nocomment: true,
              noext: true,
              nobrace: true,
              noglobstar: true,
            }),
          )
        )
          selection.files.push({ operand: `${label.replace(/\/+$/, '')}/${child}`, entry });
      }
    };
    await walk(root.actual, '');
  }
  return selection;
}

/** 每个候选都必须保持为同一个 wc 操作数；不对拆分/通配后的任意 argv 猜测安全性。 */
function substitutionOperand(operand: string): void {
  if (!operand || operand.startsWith('-') || /[\s*?\[\]\0]/.test(operand))
    fail('shell_substitution_word_expansion');
}

function hasAncestor(node: Parser.SyntaxNode, type: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.type === type) return true;
  return false;
}
function commandOperators(node: Parser.SyntaxNode): string[] {
  return node.children.flatMap((child) => (child.isNamed ? commandOperators(child) : [child.type]));
}

export async function analyzeReadOnlyShell(
  command: string,
  cwd: string,
  pluginEntries: readonly string[],
  signal: AbortSignal,
): Promise<ReadOnlyShellAnalysis> {
  signal.throwIfAborted();
  const unresolved: string[] = [];
  const commands: string[][] = [];
  const empty = (reasonCode: string): ReadOnlyShellAnalysis => ({
    complete: false,
    reasonCode,
    effects: [{ kind: 'unknown', scope: 'unknown' }],
    targets: [],
    environment: {},
    commands,
    unresolved: [reasonCode],
    pathFacts: [],
  });
  if (
    typeof command !== 'string' ||
    !command.trim() ||
    command.length > 32_768 ||
    command.includes('\0')
  )
    return empty('shell_input_limit');
  // PowerShell 不走 bash 语法树。调用方在 win32 上应先走 powershell.ts。
  if (process.platform === 'win32') return empty('native_windows_unverified');
  if (/\\\r?\n/.test(command)) unresolved.push('shell_line_continuation_unverified');
  const boundary = new Boundary(
    await realpath(resolve(cwd)),
    await searchPluginEntries(cwd, pluginEntries),
    signal,
  );
  const parser = new Parser();
  parser.setLanguage(Bash);
  let tree: Parser.Tree;
  try {
    tree = parser.parse(command);
  } catch {
    return empty('shell_parse_error');
  }
  const normalized = new Map<number, string>();
  const bindings: ReadOnlyShellBinding[] = [];
  const helpers: string[] = [];
  const selections = new Map<string, { selection: FileSelection; helper: string }>();
  const combinedPipelines = new Map<number, string>();
  const stderrSinks = new Map<number, number>();
  const consumedSinks = new Set<number>();
  const bind = (entry: Entry, kind: ReadOnlyShellBinding['kind']) => {
    if (process.platform !== 'linux') fail('shell_descriptor_platform_unverified');
    let index = bindings.findIndex(
      (binding) => binding.path === entry.actual && binding.kind === kind,
    );
    if (index < 0) {
      if (bindings.length >= 768) fail('shell_descriptor_limit');
      index = bindings.length;
      bindings.push({ path: entry.actual, identity: entry.identity, kind });
    }
    return `AGENTLAB_BOUND_${index}`;
  };
  const bindRoot = async () => {
    if (!bindings.length) bind(await boundary.target(boundary.root, 'metadata'), 'directory');
  };
  const discardStderr = async () => {
    // 不按可变路径重新打开输出文件；只绑定 Linux 的 null 字符设备。
    const entry = await boundary.identity('/dev/null');
    const stat = await lstat('/dev/null', { bigint: true });
    if (entry.link || !stat.isCharacterDevice() || stat.rdev !== 259n)
      fail('shell_discard_device_unverified');
    await bindRoot();
    const variable = bind(entry, 'discard');
    return Number(variable.slice('AGENTLAB_BOUND_'.length)) + 3;
  };
  const literalListing = async (args: string[]) => {
    // 单目录无标题列举可保持标签；-d、多目标、递归和带值选项暂不改写。
    const parsed = options(args, { short: 'aAlhtrSUXisFpQq1mxCnogBNbcuv' });
    if (parsed.operands.length > 1) fail('shell_literal_metadata_binding_unverified');
    const path = parsed.operands[0] ?? '.';
    const entry = await boundary.target(path, 'metadata');
    if (!entry.exists || !entry.directory || entry.link)
      fail('shell_literal_metadata_binding_unverified');
    await boundary.tree(path, 'metadata', true, false);
    await bindRoot();
    const variable = bind(entry, 'directory');
    const argv = args.map((arg, i) =>
      parsed.operandIndices.includes(i) ? `"$${variable}/"` : quote(arg),
    );
    if (!parsed.operands.length) {
      if (!args.includes('--')) argv.push('--');
      argv.push(`"$${variable}/"`);
    }
    return [quote(await boundary.binary('ls')), ...argv].join(' ');
  };
  const wcOutput = (invocation: string, mapped: Array<{ operand: string; variable: string }>) => {
    const labels = mapped.map(
      ({ operand, variable }) =>
        `*" $${variable}") builtin printf '%s %s\\n' "\${line%\" $${variable}\"}" ${quote(operand)};;`,
    );
    return `output=$(${invocation}); status=$?; while IFS= builtin read -r line; do case "$line" in ${labels.join(' ')} *) builtin printf '%s\\n' "$line";; esac; done <<< "$output"; return "$status";`;
  };
  // 目录传播后的普通文件读取共用描述符绑定，不局限于 find/wc 一种命令形状。
  const literalRead = async (name: string, args: string[]) => {
    const numeric = (name === 'head' || name === 'tail') && /^-\d+$/.test(args[0] ?? '');
    const parsed = options(
      numeric ? ['-n', args[0].slice(1), ...args.slice(1)] : args,
      FILE_READ_SPECS[name],
    );
    if (
      (name === 'head' || name === 'tail') &&
      (anyFlag(parsed, '-v', '--verbose') ||
        (parsed.operands.length > 1 && !anyFlag(parsed, '-q', '--quiet', '--silent')))
    )
      fail('shell_read_headers_unverified');
    const argv = args.map(quote);
    const mapped: Array<{ operand: string; variable: string }> = [];
    for (const checkedIndex of parsed.operandIndices) {
      const index = numeric ? checkedIndex - 1 : checkedIndex;
      const operand = args[index];
      if (operand === '-') continue;
      const entry = await boundary.target(operand, 'content');
      if (!entry.exists || !entry.regular) fail('shell_read_target_unverified');
      await bindRoot();
      const variable = bind(entry, 'file');
      if (
        name === 'wc' &&
        (/[\r\n\t]/.test(operand) ||
          mapped.some((item) => item.variable === variable && item.operand !== operand))
      )
        fail('shell_read_labels_unverified');
      argv[index] = `"$${variable}"`;
      mapped.push({ operand, variable });
    }
    const invocation = [quote(await boundary.binary(name)), ...argv].join(' ');
    if (name !== 'wc' || !mapped.length) return invocation;
    const helper = `__agentlab_wc_${helpers.length}`;
    helpers.push(
      `${helper}() { builtin local line output status; ${wcOutput(invocation, mapped)} };`,
    );
    return helper;
  };
  const findSelection = async (args: string[]) => {
    const key = JSON.stringify([boundary.cwd, args]);
    const cached = selections.get(key);
    if (cached) return cached;
    const selection = await selectFiles(args, boundary);
    if (
      selection.roots.some((root, i) =>
        selection.roots.some(
          (other, j) =>
            j < i && root.entry.actual === other.entry.actual && root.label !== other.label,
        ),
      )
    )
      fail('shell_find_alias_unverified');
    await bindRoot();
    const helper = `__agentlab_find_${selections.size}`;
    const roots = selection.roots.map(({ entry }) => bind(entry, 'directory'));
    const binary = await boundary.binary('find');
    // 实际 find 在获授权后才运行。目录通过 fd 锚定，NUL 帧保留文件名，返回集合须属于已验证候选。
    const cases = selection.roots.map(({ label }, i) => {
      const operands = selection.files.filter(({ operand }) => operand.startsWith(`${label}/`));
      const allowed = operands.length
        ? operands.map(({ operand }) => quote(operand)).join('|')
        : '';
      return `"$${roots[i]}"/*) value=${quote(`${label}/`)}"\${raw#\"$${roots[i]}/\"}"; case "$value" in ${allowed ? `${allowed}) builtin printf ${selection.nullTerminated ? "'%s\\0'" : "'%s\\n'"} "$value";;` : ''} *) builtin printf '%s\\n' 'approval_stale: find selection changed' >&2; return 125;; esac;;`;
    });
    helpers.push(
      `${helper}() ( builtin set -o pipefail; ${quote(binary)} ${roots.map((variable) => `"$${variable}/"`).join(' ')} ${selection.predicates.map(quote).join(' ')} '-print0' | { while IFS= builtin read -r -d '' raw; do case "$raw" in ${cases.join(' ')} *) return 125;; esac; done; } );`,
    );
    const result = { selection, helper };
    selections.set(key, result);
    return result;
  };
  const dynamicWc = async (args: Parser.SyntaxNode[]) => {
    const substitution = args.at(-1)!;
    if (!substitution.text.startsWith('$(')) fail('shell_substitution_form_unverified');
    const nested = substitution.namedChildren.filter((child) => child.type !== 'comment');
    if (nested.length !== 1 || nested[0].type !== 'command')
      fail('shell_substitution_find_unverified');
    const child = nested[0];
    const nameNode = child.childForFieldName('name');
    if (
      !nameNode ||
      literal(nameNode) !== 'find' ||
      child.namedChildren.some((n) => n.type === 'variable_assignment')
    )
      fail('shell_substitution_find_unverified');
    const findArgs = child.namedChildren.filter((n) => n.id !== nameNode!.id).map(literal);
    // Bash 会移除替换中的 NUL，不能将 -print0 等价于按行输出。
    if (fileFindSpec(findArgs)?.nullTerminated) fail('shell_substitution_nul_unverified');
    const flags = args.slice(0, -1).map(literal);
    const normalizedFlags = flags.at(-1) === '--' ? flags.slice(0, -1) : flags;
    if (
      options(flags, {
        short: 'clmwL',
        long: ['--bytes', '--chars', '--lines', '--words', '--max-line-length'],
      }).operands.length
    )
      fail('shell_substitution_operands_unverified');
    const { selection, helper: find } = await findSelection(findArgs);
    const mapped: Array<{ operand: string; variable: string }> = [];
    for (const { operand, entry } of selection.files) {
      substitutionOperand(operand);
      await boundary.file(entry.actual);
      mapped.push({ operand, variable: bind(entry, 'file') });
    }
    const helper = `__agentlab_wc_${helpers.length}`;
    const binary = await boundary.binary('wc');
    const cases = mapped.map(
      ({ operand, variable }) => `${quote(operand)}) files+=("$${variable}");;`,
    );
    // 先验证完整 argv，再读任何 fd。wc 的数值、顺序、total 和退出状态保留，仅还原 fd 标签。
    helpers.push(
      `${helper}() { builtin local arg line output status selection; builtin local -a files; files=(); selection=$(${find}) || return $?; for arg in $selection; do case "$arg" in ${cases.join(' ')} *) builtin printf '%s\\n' 'approval_stale: wc operand changed' >&2; return 125;; esac; done; ${wcOutput(`${quote(binary)} ${normalizedFlags.map(quote).join(' ')} -- "\${files[@]}"`, mapped)} };`,
    );
    return helper;
  };
  const combineXargs = async (node: Parser.SyntaxNode): Promise<boolean> => {
    const children = node.namedChildren;
    if (children.length < 2 || children[0].type !== 'command' || children[1].type !== 'command')
      return false;
    const first = children[0].childForFieldName('name');
    const second = children[1].childForFieldName('name');
    if (!first || !second || literal(first) !== 'find' || literal(second) !== 'xargs') return false;
    if (
      children
        .slice(0, 2)
        .some((child) => child.namedChildren.some((n) => n.type === 'variable_assignment'))
    )
      fail('shell_assignment');
    const findArgs = children[0].namedChildren.filter((n) => n.id !== first.id).map(literal);
    const xargsArgs = children[1].namedChildren.filter((n) => n.id !== second.id).map(literal);
    if (
      !fileFindSpec(findArgs)?.nullTerminated ||
      xargsArgs.length !== 2 ||
      !['-0', '--null'].includes(xargsArgs[0]) ||
      xargsArgs[1] !== 'cat'
    )
      fail('shell_xargs_shape_unverified');
    if (node.children.some((child) => !child.isNamed && child.type !== '|'))
      fail('shell_async_or_control');
    const { selection, helper: find } = await findSelection(findArgs);
    const cases: string[] = [];
    for (const { operand, entry } of selection.files) {
      if (operand.startsWith('-')) fail('shell_xargs_option_injection');
      await boundary.file(entry.actual);
      cases.push(`${quote(operand)}) files+=("$${bind(entry, 'file')}");;`);
    }
    const xargs = await boundary.binary('xargs');
    const cat = await boundary.binary('cat');
    const sink = children.length === 2 ? stderrSinks.get(node.id) : undefined;
    if (sink !== undefined) consumedSinks.add(node.id);
    const helper = `__agentlab_xargs_${helpers.length}`;
    // 完整 NUL 输入和 find 退出状态都验证后才把已绑定 fd 交给真实 xargs/cat。
    // 保留 xargs 空输入和退出码；fd 路径长度可能改变批次，故仅支持普通 cat 内容串联。
    helpers.push(
      `${helper}() { builtin local arg pid valid; builtin local -a files; files=(); valid=1; while IFS= builtin read -r -d '' arg; do case "$arg" in ${cases.join(' ')} *) valid=0;; esac; done < <(${find}); pid=$!; builtin wait "$pid" || return 125; if (( ! valid )); then return 125; fi; { if (( \${#files[@]} )); then builtin printf '%s\\0' "\${files[@]}"; fi; } | ${quote(xargs)} '-0' ${quote(cat)}${sink === undefined ? '' : ` 2>&${sink}`}; };`,
    );
    commands.push(['find', ...findArgs], ['xargs', ...xargsArgs]);
    combinedPipelines.set(node.id, helper);
    return true;
  };
  const record = (error: unknown) => {
    signal.throwIfAborted();
    unresolved.push(error instanceof Unverified ? error.reasonCode : 'shell_filesystem_unverified');
  };
  try {
    await boundary.binary('bash');
    await boundary.target('.', 'metadata');
  } catch (error) {
    record(error);
  }
  let nodes = 0;
  // cd 的后续路径只在全 && 链成功分支里传播；分号、|| 与管道内的 cd 不猜测运行时 cwd。
  const hasCd = (node: Parser.SyntaxNode): boolean => {
    if (node.type === 'command') {
      try {
        if (literal(node.childForFieldName('name')!) === 'cd') return true;
      } catch {
        /* 未解析命令不会放行。 */
      }
    }
    return node.namedChildren.some(hasCd);
  };
  const cdFlow =
    !hasCd(tree.rootNode) ||
    (tree.rootNode.namedChildren.filter((node) => node.type !== 'comment').length === 1 &&
      !commandOperators(tree.rootNode).includes('||'));
  const hasSubstitution = (node: Parser.SyntaxNode): boolean =>
    node.type === 'command_substitution' || node.namedChildren.some(hasSubstitution);
  const hasBoundPipeline = (node: Parser.SyntaxNode): boolean => {
    if (node.type === 'redirected_statement') return true;
    if (node.type === 'command') {
      try {
        // 必须与执行分析使用相同词法解码，引号/转义不能绕过前序读取的 fd 绑定。
        if (literal(node.childForFieldName('name')!) === 'xargs') return true;
      } catch {
        /* 未解析命令不会放行。 */
      }
    }
    return node.namedChildren.some(hasBoundPipeline);
  };
  boundary.requiresBoundContent =
    hasCd(tree.rootNode) || hasSubstitution(tree.rootNode) || hasBoundPipeline(tree.rootNode);
  const collect = async (node: Parser.SyntaxNode, piped = false): Promise<void> => {
    signal.throwIfAborted();
    if (++nodes > 4096) fail('shell_ast_limit');
    if (node.type === 'redirected_statement') {
      try {
        const body = node.childForFieldName('body');
        const redirects = node.namedChildren.filter((child) => child.id !== body?.id);
        if (!body || redirects.length !== 1) return fail('shell_redirect_unverified');
        const redirect = redirects[0];
        if (
          redirect.type !== 'file_redirect' ||
          redirect.childForFieldName('descriptor')?.text !== '2' ||
          literal(redirect.childForFieldName('destination')!) !== '/dev/null' ||
          redirect.children
            .filter((child) => !child.isNamed)
            .map((child) => child.type)
            .join('') !== '>'
        )
          fail('shell_redirect_unverified');
        stderrSinks.set(body.id, await discardStderr());
        await collect(body, piped);
        return;
      } catch (error) {
        record(error);
      }
    }
    if (node.type === 'pipeline') {
      try {
        if (await combineXargs(node)) {
          for (const child of node.namedChildren.slice(2)) await collect(child, true);
          return;
        }
      } catch (error) {
        record(error);
      }
    }
    if (node.type === 'command') {
      try {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) fail('shell_dynamic_command');
        const name = literal(nameNode!);
        const argNodes = node.namedChildren.filter(
          (child) => child.id !== nameNode!.id && child.type !== 'variable_assignment',
        );
        commands.push([name, ...argNodes.map((arg) => arg.text)]);
        if (name.includes('/')) fail('shell_command_path_unverified');
        if (node.namedChildren.some((child) => child.type === 'variable_assignment'))
          fail('shell_assignment');
        if (name === 'wc' && argNodes.at(-1)?.type === 'command_substitution') {
          normalized.set(node.id, await dynamicWc(argNodes));
          return;
        }
        const args = argNodes.map(literal);
        if (name === 'cd') {
          if (!cdFlow || hasAncestor(node, 'pipeline') || hasAncestor(node, 'command_substitution'))
            fail('shell_cwd_flow_unverified');
          const parsed = options(args, { short: 'LP' });
          if (parsed.operands.length !== 1) fail('shell_cd_target_unverified');
          const target = parsed.operands[0];
          if (target === '-') fail('shell_cd_previous_directory_unverified');
          const entry = await boundary.target(target, 'metadata');
          if (!entry.exists || !entry.directory || entry.link) fail('shell_cd_target_unverified');
          await bindRoot();
          const variable = bind(entry, 'directory');
          const logical = resolve(boundary.cwd, target);
          if (logical !== entry.actual) fail('shell_cd_symlink_unverified');
          boundary.cwd = entry.actual;
          // cd 必须在当前 shell 生效，只有设置 PWD 与 cd 作为同一 && 单元。
          normalized.set(
            node.id,
            `{ builtin cd -P -- "$${variable}" && builtin export PWD=${quote(logical)}; }`,
          );
          return;
        }
        if (name === 'find' && process.platform === 'linux' && fileFindSpec(args)) {
          normalized.set(node.id, (await findSelection(args)).helper);
          return;
        }
        if (name === 'ls' && boundary.requiresBoundContent) {
          normalized.set(node.id, await literalListing(args));
          return;
        }
        const argv = await simpleCommand(name, args, boundary, piped);
        if (boundary.requiresBoundContent && Object.hasOwn(FILE_READ_SPECS, name)) {
          normalized.set(node.id, await literalRead(name, argv));
          return;
        }
        const prefix = ['echo', 'pwd', 'printf'].includes(name)
          ? ['builtin', name]
          : [await boundary.binary(name)];
        normalized.set(node.id, [...prefix, ...argv].map(quote).join(' '));
        if (node.namedChildren.some((child) => child.type === 'variable_assignment'))
          fail('shell_assignment');
      } catch (error) {
        record(error);
      }
    }
    for (let i = 0; i < node.namedChildren.length; i++)
      await collect(node.namedChildren[i], node.type === 'pipeline' ? i > 0 : piped);
  };
  try {
    await collect(tree.rootNode);
  } catch (error) {
    record(error);
  }
  const render = (node: Parser.SyntaxNode): string => {
    if (node.hasError || node.isMissing) return fail('shell_parse_error');
    if (node.type === 'comment') return '';
    if (node.type === 'redirected_statement') {
      const body = node.childForFieldName('body');
      const sink = body && stderrSinks.get(body.id);
      if (!body || sink === undefined) return fail('shell_redirect_unverified');
      return render(body) + (consumedSinks.has(body.id) ? '' : ` 2>&${sink}`);
    }
    if (node.type === 'command') {
      if (node.namedChildren.some((child) => child.type === 'variable_assignment'))
        return fail('shell_assignment');
      return normalized.get(node.id) ?? fail('shell_command_unverified');
    }
    if (node.type === 'program') {
      if (node.children.some((child) => !child.isNamed && ![';', '\n'].includes(child.type)))
        return fail('shell_async_or_control');
      return node.namedChildren.map(render).filter(Boolean).join('; ');
    }
    if (node.type === 'list' || node.type === 'pipeline') {
      if (combinedPipelines.has(node.id))
        return [combinedPipelines.get(node.id), ...node.namedChildren.slice(2).map(render)].join(
          ' | ',
        );
      const parts: string[] = [];
      for (const child of node.children) {
        if (child.isNamed) parts.push(render(child));
        else if (
          (node.type === 'list' && ['&&', '||'].includes(child.type)) ||
          (node.type === 'pipeline' && child.type === '|')
        )
          parts.push(child.type);
        else return fail('shell_async_or_control');
      }
      return parts.join(' ');
    }
    return fail(`shell_unresolved_${node.type}`);
  };
  let safeCommand: string | undefined;
  try {
    const body = render(tree.rootNode);
    safeCommand = [...helpers, body].join(' ');
    if (!safeCommand) fail('shell_empty_command');
    if (Buffer.byteLength(safeCommand) > 96 * 1024) fail('shell_execution_contract_limit');
  } catch (error) {
    record(error);
  }
  if (tree.rootNode.hasError) unresolved.push('shell_parse_error');
  const complete = unresolved.length === 0 && Boolean(safeCommand);
  const effects = [
    ...new Map(
      boundary.effects.map((effect) => [`${effect.kind}:${effect.scope}:${effect.target}`, effect]),
    ).values(),
  ];
  if (!complete) effects.push({ kind: 'unknown', scope: 'unknown' });
  const reasonCode = !complete
    ? (unresolved[0] ?? 'shell_unverified')
    : effects.some((effect) => effect.scope === 'sensitive')
      ? 'sensitive_path'
      : effects.some((effect) => effect.scope === 'external')
        ? 'outside_project'
        : 'bounded_readonly_shell';
  boundary.environment.$executionEnvironment = digest(readOnlyShellEnvironment());
  return {
    complete,
    reasonCode,
    effects,
    targets: [...boundary.targets].sort(),
    ...(complete ? { command: safeCommand } : {}),
    ...(complete && bindings.length ? { bindings } : {}),
    environment: Object.fromEntries(
      Object.entries(boundary.environment).sort(([a], [b]) => a.localeCompare(b)),
    ),
    commands,
    unresolved: [...new Set(unresolved)],
    pathFacts: [...boundary.pathFacts.values()].sort((a, b) => a.raw.localeCompare(b.raw)),
  };
}
