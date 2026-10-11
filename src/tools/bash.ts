/**
 * bash 工具 + 危险命令检测。
 *
 * 工具名在各平台都叫 bash，解释器由 platform.ts 按操作系统选择。
 * analyzeCommand 是权限引擎"危险检测"步骤的数据来源。
 * bash 与 PowerShell 的危险写法分开列出，两边都会查：模型在任一平台写出另一套语法时仍会拦住。
 * PowerShell 的命令形状在 powershell.ts；bash 只读语法树在 shell-readonly.ts。
 */
import { spawn } from 'node:child_process';
import { decodeShellOutput, detectPlatform, shellInvocation } from '../core/platform.js';
import type { Tool } from '../core/registry.js';
import { envWithRg } from './grep.js';
import { parsePowerShell } from './powershell.js';
import {
  analyzeReadOnlyShell,
  readOnlyShellEnvironment,
  trustedShellPath,
} from './shell-readonly.js';

const BASH_DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?\/(\s|$)/, why: '递归删除根目录' },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+~/, why: '递归删除 home 目录' },
  { re: /\bsudo\b/, why: '提权操作' },
  { re: /\b(mkfs|dd\s+if=)\b/, why: '磁盘级操作' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|)sh\b/, why: '下载并直接执行脚本' },
  { re: />\s*\/(etc|bin|sbin|usr|boot|System|Windows)\//, why: '写入系统目录' },
  { re: /\bgit\s+push\s+.*--force\b/, why: '强制推送' },
  { re: /\b(shutdown|reboot|halt)\b/, why: '关机/重启' },
];
const POWERSHELL_DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  {
    re: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*\s([A-Za-z]:\\|\/)(\s|$)/i,
    why: '递归删除磁盘根目录',
  },
  { re: /\b(Format-Volume|Clear-Disk)\b/i, why: '磁盘级操作' },
  { re: /\b(Stop-Computer|Restart-Computer)\b/i, why: '关机/重启' },
  { re: /\biex\s*\(\s*(irm|iwr)\b/i, why: '下载并直接执行脚本' },
  {
    re: /\bInvoke-Expression\b[^\n]*\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
    why: '下载并直接执行脚本',
  },
  { re: /\b(Set-Content|Out-File)\b[^\n]*\\Windows\\/i, why: '写入系统目录' },
];
/** 两套都查：模型在任一平台写出另一套语法时仍要拦住。 */
const DANGEROUS_PATTERNS = [...BASH_DANGEROUS_PATTERNS, ...POWERSHELL_DANGEROUS_PATTERNS];

export function analyzeCommand(command: string): { dangerous: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(command)) reasons.push(why);
  }
  return { dangerous: reasons.length > 0, reasons };
}

const MAX_OUTPUT = 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const host = detectPlatform();

export const bashTool: Tool = {
  name: 'bash',
  description: host.toolDescription,
  risk: 'execute',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: host.shell === 'powershell' ? 'PowerShell command' : 'bash command',
      },
      timeout: { type: 'number', description: 'Timeout in ms, default 120000' },
    },
    required: ['command'],
  },
  analyzeInput(input) {
    const command = String(input.command ?? '');
    const { dangerous, reasons } = analyzeCommand(command);
    return {
      patternTarget: command,
      dangerous,
      summary: `${host.shell}: ${command}${dangerous ? ` ⚠️ 危险：${reasons.join('、')}` : ''}`,
    };
  },
  async execute(input, ctx) {
    const command = String(input.command);
    const timeout = Number(input.timeout ?? DEFAULT_TIMEOUT_MS);
    let invocation = shellInvocation(command);
    let env = envWithRg(process.env);
    const powerShellCommand = ctx.analysis?.environment?.['$powershellCommand'];
    if (powerShellCommand) {
      const current = parsePowerShell(command);
      if (
        process.platform !== 'win32' ||
        !current.complete ||
        current.command !== powerShellCommand
      )
        throw new Error('approval_stale: PowerShell command contract changed');
      invocation = shellInvocation(powerShellCommand, 'win32');
    }
    const approved = ctx.analysis?.environment?.['$shellContract'];
    if (approved) {
      const entries: string[] = JSON.parse(
        ctx.analysis?.environment?.['$shellPluginEntries'] ?? '[]',
      );
      const current = await analyzeReadOnlyShell(command, ctx.cwd, entries, ctx.signal);
      const shell = await trustedShellPath();
      if (!current.complete || !current.command || !shell || JSON.stringify(current) !== approved) {
        throw new Error('approval_stale: read-only shell scope changed; run the command again');
      }
      invocation = { file: shell, args: ['--noprofile', '--norc', '-p', '-c', current.command] };
      env = readOnlyShellEnvironment();
    }

    return new Promise((resolvePromise) => {
      const child = spawn(invocation.file, invocation.args, {
        cwd: ctx.cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      const collected = () => {
        const text = decodeShellOutput(Buffer.concat(chunks))
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n');
        if (text.length > MAX_OUTPUT) return `${text.slice(0, MAX_OUTPUT)}\n[truncated]`;
        return text;
      };

      let timedOut = false;
      let termination: Promise<void> | undefined;
      const terminate = () => {
        if (!child.pid || termination) return;
        if (process.platform === 'win32') {
          // shell 的所有后代属于本次工具调用；不能只结束 PowerShell 留下工作进程。
          termination = new Promise((done) => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
            });
            killer.once('error', () => {
              child.kill('SIGKILL');
              done();
            });
            killer.once('close', () => {
              child.kill('SIGKILL');
              done();
            });
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeout);
      ctx.signal.addEventListener('abort', terminate, { once: true });
      if (ctx.signal.aborted) terminate();

      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({
          content: `Failed to start ${invocation.file}: ${err.message}`,
          isError: true,
        });
      });

      child.on('close', async (code) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', terminate);
        await termination;
        const output = collected();
        resolvePromise({
          content: timedOut ? `${output}\n[timed out after ${timeout}ms]` : output || '(no output)',
          isError: timedOut || code !== 0,
        });
      });
    });
  },
};
