/** read_file / write_file / edit_file / glob / grep 的文件系统分析。 */
import { resolve } from 'node:path';
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import {
  collectSearchFiles,
  foreignPath,
  projectRelativePattern,
  searchPatternScope,
  sensitivePath,
  within,
  type SearchFile,
} from '../../tools/search-scope.js';
import {
  pathFingerprint,
  prepare,
  resolveTarget,
  windowsPathUnverified,
  type ResolvedTarget,
} from './analyzer-paths.js';
import {
  described,
  hash,
  windowsAmbiguousPath,
  type FilesystemOperation,
} from './analyzer-types.js';
import type { AnalyzerContext } from './analyzer-types.js';

const WINDOWS_WRITE_NOTE =
  'Windows 平台未做文件系统校验：通用分析已完整执行（真实路径、项目边界、敏感与写保护目标、链接逃逸、多硬链接、非普通文件、新文件实际父目录均已检查并绑定），' +
  '但 NTFS 备用数据流、8.3 短名、设备名、尾随点/空格、junction/reparse point 等平台特有语义未经实机验收，且已拦截这些歧义路径形态；' +
  '因此除用户亲自配置或记住的精确目标规则外，策略不确定性放行，而是委托模型按当前用户要求审查这次项目内普通文件写入。';

/** 歧义路径不走通用文件分析，直接视为 Windows 未验收。 */
export function windowsInputIsAmbiguous(parsed: FilesystemOperation): boolean {
  if (parsed.kind === 'file') return windowsAmbiguousPath(parsed.path);
  return [parsed.path, parsed.pattern].some((value) => value.length > 0 && windowsAmbiguousPath(value));
}

export function stampWindowsFilesystem(analysis: ToolAnalysis): ToolAnalysis {
  if ((analysis.targets ?? []).some(windowsAmbiguousPath)) return windowsPathUnverified(analysis);
  const { effects } = analysis;
  const complete = analysis.completeness === 'complete' && effects.length > 0;
  if (complete && effects.every((effect) => effect.kind === 'write' && effect.scope === 'project'))
    return noteWindows(analysis, 'native_windows_write_unverified', WINDOWS_WRITE_NOTE);
  return analysis;
}

function noteWindows(analysis: ToolAnalysis, reasonCode: string, detail: string): ToolAnalysis {
  return {
    ...analysis,
    reasonCode,
    evidence: [{ source: 'platform-support', detail }, ...(analysis.evidence ?? [])],
  };
}

/** 找到第一个通配片段；没有通配符时保留整段，当作字面路径前缀。 */
function literalPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const metaAt = parts.findIndex((part) => /[?*{}[\]()!+@\\]/.test(part));
  return parts.slice(0, metaAt === -1 ? parts.length : metaAt).join('/');
}

export async function analyzeFilesystem(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: FilesystemOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const opened = await prepare(ctx, input, signal);
  if (opened.stop) return opened.stop;
  const { environment, actualCwd } = opened;
  const base = described(environment);
  const raw = parsed.path || '.';
  if (foreignPath(raw)) {
    return {
      ...base,
      completeness: 'unknown',
      effects: [
        { kind: parsed.kind === 'file' ? parsed.effect : 'read', target: raw, scope: 'external' },
      ],
      targets: [raw],
      reasonCode: 'foreign_platform_path',
      evidence: [{ source: 'path-parser', detail: '其他平台的路径没有被当前文件系统验证。' }],
    };
  }
  const target = resolve(input.cwd, raw);
  const resolved = await resolveTarget(target, signal);
  environment[`path:${target}`] = await pathFingerprint(target, signal);
  const configuredEntries: string[] = [];
  for (const entry of ctx.pluginEntries) {
    const absolute = resolve(input.cwd, entry);
    const actual = await resolveTarget(absolute, signal);
    configuredEntries.push(absolute, actual.actual);
    environment[`plugin:${absolute}`] = await pathFingerprint(absolute, signal);
  }
  const pattern =
    parsed.kind === 'file' ? '' : projectRelativePattern(parsed.pattern, [target, resolved.actual]);
  const access = parsed.kind === 'file' && parsed.effect === 'write' ? 'write' : 'read';
  const patternScope =
    parsed.kind === 'file' ? 'project' : searchPatternScope(pattern, target, configuredEntries);
  const prefix = parsed.kind === 'file' ? '' : literalPrefix(pattern);
  const intended = prefix ? await resolveTarget(resolve(target, prefix), signal) : resolved;
  if (prefix)
    environment[`searchPrefix:${resolve(target, prefix)}`] = await pathFingerprint(
      resolve(target, prefix),
      signal,
    );
  const sensitive =
    sensitivePath(target, configuredEntries, access) ||
    sensitivePath(resolved.actual, configuredEntries, access) ||
    patternScope === 'sensitive' ||
    (prefix !== '' &&
      (sensitivePath(resolve(target, prefix), configuredEntries, access) ||
        sensitivePath(intended.actual, configuredEntries, access)));
  const scope = sensitive
    ? 'sensitive'
    : patternScope !== 'external' &&
        within(actualCwd, resolved.actual) &&
        within(actualCwd, intended.actual)
      ? 'project'
      : 'external';
  if (parsed.kind === 'glob' || parsed.kind === 'search')
    return analyzeSearch(input, parsed, {
      base,
      environment,
      actualCwd,
      resolved,
      pattern,
      intended,
      sensitive,
      scope,
      configuredEntries,
      signal,
    });
  return analyzeOneFile(input, parsed, { base, resolved, target, sensitive, scope });
}

async function analyzeSearch(
  input: AnalysisInput,
  parsed: Extract<FilesystemOperation, { kind: 'glob' | 'search' }>,
  located: {
    base: ReturnType<typeof described>;
    environment: Record<string, string>;
    actualCwd: string;
    resolved: ResolvedTarget;
    pattern: string;
    intended: ResolvedTarget;
    sensitive: boolean;
    scope: 'sensitive' | 'project' | 'external';
    configuredEntries: string[];
    signal: AbortSignal;
  },
): Promise<ToolAnalysis> {
  const {
    base,
    environment,
    actualCwd,
    resolved,
    pattern,
    intended,
    sensitive,
    scope,
    configuredEntries,
    signal,
  } = located;
  if (parsed.kind === 'glob' && !/[?*{}[\]()!+@\\]/.test(pattern))
    environment['$searchLiteral'] = intended.actual;
  const ignoreFiles: SearchFile[] = [];
  const files =
    scope === 'project'
      ? await collectSearchFiles(
          actualCwd,
          resolved.actual,
          pattern,
          configuredEntries,
          signal,
          parsed.kind === 'search',
          (file) => ignoreFiles.push(file),
        )
      : [];
  const reads = [...files, ...ignoreFiles.sort((a, b) => a.absolute.localeCompare(b.absolute))];
  environment['$searchFiles'] = hash(reads);
  return {
    ...base,
    completeness: scope === 'project' && intended.links <= 1 ? 'complete' : 'partial',
    effects: [
      { kind: 'read', target: resolved.actual, scope },
      ...reads.map((file) => ({
        kind: 'read' as const,
        target: file.absolute,
        scope: 'project' as const,
      })),
    ],
    targets: [...new Set([resolved.actual, intended.actual]), ...reads.map((file) => file.absolute)],
    reasonCode: sensitive
      ? 'sensitive_path'
      : scope === 'external'
        ? 'outside_project'
        : intended.links > 1
          ? 'hardlink_alias_unverified'
          : 'bounded_search',
    evidence: [
      {
        source: 'bounded-search-contract',
        detail: '固定目录枚举，不跟随链接；排除敏感路径、配置插件入口、外部目标及非普通/多硬链接文件。',
      },
    ],
    summary: `${input.tool.name}: ${resolved.actual}`,
  };
}

function analyzeOneFile(
  input: AnalysisInput,
  parsed: Extract<FilesystemOperation, { kind: 'file' }>,
  located: {
    base: ReturnType<typeof described>;
    resolved: ResolvedTarget;
    target: string;
    sensitive: boolean;
    scope: 'sensitive' | 'project' | 'external';
  },
): ToolAnalysis {
  const { base, resolved, target, sensitive, scope } = located;
  const effect = parsed.effect;
  let completeness: ToolAnalysis['completeness'] = 'complete';
  let reasonCode = sensitive ? 'sensitive_path' : scope === 'external' ? 'outside_project' : 'bounded_file';
  if (effect === 'read' && !resolved.exists) {
    if (scope === 'project') reasonCode = 'read_target_missing';
  } else if (effect === 'read' && resolved.directory) {
    if (scope === 'project') reasonCode = 'read_target_directory';
  } else if (resolved.exists && !resolved.regularFile) {
    completeness = 'unknown';
    reasonCode = 'special_file_target';
  }
  if (resolved.links > 1) {
    completeness = 'unknown';
    reasonCode = 'hardlink_alias_unverified';
  }
  return {
    ...base,
    completeness,
    effects: [{ kind: effect, target: resolved.actual, scope }],
    targets: [resolved.actual],
    reasonCode,
    evidence: [
      { source: 'filesystem-realpath', detail: `${target} -> ${resolved.actual}` },
      {
        source: 'filesystem-kind',
        detail: resolved.exists
          ? resolved.regularFile
            ? 'regular-file'
            : 'non-regular-file'
          : `new-target; existing-parent=${resolved.parent}`,
      },
    ],
    summary: `${input.tool.name}: ${resolved.actual}`,
  };
}
