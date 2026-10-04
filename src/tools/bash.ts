/**
 * bash 工具 + 危险命令检测。
 *
 * 工具名在各平台都叫 bash，解释器由 platform.ts 按操作系统选择。
 * analyzeCommand 是权限引擎"危险检测"步骤的数据来源：
 * POSIX 与 Windows 的危险写法都查，模型在任一平台写出另一套语法时仍会拦住。
 */
import { spawn } from 'node:child_process';
import { decodeShellOutput, detectPlatform, shellInvocation } from '../core/platform.js';
import type { Tool } from '../core/registry.js';
import { envWithRg } from './grep.js';

const DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?\/(\s|$)/, why: '递归删除根目录' },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+~/, why: '递归删除 home 目录' },
  { re: /\bsudo\b/, why: '提权操作' },
  { re: /\b(mkfs|dd\s+if=)\b/, why: '磁盘级操作' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba|z|)sh\b/, why: '下载并直接执行脚本' },
  { re: />\s*\/(etc|bin|sbin|usr|boot|System|Windows)\//, why: '写入系统目录' },
  { re: /\bgit\s+push\s+.*--force\b/, why: '强制推送' },
  { re: /\b(shutdown|reboot|halt)\b/, why: '关机/重启' },
  { re: /\bRemove-Item\b[^\n]*-Recurse\b[^\n]*\s([A-Za-z]:\\|\/)(\s|$)/i, why: '递归删除磁盘根目录' },
  { re: /\b(Format-Volume|Clear-Disk)\b/i, why: '磁盘级操作' },
  { re: /\b(Stop-Computer|Restart-Computer)\b/i, why: '关机/重启' },
  { re: /\biex\s*\(\s*(irm|iwr)\b/i, why: '下载并直接执行脚本' },
  { re: /\bInvoke-Expression\b[^\n]*\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i, why: '下载并直接执行脚本' },
  { re: /\b(Set-Content|Out-File)\b[^\n]*\\Windows\\/i, why: '写入系统目录' },
];

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
      command: { type: 'string', description: host.shell === 'powershell' ? 'PowerShell command' : 'bash command' },
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
    const invocation = shellInvocation(command);

    return new Promise((resolvePromise) => {
      const child = spawn(invocation.file, invocation.args, {
        cwd: ctx.cwd,
        env: envWithRg(process.env),
        windowsHide: true,
        stdio: [invocation.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });

      const chunks: Buffer[] = [];
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      const collected = () => {
        const text = decodeShellOutput(Buffer.concat(chunks)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (text.length > MAX_OUTPUT) return `${text.slice(0, MAX_OUTPUT)}\n[truncated]`;
        return text;
      };

      if (invocation.input !== undefined && child.stdin) {
        child.stdin.write(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(invocation.input, 'utf8')]));
        child.stdin.end();
      }

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolvePromise({ content: `${collected()}\n[timed out after ${timeout}ms]`, isError: true });
      }, timeout);

      ctx.signal.addEventListener('abort', () => {
        child.kill('SIGKILL');
      }, { once: true });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({ content: `Failed to start ${invocation.file}: ${err.message}`, isError: true });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const output = collected();
        resolvePromise({
          content: output || '(no output)',
          isError: code !== 0,
        });
      });
    });
  },
};
