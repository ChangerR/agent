/** bash 只读语法树分析。PowerShell 在 analyzer-powershell.ts。 */
import { resolve } from 'node:path';
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import { analyzeReadOnlyShell } from '../../tools/shell-readonly.js';
import { pathFingerprint, prepare } from './analyzer-paths.js';
import { described, hash, type AnalyzerContext, type ShellOperation } from './analyzer-types.js';

export async function analyzeShell(
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
