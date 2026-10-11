/** PowerShell 字面操作的实际路径分析；Bash AST 的执行契约保持独立。 */
import { lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { AnalysisInput, ToolAnalysis } from '../../sdk/capabilities.js';
import { parsePowerShell } from '../../tools/powershell.js';
import { foreignPath, sensitivePath } from '../../tools/search-scope.js';
import { analyzeFilesystem } from './analyzer-files.js';
import {
  bindCwd,
  pathFingerprint,
  resolveTarget,
  windowsPathUnverified,
} from './analyzer-paths.js';
import {
  described,
  hash,
  windowsAmbiguousPath,
  type AnalyzerContext,
  type ShellOperation,
} from './analyzer-types.js';

export async function analyzePowerShell(
  ctx: AnalyzerContext,
  input: AnalysisInput,
  parsed: ShellOperation,
  signal: AbortSignal,
): Promise<ToolAnalysis> {
  const opened = await bindCwd(ctx, input, signal);
  if (opened.stop) return { ...opened.stop, summary: `PowerShell: ${parsed.command}` };
  const syntax = parsePowerShell(parsed.command);
  const environment = opened.environment;
  environment['$powershellSyntax'] = hash(syntax);
  // 新的 -NoProfile 进程不继承本条命令内的 alias/function 修改；这些语句本身不在支持范围。
  environment['$powershellEnvironment'] = hash(
    Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(?:path|pathext|psmodulepath|systemroot|windir|userprofile|home|temp|tmp)$/i.test(key),
      ),
    ),
  );
  const effects: ToolAnalysis['effects'][number][] = [];
  const targets = new Set<string>();
  const unresolved = [...syntax.unresolved];
  const evidence: NonNullable<ToolAnalysis['evidence']>[number][] = [];
  let reasonCode: string | undefined;
  // 不扫描字符串/注释中的危险单词：PowerShell 的危险性依据 AST 中实际调用的命令和操作数。
  let dangerous = false;
  const mark = (detail: string) => {
    unresolved.push(detail);
  };

  const file = async (raw: string, kind: 'read' | 'write', wildcard: boolean, mutation = false) => {
    signal.throwIfAborted();
    // 在非 Windows 宿主注入 win32 分支时，相对反斜杠按 Windows 分隔符解释；盘符仍是未验证外部路径。
    const path = process.platform === 'win32' ? raw : raw.replace(/\\/g, '/');
    if (windowsAmbiguousPath(raw)) {
      reasonCode = 'native_windows_unverified';
      effects.push({ kind, target: raw, scope: 'unknown' });
      targets.add(raw);
      mark('Windows 歧义路径');
      return;
    }
    const driveAbsolute = /^[A-Za-z]:[\\/]/.test(raw);
    const provider = /^[^\\/]+:/.test(raw) && !driveAbsolute;
    const unknownPath =
      raw.startsWith('~') ||
      provider ||
      /^\\/.test(raw) ||
      raw.includes('`') ||
      (wildcard && /[*?\[\]]/.test(raw)) ||
      /[*?]/.test(raw);
    if (unknownPath) {
      effects.push({
        kind,
        target: raw,
        scope: sensitivePath(raw, [], kind) ? 'sensitive' : 'unknown',
      });
      targets.add(raw);
      mark(`路径展开或 provider 尚未验证: ${raw}`);
      return;
    }
    const result = await analyzeFilesystem(
      ctx,
      input,
      { kind: 'file', path, effect: kind },
      signal,
    );
    Object.assign(environment, result.environment);
    effects.push(
      ...result.effects.map((effect) =>
        foreignPath(path) && sensitivePath(raw, [], kind)
          ? { ...effect, scope: 'sensitive' as const }
          : effect,
      ),
    );
    for (const target of result.targets ?? []) targets.add(target);
    evidence.push(...(result.evidence ?? []));
    if ((result.targets ?? []).some(windowsAmbiguousPath)) reasonCode = 'native_windows_unverified';
    if (result.completeness !== 'complete') {
      mark(result.reasonCode ?? '文件前提不完整');
      if (
        result.reasonCode === 'special_file_target' ||
        result.reasonCode === 'hardlink_alias_unverified'
      )
        reasonCode ??= result.reasonCode;
    }
    if (mutation && !foreignPath(path)) {
      const link = await lstat(resolve(input.cwd, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
        throw error;
      });
      if (link?.isSymbolicLink()) mark('删除、复制或移动链接本身的语义尚未验证');
    }
  };

  for (const pipeline of syntax.pipelines) {
    for (let index = 0; index < pipeline.length; index++) {
      const cmd = pipeline[index]!;
      const name = cmd.name
        .toLowerCase()
        .split('\\')
        .at(-1)!
        .replace(/\.exe$/, '');
      if (
        [
          'format-volume',
          'clear-disk',
          'stop-computer',
          'restart-computer',
          'shutdown',
          'reboot',
          'halt',
          'sudo',
          'mkfs',
          'dd',
          'iex',
          'invoke-expression',
        ].includes(name)
      )
        dangerous = true;
      if (
        name === 'git' &&
        cmd.arguments[0] === 'push' &&
        cmd.arguments.some((arg) => ['--force', '--force-with-lease', '-f'].includes(arg))
      )
        dangerous = true;
      const p = cmd.parameters;
      const path =
        typeof p.LiteralPath === 'string'
          ? p.LiteralPath
          : typeof p.Path === 'string'
            ? p.Path
            : undefined;
      const wildcard = p.LiteralPath === undefined;
      const requiredPath = () => {
        if (path === undefined) mark(`${cmd.name}: 缺少显式路径，管道路径绑定未验证`);
        return path;
      };
      if (!cmd.complete) mark(`${cmd.name}: 参数未完整绑定`);
      if (
        index > 0 &&
        !cmd.format &&
        !['Set-Content', 'Add-Content', 'Out-File'].includes(cmd.name)
      )
        mark(`${cmd.name}: 管道对象绑定未验证`);
      switch (cmd.name) {
        case 'Set-Content':
        case 'Add-Content':
          if (
            p.Value === undefined &&
            !(
              index > 0 &&
              pipeline
                .slice(0, index)
                .every((c) => ['Write-Output', 'Get-Content'].includes(c.name))
            )
          )
            mark(`${cmd.name}: 缺少静态值或受控管道输入`);
          if (requiredPath() !== undefined) await file(path!, 'write', wildcard);
          break;
        case 'Clear-Content':
        case 'Remove-Item':
          if (requiredPath() !== undefined) {
            if (cmd.name === 'Remove-Item' && /^(?:[A-Za-z]:[\\/]*|[\\/]+|~[\\/]*)$/.test(path!))
              dangerous = true;
            await file(path!, 'write', wildcard, true);
          }
          break;
        case 'Copy-Item':
        case 'Move-Item': {
          if (requiredPath() !== undefined) await file(path!, 'read', wildcard, true);
          if (cmd.name === 'Move-Item' && path !== undefined)
            await file(path, 'write', wildcard, true);
          if (typeof p.Destination !== 'string') {
            mark(`${cmd.name}: 缺少显式目标`);
            break;
          }
          let destination = p.Destination;
          // 文件复制/移动到已有目录时，实际写入的是目录下的源文件名。
          if (
            path !== undefined &&
            !foreignPath(destination) &&
            !windowsAmbiguousPath(destination) &&
            !/[:~*?\[\]]/.test(destination.replace(/^[A-Za-z]:[\\/]/, ''))
          ) {
            const normalized =
              process.platform === 'win32' ? destination : destination.replace(/\\/g, '/');
            const absolute = resolve(input.cwd, normalized);
            const target = await resolveTarget(absolute, signal);
            environment[`path:${absolute}`] = await pathFingerprint(absolute, signal);
            if (target.directory)
              destination = join(normalized, basename(path.replace(/\\/g, '/')));
          }
          await file(destination, 'write', true, true);
          break;
        }
        case 'New-Item':
          if (String(p.ItemType).toLowerCase() !== 'file')
            mark('New-Item 仅验证显式 ItemType File，不推断目录或链接');
          if (requiredPath() !== undefined) await file(path!, 'write', true);
          break;
        case 'Out-File':
          if (typeof p.FilePath === 'string') await file(p.FilePath, 'write', true);
          else mark('Out-File 缺少显式 FilePath');
          break;
        case 'Test-Path':
        case 'Get-Content':
        case 'Get-Item':
        case 'Select-String':
          if (requiredPath() !== undefined) await file(path!, 'read', wildcard);
          if (cmd.name === 'Select-String' && p.Pattern === undefined)
            mark('Select-String 缺少静态 Pattern');
          if (p.Wait || p.Stream !== undefined) mark('流或等待参数尚未验证');
          break;
        case 'Get-ChildItem':
          await file(path ?? '.', 'read', wildcard);
          mark('PowerShell provider 枚举不等于专用搜索工具的受控枚举');
          break;
        case 'Get-Location':
          effects.push({ kind: 'read', target: opened.actualCwd, scope: 'project' });
          targets.add(opened.actualCwd);
          break;
        case 'Write-Output':
          if (p.InputObject === undefined) mark('Write-Output 缺少静态 InputObject');
          effects.push({ kind: 'execute', scope: 'project' });
          break;
        default:
          if (cmd.name === 'Write-Output' || cmd.format)
            effects.push({ kind: 'execute', scope: 'project' });
          else {
            effects.push({ kind: 'unknown', scope: 'unknown' });
            mark(`${cmd.name}: 执行语义未验证`);
          }
      }
      for (const redirection of cmd.redirections)
        if (redirection.path !== undefined) await file(redirection.path, 'write', true);
    }
  }
  const complete =
    syntax.complete &&
    !unresolved.length &&
    effects.length > 0 &&
    effects.every((effect) => effect.scope !== 'unknown');
  if (complete && syntax.command) environment['$powershellCommand'] = syntax.command;
  const analysis: ToolAnalysis = {
    ...described(environment),
    completeness: complete
      ? 'complete'
      : effects.some((effect) => effect.kind !== 'unknown')
        ? 'partial'
        : 'unknown',
    effects: effects.length ? effects : [{ kind: 'unknown', scope: 'unknown' }],
    targets: [...targets],
    reasonCode: syntax.dedicatedFileRead
      ? 'windows_shell_dedicated_tool'
      : dangerous
        ? 'shell_dangerous'
        : (reasonCode ??
          (complete
            ? effects.every((effect) => ['read', 'write'].includes(effect.kind))
              ? 'powershell_file_operation'
              : 'powershell_bounded'
            : 'powershell_unresolved')),
    evidence: [
      {
        source: 'powershell-ast',
        detail: JSON.stringify({
          pipelines: syntax.pipelines,
          unresolved: [...new Set(unresolved)],
          contract:
            'AST + literal parameters + canonical targets + module-qualified cmdlets; Windows 5.1 subset',
        }),
      },
      ...evidence,
    ],
    summary: `PowerShell: ${parsed.command}`,
  };
  return reasonCode === 'native_windows_unverified' && !syntax.dedicatedFileRead
    ? windowsPathUnverified(analysis)
    : analysis;
}
