/** 具体操作分析：只读取前提，不执行工具，不缓存环境或批准。 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AnalysisInput, ToolAnalysis, ToolAnalyzer } from '../../sdk/capabilities.js';
import { createEnvironmentAnalyzer } from './environment.js';
import { analyzeCommand } from '../../tools/bash.js';
import { jsonInput } from '../../core/permission/input-validation.js';

export const ANALYZER_ID = 'deterministic-operations';
export const ANALYZER_VERSION = '2.0.0';
/** 平台声明，不是跨平台实测：尚未验证 NTFS ADS/设备名/尾随点等语义。 */
export function nativeFilesystemAnalysisSupported(platform: NodeJS.Platform = process.platform): boolean { return platform !== 'win32'; }
export interface AnalyzerOptions { pluginEntries?: readonly string[]; writeRoots?: readonly string[]; parseCacheSize?: number }
export interface LiteralShellFacts {
  complete: boolean;
  argv: readonly string[];
  subset: 'pwd' | 'echo' | 'printf' | 'unsupported';
  reasonCode: string;
}
type ParsedOperation =
  | { kind: 'file'; path: string; effect: 'read' | 'write' }
  | { kind: 'glob'; path: string; pattern: string; literal: boolean }
  | { kind: 'shell'; facts: LiteralShellFacts; dangerous: boolean }
  | { kind: 'search'; path: string }
  | { kind: 'unknown'; reasonCode: string };

/** 只认单条字面量语法。语法完整不代表 Shell 环境、副作用已被证明安全。 */
export function parseLiteralShell(command: unknown): LiteralShellFacts {
  const unsupported = (reasonCode: string): LiteralShellFacts => ({ complete: false, argv: [], subset: 'unsupported', reasonCode });
  if (typeof command !== 'string' || command.length === 0 || command.length > 4096) return unsupported('shell_input_limit');
  if (/[\0\r\n]/.test(command)) return unsupported('shell_control_syntax');
  const argv: string[] = []; let token = ''; let present = false; let quote: "'" | '"' | undefined;
  for (const char of command) {
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (quote === '"' && /[$`\\]/.test(char)) return unsupported('shell_expansion');
      token += char; continue;
    }
    if (char === "'" || char === '"') { quote = char; present = true; continue; }
    if (/\s/.test(char)) { if (present) { argv.push(token); token = ''; present = false; } continue; }
    if (/[;&|<>$`\\(){}*?!\[\]~]/.test(char)) return unsupported('shell_dynamic_or_composed');
    token += char; present = true;
  }
  if (quote) return unsupported('shell_unclosed_quote');
  if (present) argv.push(token);
  if (!argv.length || argv.length > 32) return unsupported('shell_token_limit');
  if (argv[0] === 'pwd' && (argv.length === 1 || argv.length === 2 && ['-L', '-P'].includes(argv[1]))) {
    return { complete: true, argv, subset: 'pwd', reasonCode: 'literal_pwd' };
  }
  if (argv[0] === 'echo' && argv.slice(1).every((arg) => !arg.startsWith('-'))) {
    return { complete: true, argv, subset: 'echo', reasonCode: 'literal_echo' };
  }
  if (argv[0] === 'printf' && argv.length >= 2 && ['%s', '%s\\n'].includes(argv[1])) {
    return { complete: true, argv, subset: 'printf', reasonCode: 'literal_printf' };
  }
  return { complete: false, argv, subset: 'unsupported', reasonCode: /^(?:git|npm|pnpm|yarn|npx|make|bash|sh|python\d*|node)$/.test(argv[0]) ? 'shell_script_or_configuration' : 'shell_command_not_supported' };
}

/** 可复用的是纯语法结果。完整输入、工具/分析版本、cwd 和 revision 都在键中。 */
export function operationKey(input: AnalysisInput): string {
  const revisions = input as AnalysisInput & { configRevision?: string | number; policyRevision?: string | number };
  return hash({ analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION, tool: { name: input.tool.name, version: input.tool.version ?? 'unversioned',
    ownerPlugin: input.tool.ownerPlugin ?? 'unknown', risk: input.tool.risk, inputSchema: input.tool.inputSchema }, input: input.input, cwd: input.cwd,
    configRevision: revisions.configRevision ?? 'unspecified', policyRevision: revisions.policyRevision ?? 'unspecified' });
}

export function createDeterministicAnalyzer(options: AnalyzerOptions = {}): ToolAnalyzer & { cacheStats(): { entries: number; hits: number; misses: number } } {
  const writeRoots = Object.freeze([...(options.writeRoots ?? [])]);
  const pluginEntries = Object.freeze([...(options.pluginEntries ?? [])]);
  const cache = new Map<string, ParsedOperation>(); let hits = 0; let misses = 0;
  const limit = Math.max(0, Math.min(options.parseCacheSize ?? 128, 1024));
  const checkpoint = createEnvironmentAnalyzer();
  const parse = (input: AnalysisInput): ParsedOperation => {
    const key = hash({ operation: operationKey(input), writeRoots, pluginEntries }); const cached = cache.get(key);
    if (cached) { hits++; return structuredClone(cached); }
    misses++;
    const data = input.input; let parsed: ParsedOperation;
    if (input.tool.ownerPlugin !== 'agentlab.local-tools' || input.tool.version !== '1.0.0') {
      parsed = { kind: 'unknown', reasonCode: 'unverified_tool_implementation' };
    } else if (['read_file', 'write_file', 'edit_file'].includes(input.tool.name) && typeof data.path === 'string' && data.path.length > 0) {
      parsed = { kind: 'file', path: data.path, effect: input.tool.name === 'read_file' ? 'read' : 'write' };
    } else if (input.tool.name === 'glob' && typeof data.pattern === 'string') {
      parsed = { kind: 'glob', path: typeof data.path === 'string' ? data.path : '.', pattern: data.pattern, literal: !/[?*{}[\]()!+@\\]/.test(data.pattern) };
    } else if (input.tool.name === 'grep') {
      parsed = { kind: 'search', path: typeof data.path === 'string' ? data.path : '.' };
    } else if (input.tool.name === 'bash') parsed = { kind: 'shell', facts: parseLiteralShell(data.command),
      dangerous: typeof data.command === 'string' && analyzeCommand(data.command).dangerous };
    else parsed = { kind: 'unknown', reasonCode: input.tool.name.startsWith('mcp') || input.tool.name.includes('__') ? 'mcp_effects_unknown' : 'tool_semantics_unknown' };
    if (limit > 0) { if (cache.size >= limit) cache.delete(cache.keys().next().value!); cache.set(key, structuredClone(parsed)); }
    return parsed;
  };
  const analyze = async (input: AnalysisInput, signal: AbortSignal): Promise<ToolAnalysis> => {
    signal.throwIfAborted();
    jsonInput(input.input, input.tool.inputSchema);
    const parsed = parse(input);
    const environment: Record<string, string> = { '$operation': operationKey(input), '$policyOptions': hash({ writeRoots, pluginEntries }) };
    const actualCwd = await realpath(resolve(input.cwd));
    environment[`path:${resolve(input.cwd)}`] = await pathFingerprint(resolve(input.cwd), signal);
    if (!nativeFilesystemAnalysisSupported() && parsed.kind !== 'unknown') {
      return { analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION, environment, completeness: 'unknown',
        effects: [{ kind: 'unknown', scope: 'unknown' }], reasonCode: 'native_windows_unverified',
        evidence: [{ source: 'platform-support', detail: '未验证原生 Windows ADS/设备名/尾随点路径与 PowerShell 语义，不授予确定性文件权限。' }] };
    }
    const rootPaths = await validateWriteRoots(input.cwd, writeRoots, pluginEntries, signal);
    environment['$writeRoots'] = JSON.stringify(rootPaths);
    for (const path of writeRoots) environment[`writeRoot:${resolve(input.cwd, path)}`] = await pathFingerprint(resolve(input.cwd, path), signal);
    const base = { analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION, environment };
    if (parsed.kind === 'unknown' || parsed.kind === 'shell') {
      const snapshot = await checkpoint.analyze(input, signal);
      for (const [key, value] of Object.entries(snapshot.environment ?? {})) environment[`checkpoint:${key}`] = value;
    }
    if (parsed.kind === 'unknown') return { ...base, completeness: 'unknown', effects: [{ kind: 'unknown', scope: 'unknown' }], reasonCode: parsed.reasonCode,
      evidence: [{ source: 'registered-semantics', detail: 'Tool.risk 声明不等价于已验证的具体副作用。' }] };
    if (parsed.kind === 'shell') {
      // 捕获会影响解释器行为的环境，不发送原值；每次重验，不作为安全认证。
      const variables = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|Path|BASH_ENV|ENV|BASHOPTS|SHELLOPTS|BASH_FUNC_.*|LD_.*|DYLD_.*|RIPGREP_CONFIG_PATH)$/.test(key)));
      environment['$shellEnvironment'] = hash(variables);
      for (const key of ['BASH_ENV', 'ENV']) {
        const path = process.env[key];
        if (path && !/[$`*?{}]/.test(path)) environment[`shell:${key}`] = await pathFingerprint(resolve(input.cwd, path), signal);
      }
      return { ...base, completeness: parsed.facts.complete ? 'partial' : 'unknown', effects: [{ kind: 'execute', target: actualCwd, scope: 'unknown' }], targets: [actualCwd],
        reasonCode: parsed.dangerous ? 'shell_dangerous' : parsed.facts.complete ? 'shell_environment_unverified' : parsed.facts.reasonCode,
        evidence: [{ source: 'literal-shell-parser', detail: JSON.stringify(parsed.facts) },
          { source: 'execution-contract', detail: '字面量语法不足以验证解释器/PATH/BASH_ENV/继承函数；实际 bash 操作始终 defer。' }] };
    }
    const globEscape = parsed.kind === 'glob' && (isAbsolute(parsed.pattern) || parsed.pattern.replace(/\\/g, '/').split('/').includes('..'));
    const prefix = parsed.kind === 'glob' ? parsed.pattern.split('/').slice(0, parsed.pattern.split('/').findIndex((part) => /[?*{}[\]()!+@\\]/.test(part)) >>> 0).join('/') : '';
    const raw = parsed.kind === 'glob' ? resolve(input.cwd, parsed.path, parsed.literal ? parsed.pattern : prefix || '.') : parsed.path;
    if (foreignPath(raw) || parsed.kind === 'glob' && foreignPath(parsed.pattern)) {
      return { ...base, completeness: 'unknown', effects: [{ kind: parsed.kind === 'file' ? parsed.effect : 'read', target: raw, scope: 'external' }], targets: [raw],
        reasonCode: 'foreign_platform_path', evidence: [{ source: 'path-parser', detail: '其他平台的盘符、UNC 或反斜杠路径没有被当前文件系统验证。' }] };
    }
    const target = resolve(input.cwd, raw);
    const resolved = await resolveTarget(target, signal);
    environment[`path:${target}`] = await pathFingerprint(target, signal);
    const configuredEntries: string[] = [];
    for (const entry of pluginEntries) {
      const absolute = resolve(input.cwd, entry); const actual = await resolveTarget(absolute, signal);
      configuredEntries.push(absolute, actual.actual);
      environment[`plugin:${absolute}`] = await pathFingerprint(absolute, signal);
    }
    const sensitive = sensitivePath(target, configuredEntries) || sensitivePath(resolved.actual, configuredEntries)
      || parsed.kind === 'glob' && sensitivePath(resolve(input.cwd, parsed.path, parsed.pattern), configuredEntries);
    const scope = sensitive ? 'sensitive' : !globEscape && within(actualCwd, resolved.actual) ? 'project' : 'external';
    const effect = parsed.kind === 'file' ? parsed.effect : 'read';
    let completeness: ToolAnalysis['completeness'] = 'complete';
    let reasonCode = sensitive ? 'sensitive_path' : scope === 'external' ? 'outside_project' : 'bounded_file';
    if (parsed.kind === 'search') {
      completeness = 'partial'; reasonCode = 'recursive_search_or_rg_configuration';
      environment['$searchEnvironment'] = hash({ PATH: process.env.PATH, RIPGREP_CONFIG_PATH: process.env.RIPGREP_CONFIG_PATH });
      if (process.env.RIPGREP_CONFIG_PATH) environment['$ripgrepConfig'] = await pathFingerprint(resolve(input.cwd, process.env.RIPGREP_CONFIG_PATH), signal);
    }
    if (parsed.kind === 'glob' && !parsed.literal) { completeness = 'partial'; reasonCode = 'glob_expansion_unverified'; }
    if (effect === 'read' && (!resolved.exists || !resolved.regularFile) && parsed.kind !== 'search') { completeness = 'partial'; reasonCode = 'read_target_not_regular_file'; }
    if (parsed.kind === 'file' && resolved.exists && !resolved.regularFile) { completeness = 'unknown'; reasonCode = 'special_file_target'; }
    if (resolved.links > 1) { completeness = 'unknown'; reasonCode = 'hardlink_alias_unverified'; }
    return { ...base, completeness, effects: [{ kind: effect, target: resolved.actual, scope }], targets: [resolved.actual], reasonCode,
      evidence: [{ source: 'filesystem-realpath', detail: `${target} -> ${resolved.actual}` },
        { source: 'filesystem-kind', detail: resolved.exists ? resolved.regularFile ? 'regular-file' : 'non-regular-file' : `new-target; existing-parent=${resolved.parent}` }],
      summary: `${input.tool.name}: ${resolved.actual}` };
  };
  return { id: ANALYZER_ID, version: ANALYZER_VERSION, analyze,
    async revalidate(previous, input, signal) { return hash(previous) === hash(await analyze(input, signal)); },
    cacheStats: () => ({ entries: cache.size, hits, misses }) };
}

function foreignPath(path: string): boolean {
  return process.platform !== 'win32' && (/^[A-Za-z]:/.test(path) || path.includes('\\'));
}
function within(root: string, path: string): boolean {
  const difference = relative(root, path); return difference === '' || !difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference);
}
/** 只读验证显式作用域授权；项目外、敏感根或非目录根均不能启用。 */
export async function validateWriteRoots(cwd: string, roots: readonly string[], pluginEntries: readonly string[] = [], signal = new AbortController().signal): Promise<readonly string[]> {
  if (roots.length > 32) throw new Error('writeRoots 最多允许 32 个目录');
  const actualCwd = await realpath(resolve(cwd)); const result: string[] = [];
  for (const root of roots) {
    signal.throwIfAborted();
    if (typeof root !== 'string' || !root.trim() || root.includes('\0') || foreignPath(root)) throw new Error('writeRoots 必须是可验证的项目目录路径');
    const path = resolve(cwd, root); const target = await resolveTarget(path, signal);
    if (!within(actualCwd, target.actual) || sensitivePath(path, pluginEntries.map((entry) => resolve(cwd, entry))) || sensitivePath(target.actual, [])) throw new Error(`writeRoots 不允许项目外或敏感目录: ${root}`);
    if (target.exists && !(await lstat(target.actual)).isDirectory()) throw new Error(`writeRoots 目标必须为目录: ${root}`);
    if (!target.exists && !(await lstat(target.parent)).isDirectory()) throw new Error(`writeRoots 的现有父路径必须为目录: ${root}`);
    result.push(target.actual);
  }
  return [...new Set(result)].sort();
}
function sensitivePath(path: string, configuredEntries: readonly string[]): boolean {
  if (configuredEntries.some((entry) => resolve(entry) === resolve(path))) return true;
  const parts = path.replace(/\\/g, '/').toLowerCase().split('/');
  const basename = parts.at(-1) ?? '';
  return parts.some((part) => ['.git', '.ssh', '.aws', '.azure', '.gnupg', '.kube', 'credentials', 'secrets', 'plugins', '.codex', '.agentlab', '.agent'].includes(part))
    || parts.some((part, index) => part === '.git' && ['hooks', 'config', 'config.worktree'].includes(parts[index + 1] ?? ''))
    || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|agents\.md|claude\.md|agent\.config\.json|mcp\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/.test(basename);
}
async function resolveTarget(path: string, signal: AbortSignal, links = new Set<string>()): Promise<{ actual: string; parent: string; exists: boolean; regularFile: boolean; links: number }> {
  signal.throwIfAborted();
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink()) {
      if (links.has(path) || links.size > 40) throw new Error('Symbolic link cycle');
      links.add(path);
      return resolveTarget(resolve(dirname(path), await readlink(path)), signal, links);
    }
    const actual = await realpath(path); const stat = await lstat(actual);
    return { actual, parent: dirname(actual), exists: true, regularFile: stat.isFile(), links: stat.isFile() ? stat.nlink : 1 };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path); if (parent === path) throw error;
    const resolvedParent = await resolveTarget(parent, signal, links);
    return { actual: join(resolvedParent.actual, relative(parent, path)), parent: resolvedParent.exists ? resolvedParent.actual : resolvedParent.parent, exists: false, regularFile: false, links: 0 };
  }
}
async function pathFingerprint(path: string, signal: AbortSignal, links = new Set<string>()): Promise<string> {
  signal.throwIfAborted();
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) {
      if (links.has(path) || links.size > 40) throw new Error('Symbolic link cycle');
      links.add(path); const link = await readlink(path);
      return `link:${link}:${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${await pathFingerprint(resolve(dirname(path), link), signal, links)}`;
    }
    const actual = await realpath(path);
    const identity = `${actual}:${info.dev}:${info.ino}:${info.mode}`;
    if (info.isDirectory()) return identity;
    const metadata = `${identity}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    return info.isFile() && info.size <= 1024n * 1024n ? `${metadata}:${createHash('sha256').update(await readFile(path, { signal })).digest('hex')}` : metadata;
  } catch (error) {
    signal.throwIfAborted(); if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path); if (parent === path) throw error;
    return `missing:${await pathFingerprint(parent, signal, links)}`;
  }
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
}
