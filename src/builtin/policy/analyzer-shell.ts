/** Shell 分析：Windows 走 PowerShell 形状，其他平台走 bash 语法树。 */
import { resolve } from 'node:path';
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import { windowsDedicatedFileCommand } from '../../tools/powershell.js';
import { analyzeReadOnlyShell } from '../../tools/shell-readonly.js';
import { pathFingerprint, prepare, windowsUnverified } from './analyzer-paths.js';
import {
  described,
  hash,
  operationKey,
  type AnalyzerContext,
  type ShellOperation,
} from './analyzer-types.js';

export async function analyzeShell(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: ShellOperation,
  windows: boolean,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  if (windows && windowsDedicatedFileCommand(parsed.command))
    return powershellFileRead(input, parsed.command, ctx);
  if (windows) return windowsUnverified(ctx, input, signal);
  return analyzeBash(ctx, input, parsed, signal);
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

async function analyzeBash(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: ShellOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const opened = await prepare(ctx, input, signal);
  if (opened.stop) return opened.stop;
  const { environment, actualCwd } = opened;
  const contract = await analyzeReadOnlyShell(parsed.command, input.cwd, ctx.pluginEntries, signal);
  Object.assign(environment, contract.environment);
  if (contract.complete && contract.command && !parsed.dangerous) {
    environment['$shellContract'] = JSON.stringify(contract);
    environment['$shellPluginEntries'] = JSON.stringify(ctx.pluginEntries);
    return {
      ...described(environment),
      completeness: 'complete',
      effects: contract.effects,
      targets: contract.targets,
      reasonCode: contract.reasonCode,
      evidence: [
        {
          source: 'controlled-shell-contract',
          detail: JSON.stringify({
            commands: contract.commands,
            unresolved: contract.unresolved,
            contract: 'AST + literal argv + canonical targets + controlled bash',
          }),
        },
      ],
      summary: `bash: ${parsed.command}`,
    };
  }
  const snapshot = await ctx.checkpoint.analyze(input, signal);
  for (const [key, value] of Object.entries(snapshot.environment ?? {}))
    environment[`checkpoint:${key}`] = value;
  const variables = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|Path|BASH_ENV|ENV|BASHOPTS|SHELLOPTS|BASH_FUNC_.*|LD_.*|DYLD_.*|RIPGREP_CONFIG_PATH)$/.test(
        key,
      ),
    ),
  );
  environment['$shellEnvironment'] = hash(variables);
  for (const key of ['BASH_ENV', 'ENV']) {
    const path = process.env[key];
    if (path && !/[$`*?{}]/.test(path))
      environment[`shell:${key}`] = await pathFingerprint(resolve(input.cwd, path), signal);
  }
  return {
    ...described(environment),
    completeness: 'unknown',
    effects: contract.effects.length
      ? contract.effects
      : [{ kind: 'execute', target: actualCwd, scope: 'unknown' }],
    targets: contract.targets,
    reasonCode: parsed.dangerous ? 'shell_dangerous' : contract.reasonCode,
    evidence: [
      {
        source: 'controlled-shell-contract',
        detail: JSON.stringify({
          reason: contract.reasonCode,
          commands: contract.commands,
          unresolved: contract.unresolved,
        }),
      },
    ],
  };
}
