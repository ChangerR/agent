/**
 * 工具调用分析的入口：只读取前提，不执行工具，不缓存环境或批准。
 *
 * route() 按种类分发：
 * - shell → analyzer-shell.ts（Windows 是 PowerShell，其余是 bash）
 * - 文件和搜索 → analyzer-files.ts
 * - 未知工具留在本文件，不猜测副作用
 * 路径绑定在 analyzer-paths.ts。
 */
import type { AnalysisInput, ToolAnalysis, ToolAnalyzer } from '../../sdk/capabilities.js';
import { jsonInput } from '../../core/permission/input-validation.js';
import { analyzeCommand } from '../../tools/bash.js';
import { createEnvironmentAnalyzer } from './environment.js';
import { analyzeFilesystem, stampWindowsFilesystem, windowsInputIsAmbiguous } from './analyzer-files.js';
import { prepare, windowsUnverified } from './analyzer-paths.js';
import { analyzeShell } from './analyzer-shell.js';
import {
  ANALYZER_ID,
  ANALYZER_VERSION,
  described,
  hash,
  operationKey,
  type AnalyzerContext,
  type AnalyzerOptions,
  type ParsedOperation,
  type UnknownOperation,
} from './analyzer-types.js';

export {
  ANALYZER_ID,
  ANALYZER_VERSION,
  hash,
  nativeFilesystemAnalysisSupported,
  operationKey,
  windowsAmbiguousPath,
} from './analyzer-types.js';
export type { AnalyzerOptions } from './analyzer-types.js';
export { validateWriteRoots } from './analyzer-paths.js';

function parseOperation(input: AnalysisInput): ParsedOperation {
  const data = input.input;
  if (input.tool.ownerPlugin !== 'agentlab.local-tools' || input.tool.version !== '1.0.0')
    return { kind: 'unknown', reasonCode: 'unverified_tool_implementation' };
  if (
    ['read_file', 'write_file', 'edit_file'].includes(input.tool.name) &&
    typeof data.path === 'string' &&
    data.path.length > 0
  ) {
    return {
      kind: 'file',
      path: data.path,
      effect: input.tool.name === 'read_file' ? 'read' : 'write',
    };
  }
  if (input.tool.name === 'glob' && typeof data.pattern === 'string') {
    return {
      kind: 'glob',
      path: typeof data.path === 'string' ? data.path : '.',
      pattern: data.pattern,
    };
  }
  if (input.tool.name === 'grep') {
    return {
      kind: 'search',
      path: typeof data.path === 'string' ? data.path : '.',
      pattern: typeof data.glob === 'string' ? data.glob : '**/*',
    };
  }
  if (input.tool.name === 'bash') {
    return {
      kind: 'shell',
      command: String(data.command ?? ''),
      dangerous: typeof data.command === 'string' && analyzeCommand(data.command).dangerous,
    };
  }
  return {
    kind: 'unknown',
    reasonCode:
      input.tool.name.startsWith('mcp') || input.tool.name.includes('__')
        ? 'mcp_effects_unknown'
        : 'tool_semantics_unknown',
  };
}

async function route(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: ParsedOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const windows = ctx.platform === 'win32';
  if (parsed.kind === 'shell') return analyzeShell(ctx, input, parsed, windows, signal);
  if (parsed.kind === 'unknown') return analyzeUnknown(ctx, input, parsed, signal);
  if (windows && windowsInputIsAmbiguous(parsed)) return windowsUnverified(ctx, input, signal);
  const result = await analyzeFilesystem(ctx, input, parsed, signal);
  return windows ? stampWindowsFilesystem(result) : result;
}

async function analyzeUnknown(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: UnknownOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const opened = await prepare(ctx, input, signal);
  if (opened.stop) return opened.stop;
  const snapshot = await ctx.checkpoint.analyze(input, signal);
  for (const [key, value] of Object.entries(snapshot.environment ?? {}))
    opened.environment[`checkpoint:${key}`] = value;
  return {
    ...described(opened.environment),
    completeness: 'unknown',
    effects: [{ kind: 'unknown', scope: 'unknown' }],
    reasonCode: parsed.reasonCode,
    evidence: [
      { source: 'registered-semantics', detail: 'Tool.risk 声明不等价于已验证的具体副作用。' },
    ],
  };
}

export function createDeterministicAnalyzer(
  options: AnalyzerOptions = {},
): ToolAnalyzer & { cacheStats(): { entries: number; hits: number; misses: number } } {
  const writeRoots = Object.freeze([...(options.writeRoots ?? [])]);
  const pluginEntries = Object.freeze([...(options.pluginEntries ?? [])]);
  const cache = new Map<string, ParsedOperation>();
  let hits = 0;
  let misses = 0;
  const limit = Math.max(0, Math.min(options.parseCacheSize ?? 128, 1024));
  const checkpoint = createEnvironmentAnalyzer();
  const ctx: AnalyzerContext = {
    platform: options.platform ?? process.platform,
    writeRoots,
    pluginEntries,
    checkpoint,
  };
  const parse = (input: AnalysisInput): ParsedOperation => {
    const key = hash({ operation: operationKey(input), writeRoots, pluginEntries });
    const cached = cache.get(key);
    if (cached) {
      hits++;
      return structuredClone(cached);
    }
    misses++;
    const parsed = parseOperation(input);
    if (limit > 0) {
      if (cache.size >= limit) cache.delete(cache.keys().next().value!);
      cache.set(key, structuredClone(parsed));
    }
    return parsed;
  };
  const analyze = async (input: AnalysisInput, signal: AbortSignal): Promise<ToolAnalysis> => {
    signal.throwIfAborted();
    jsonInput(input.input, input.tool.inputSchema);
    return route(ctx, input, parse(input), signal);
  };
  return {
    id: ANALYZER_ID,
    version: ANALYZER_VERSION,
    analyze,
    async revalidate(previous, input, signal) {
      return hash(previous) === hash(await analyze(input, signal));
    },
    cacheStats: () => ({ entries: cache.size, hits, misses }),
  };
}
