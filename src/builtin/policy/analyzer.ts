/** 具体操作分析：只读取前提，不执行工具，不缓存环境或批准。 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AnalysisInput, ToolAnalysis, ToolAnalyzer } from '../../sdk/capabilities.js';
import { createEnvironmentAnalyzer } from './environment.js';
import { analyzeCommand } from '../../tools/bash.js';
import { analyzeReadOnlyShell } from '../../tools/shell-readonly.js';
import { collectSearchFiles, sensitivePath, within, foreignPath, searchPatternScope, projectRelativePattern, type SearchFile } from '../../tools/search-scope.js';
import { jsonInput } from '../../core/permission/input-validation.js';

export const ANALYZER_ID = 'deterministic-operations';
export const ANALYZER_VERSION = '2.5.0';
/** 平台声明，不是跨平台实测：尚未验证 NTFS ADS/设备名/尾随点等语义。 */
export function nativeFilesystemAnalysisSupported(platform: NodeJS.Platform = process.platform): boolean { return platform !== 'win32'; }
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;
/**
 * 原生 Windows 上已知会让同一文件出现多个名字、或指向设备/命名空间的路径形态：UNC 与 \\?\ 设备命名空间、
 * NTFS 备用数据流（盘符外的冒号）、尾随点/空格、8.3 短名（~数字）、保留设备名。命中时不交给模型，仍由人工确认。
 */
export function windowsAmbiguousPath(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) return true;
  const body = path.replace(/^[A-Za-z]:/, '');
  if (body.includes(':')) return true;
  return body.split(/[\\/]/).some((part) => part !== '' && part !== '.' && part !== '..'
    && (/[. ]$/.test(part) || /~\d/.test(part) || WINDOWS_RESERVED_NAME.test(part)));
}
const WINDOWS_READ_NOTE = 'Windows 平台未做文件系统校验：通用分析已完整执行（真实路径、项目边界、敏感名称、链接逃逸、多硬链接、非普通文件与受控搜索枚举均已检查并绑定），'
  + '但 NTFS 备用数据流、8.3 短名、设备名、尾随点/空格、junction/reparse point 等平台特有语义未经实机验收，且已拦截这些歧义路径形态；'
  + '因此策略不确定性放行，而是委托模型按当前用户要求审查这次项目内只读操作。';
export interface AnalyzerOptions {
  pluginEntries?: readonly string[]; writeRoots?: readonly string[]; parseCacheSize?: number;
  /** 平台判断注入点，默认 process.platform；测试用它在任意宿主上覆盖原生 Windows 分支。 */
  platform?: NodeJS.Platform;
}
type ParsedOperation =
  | { kind: 'file'; path: string; effect: 'read' | 'write' }
  | { kind: 'glob'; path: string; pattern: string }
  | { kind: 'shell'; command: string; dangerous: boolean }
  | { kind: 'search'; path: string; pattern: string }
  | { kind: 'unknown'; reasonCode: string };

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
      parsed = { kind: 'glob', path: typeof data.path === 'string' ? data.path : '.', pattern: data.pattern };
    } else if (input.tool.name === 'grep') {
      parsed = { kind: 'search', path: typeof data.path === 'string' ? data.path : '.', pattern: typeof data.glob === 'string' ? data.glob : '**/*' };
    } else if (input.tool.name === 'bash') parsed = { kind: 'shell', command: String(data.command ?? ''),
      dangerous: typeof data.command === 'string' && analyzeCommand(data.command).dangerous };
    else parsed = { kind: 'unknown', reasonCode: input.tool.name.startsWith('mcp') || input.tool.name.includes('__') ? 'mcp_effects_unknown' : 'tool_semantics_unknown' };
    if (limit > 0) { if (cache.size >= limit) cache.delete(cache.keys().next().value!); cache.set(key, structuredClone(parsed)); }
    return parsed;
  };
  const platform = options.platform ?? process.platform;
  const analyze = async (input: AnalysisInput, signal: AbortSignal): Promise<ToolAnalysis> => {
    signal.throwIfAborted();
    jsonInput(input.input, input.tool.inputSchema);
    const parsed = parse(input);
    const windows = !nativeFilesystemAnalysisSupported(platform);
    // 原生 Windows：只有内置只读工具（read_file/glob/grep）沿用通用分析并降级为“待模型审批”；写入、Shell 仍整体未验证。
    const windowsRead = windows && (parsed.kind === 'glob' || parsed.kind === 'search' || parsed.kind === 'file' && parsed.effect === 'read')
      && ![parsed.path, parsed.kind === 'file' ? '' : parsed.pattern].some((value) => value && windowsAmbiguousPath(value));
    if (!windowsRead) return analyzeOperation(input, parsed, windows, signal);
    const result = await analyzeOperation(input, parsed, false, signal);
    const projectRead = result.completeness === 'complete' && result.effects.length > 0
      && result.effects.every((effect) => effect.kind === 'read' && effect.scope === 'project')
      && !(result.targets ?? []).some((target) => windowsAmbiguousPath(target));
    // 敏感、项目外、特殊文件、硬链接等结论保持原样（仍人工）；只有通用逻辑判定为项目内完整读取的才交给模型。
    // 通用分析本身是完整的，completeness 保持 'complete'（不违背审查合约“分析不完整则 ask/unknown”）；
    // 平台风险用 reasonCode + 证据表达，策略据此委托 reviewer，而不会确定性放行（见 policy/index.ts）。
    return projectRead ? { ...result, reasonCode: 'native_windows_read_unverified',
      evidence: [{ source: 'platform-support', detail: WINDOWS_READ_NOTE }, ...(result.evidence ?? [])] } : result;
  };
  const analyzeOperation = async (input: AnalysisInput, parsed: ParsedOperation, windows: boolean, signal: AbortSignal): Promise<ToolAnalysis> => {
    const environment: Record<string, string> = { '$operation': operationKey(input), '$policyOptions': hash({ writeRoots, pluginEntries }) };
    const actualCwd = await realpath(resolve(input.cwd));
    environment[`path:${resolve(input.cwd)}`] = await pathFingerprint(resolve(input.cwd), signal);
    if (windows && parsed.kind !== 'unknown') {
      return { analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION, environment, completeness: 'unknown',
        effects: [{ kind: 'unknown', scope: 'unknown' }], reasonCode: 'native_windows_unverified',
        evidence: [{ source: 'platform-support', detail: '未验证原生 Windows ADS/设备名/尾随点路径与 PowerShell 语义，不授予确定性文件权限。' }] };
    }
    const rootPaths = await validateWriteRoots(input.cwd, writeRoots, pluginEntries, signal);
    environment['$writeRoots'] = JSON.stringify(rootPaths);
    for (const path of writeRoots) environment[`writeRoot:${resolve(input.cwd, path)}`] = await pathFingerprint(resolve(input.cwd, path), signal);
    const base = { analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION, environment };
    if (parsed.kind === 'unknown') {
      const snapshot = await checkpoint.analyze(input, signal);
      for (const [key, value] of Object.entries(snapshot.environment ?? {})) environment[`checkpoint:${key}`] = value;
    }
    if (parsed.kind === 'unknown') return { ...base, completeness: 'unknown', effects: [{ kind: 'unknown', scope: 'unknown' }], reasonCode: parsed.reasonCode,
      evidence: [{ source: 'registered-semantics', detail: 'Tool.risk 声明不等价于已验证的具体副作用。' }] };
    if (parsed.kind === 'shell') {
      const contract = await analyzeReadOnlyShell(parsed.command, input.cwd, pluginEntries, signal);
      Object.assign(environment, contract.environment);
      if (contract.complete && contract.command && !parsed.dangerous) {
        environment['$shellContract'] = JSON.stringify(contract);
        environment['$shellPluginEntries'] = JSON.stringify(pluginEntries);
        return { ...base, completeness: 'complete', effects: contract.effects, targets: contract.targets,
          reasonCode: contract.reasonCode,
          evidence: [{ source: 'controlled-shell-contract', detail: JSON.stringify({ commands: contract.commands, unresolved: contract.unresolved, contract: 'AST + literal argv + canonical targets + controlled bash' }) }],
          summary: `bash: ${parsed.command}` };
      }
      // 未知命令继续原审批路径；环境指纹不能代替具体执行授权。
      const snapshot = await checkpoint.analyze(input, signal);
      for (const [key, value] of Object.entries(snapshot.environment ?? {})) environment[`checkpoint:${key}`] = value;
      const variables = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|Path|BASH_ENV|ENV|BASHOPTS|SHELLOPTS|BASH_FUNC_.*|LD_.*|DYLD_.*|RIPGREP_CONFIG_PATH)$/.test(key)));
      environment['$shellEnvironment'] = hash(variables);
      for (const key of ['BASH_ENV', 'ENV']) {
        const path = process.env[key];
        if (path && !/[$`*?{}]/.test(path)) environment[`shell:${key}`] = await pathFingerprint(resolve(input.cwd, path), signal);
      }
      return { ...base, completeness: 'unknown', effects: contract.effects.length ? contract.effects : [{ kind: 'execute', target: actualCwd, scope: 'unknown' }], targets: contract.targets,
        reasonCode: parsed.dangerous ? 'shell_dangerous' : contract.reasonCode,
        evidence: [{ source: 'controlled-shell-contract', detail: JSON.stringify({ reason: contract.reasonCode, commands: contract.commands, unresolved: contract.unresolved }) }] };
    }
    const raw = parsed.kind === 'file' ? parsed.path : parsed.path || '.';
    if (foreignPath(raw)) {
      return { ...base, completeness: 'unknown', effects: [{ kind: parsed.kind === 'file' ? parsed.effect : 'read', target: raw, scope: 'external' }], targets: [raw],
        reasonCode: 'foreign_platform_path', evidence: [{ source: 'path-parser', detail: '其他平台的路径没有被当前文件系统验证。' }] };
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
    // 项目内绝对 glob 与执行侧（collectSearchFiles）同样先转为相对 pattern。
    const pattern = parsed.kind === 'file' ? '' : projectRelativePattern(parsed.pattern, [target, resolved.actual]);
    const access = parsed.kind === 'file' && parsed.effect === 'write' ? 'write' : 'read';
    const patternScope = parsed.kind === 'file' ? 'project' : searchPatternScope(pattern, target, configuredEntries);
    // 明确前缀/字面文件也做真实路径检查；泛型 **/* 不因排除项而整批升级为 ask。
    const parts = parsed.kind === 'file' ? [] : pattern.split('/');
    const prefix = parts.slice(0, parts.findIndex((part) => /[?*{}[\]()!+@\\]/.test(part)) >>> 0).join('/');
    const intended = prefix ? await resolveTarget(resolve(target, prefix), signal) : resolved;
    if (prefix) environment[`searchPrefix:${resolve(target, prefix)}`] = await pathFingerprint(resolve(target, prefix), signal);
    const sensitive = sensitivePath(target, configuredEntries, access) || sensitivePath(resolved.actual, configuredEntries, access) || patternScope === 'sensitive'
      || prefix !== '' && (sensitivePath(resolve(target, prefix), configuredEntries, access) || sensitivePath(intended.actual, configuredEntries, access));
    const scope = sensitive ? 'sensitive' : patternScope !== 'external' && within(actualCwd, resolved.actual) && within(actualCwd, intended.actual) ? 'project' : 'external';
    if (parsed.kind === 'glob' || parsed.kind === 'search') {
      if (parsed.kind === 'glob' && !/[?*{}[\]()!+@\\]/.test(pattern)) environment['$searchLiteral'] = intended.actual;
      const ignoreFiles: SearchFile[] = [];
      const files = scope === 'project' ? await collectSearchFiles(actualCwd, resolved.actual, pattern, configuredEntries, signal, parsed.kind === 'search', (file) => ignoreFiles.push(file)) : [];
      const reads = [...files, ...ignoreFiles.sort((a, b) => a.absolute.localeCompare(b.absolute))];
      // 重验重新枚举并绑定实际候选集合；新增文件和别名变化不会复用旧的审批。
      environment['$searchFiles'] = hash(reads);
      return { ...base, completeness: scope === 'project' && intended.links <= 1 ? 'complete' : 'partial',
        effects: [{ kind: 'read', target: resolved.actual, scope }, ...reads.map((file) => ({ kind: 'read' as const, target: file.absolute, scope: 'project' as const }))],
        targets: [...new Set([resolved.actual, intended.actual]), ...reads.map((file) => file.absolute)],
        reasonCode: sensitive ? 'sensitive_path' : scope === 'external' ? 'outside_project' : intended.links > 1 ? 'hardlink_alias_unverified' : 'bounded_search',
        evidence: [{ source: 'bounded-search-contract', detail: '固定目录枚举，不跟随链接；排除敏感路径、配置插件入口、外部目标及非普通/多硬链接文件。' }],
        summary: `${input.tool.name}: ${resolved.actual}` };
    }
    const effect = parsed.kind === 'file' ? parsed.effect : 'read';
    let completeness: ToolAnalysis['completeness'] = 'complete';
    let reasonCode = sensitive ? 'sensitive_path' : scope === 'external' ? 'outside_project' : 'bounded_file';
    // 项目内不存在的目标或目录：读取不返回文件内容也无副作用，由工具返回 ENOENT/EISDIR；执行前重验仍绑定 missing/目录指纹。
    // 敏感与项目外作用域已由 scope 表达，策略照旧要求人工确认。
    if (effect === 'read' && !resolved.exists) { if (scope === 'project') reasonCode = 'read_target_missing'; }
    else if (effect === 'read' && resolved.directory) { if (scope === 'project') reasonCode = 'read_target_directory'; }
    else if (parsed.kind === 'file' && resolved.exists && !resolved.regularFile) { completeness = 'unknown'; reasonCode = 'special_file_target'; }
    // 多硬链接一律视为未验证别名：路径段（如 node_modules）无法证明 inode 来自包管理器 store，
    // 同用户进程可把项目外密钥硬链接进项目；store 本身也可被同用户写入，按内容哈希比对同样不能证明来源。
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
async function resolveTarget(path: string, signal: AbortSignal, links = new Set<string>()): Promise<{ actual: string; parent: string; exists: boolean; regularFile: boolean; directory: boolean; links: number }> {
  signal.throwIfAborted();
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink()) {
      if (links.has(path) || links.size > 40) throw new Error('Symbolic link cycle');
      links.add(path);
      return resolveTarget(resolve(dirname(path), await readlink(path)), signal, links);
    }
    const actual = await realpath(path); const stat = await lstat(actual);
    return { actual, parent: dirname(actual), exists: true, regularFile: stat.isFile(), directory: stat.isDirectory(), links: stat.isFile() ? stat.nlink : 1 };
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const parent = dirname(path); if (parent === path) throw error;
    const resolvedParent = await resolveTarget(parent, signal, links);
    return { actual: join(resolvedParent.actual, relative(parent, path)), parent: resolvedParent.exists ? resolvedParent.actual : resolvedParent.parent, exists: false, regularFile: false, directory: false, links: 0 };
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
