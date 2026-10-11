/** 分析器各文件共用的标识、操作种类和指纹。 */
import { createHash } from 'node:crypto';
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import type { createEnvironmentAnalyzer } from './environment.js';

export const ANALYZER_ID = 'deterministic-operations';
export const ANALYZER_VERSION = '2.6.2';

/** 平台声明，不是跨平台实测：尚未验证 NTFS ADS/设备名/尾随点等语义。 */
export function nativeFilesystemAnalysisSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== 'win32';
}

const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i;

/**
 * 原生 Windows 上已知会让同一文件出现多个名字、或指向设备/命名空间的路径形态：UNC 与 \\?\ 设备命名空间、
 * NTFS 备用数据流（盘符外的冒号）、尾随点/空格、8.3 短名（~数字）、保留设备名。命中时不交给模型，仍由人工确认。
 */
export function windowsAmbiguousPath(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) return true;
  const body = path.replace(/^[A-Za-z]:/, '');
  if (body.includes(':')) return true;
  return body
    .split(/[\\/]/)
    .some(
      (part) =>
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        (/[. ]$/.test(part) || /~\d/.test(part) || WINDOWS_RESERVED_NAME.test(part)),
    );
}

export interface AnalyzerOptions {
  pluginEntries?: readonly string[];
  writeRoots?: readonly string[];
  parseCacheSize?: number;
  /** 平台判断注入点，默认 process.platform；测试用它在任意宿主上覆盖原生 Windows 分支。 */
  platform?: NodeJS.Platform;
}

export type ParsedOperation =
  | { kind: 'file'; path: string; effect: 'read' | 'write' }
  | { kind: 'glob'; path: string; pattern: string }
  | { kind: 'shell'; command: string; dangerous: boolean }
  | { kind: 'search'; path: string; pattern: string }
  | { kind: 'unknown'; reasonCode: string };

export type ShellOperation = Extract<ParsedOperation, { kind: 'shell' }>;
export type UnknownOperation = Extract<ParsedOperation, { kind: 'unknown' }>;
export type FilesystemOperation = Exclude<ParsedOperation, ShellOperation | UnknownOperation>;

export interface AnalyzerContext {
  platform: NodeJS.Platform;
  writeRoots: readonly string[];
  pluginEntries: readonly string[];
  checkpoint: ReturnType<typeof createEnvironmentAnalyzer>;
}

export interface OpenedAnalysis {
  environment: Record<string, string>;
  actualCwd: string;
  /** 调用目录本身已是未验收的 Windows 路径，后面的分析不用再做。 */
  stop?: ToolAnalysis;
}

export function described(environment: Record<string, string>) {
  return { analyzerId: ANALYZER_ID, analyzerVersion: ANALYZER_VERSION, environment };
}

/** 可复用的是纯语法结果。完整输入、工具/分析版本、cwd 和 revision 都在键中。 */
export function operationKey(input: AnalysisInput): string {
  const revisions = input as AnalysisInput & {
    configRevision?: string | number;
    policyRevision?: string | number;
  };
  return hash({
    analyzerId: ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    tool: {
      name: input.tool.name,
      version: input.tool.version ?? 'unversioned',
      ownerPlugin: input.tool.ownerPlugin ?? 'unknown',
      risk: input.tool.risk,
      inputSchema: input.tool.inputSchema,
    },
    input: input.input,
    cwd: input.cwd,
    configRevision: revisions.configRevision ?? 'unspecified',
    policyRevision: revisions.policyRevision ?? 'unspecified',
  });
}

export function hash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
}
