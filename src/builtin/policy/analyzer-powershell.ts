/** PowerShell 分析。bash 语法树在 analyzer-shell.ts，两边不要写进同一个文件。 */
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import { windowsDedicatedFileCommand } from '../../tools/powershell.js';
import { bindCwd } from './analyzer-paths.js';
import {
  described,
  hash,
  operationKey,
  type AnalyzerContext,
  type ShellOperation,
} from './analyzer-types.js';

export async function analyzePowerShell(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: ShellOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  if (windowsDedicatedFileCommand(parsed.command))
    return powershellFileRead(input, parsed.command, ctx);
  return analyzeWindowsShell(ctx, input, parsed, signal);
}

/** 歧义调用目录仍停在人工约束。其余 PowerShell 不在这里改成人工，交给策略按模式兜底。 */
async function analyzeWindowsShell(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: ShellOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const opened = await bindCwd(ctx, input, signal);
  if (opened.stop) return opened.stop;
  const dangerous = parsed.dangerous;
  return {
    ...described(opened.environment),
    completeness: 'unknown',
    effects: [{ kind: 'execute', target: opened.actualCwd, scope: 'unknown' }],
    reasonCode: dangerous ? 'shell_dangerous' : 'native_windows_shell_unverified',
    evidence: [
      {
        source: dangerous ? 'command-scanner' : 'platform-support',
        detail: dangerous
          ? '危险命令检测命中，不交给 reviewer。'
          : 'PowerShell 语义未验收，不能确定性放行。auto 把这次操作交给 reviewer。',
      },
    ],
    summary: `bash: ${parsed.command}`,
  };
}

function powershellFileRead(
  input: AnalysisInput,
  command: string,
  ctx: AnalyzerContext,
): ToolAnalysis {
  return {
    ...described({
      $operation: operationKey(input),
      $policyOptions: hash({ writeRoots: ctx.writeRoots, pluginEntries: ctx.pluginEntries }),
    }),
    completeness: 'unknown',
    effects: [{ kind: 'read', scope: 'unknown' }],
    reasonCode: 'windows_shell_dedicated_tool',
    evidence: [
      {
        source: 'platform-support',
        detail:
          '命令只包含读文件、列目录或搜索内容的 PowerShell。这些事已有 read_file、glob、grep，不执行 shell。',
      },
    ],
    summary: `bash: ${command}`,
  };
}
