/**
 * 宿主平台：系统提示和 bash 工具共用同一份事实。
 *
 * 工具名保持 bash（权限规则和钩子都认这个名字）。
 * 实际解释器按运行环境选：Windows 本机用 PowerShell，WSL 和其余 POSIX 用 bash。
 * WSL 虽是 linux，但要单独标出来，否则模型会把它当成普通 Linux 或写出 Windows 路径。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ShellKind = 'powershell' | 'bash';

/** 测试或调用方覆盖本机探测。不传则读当前进程。 */
export interface PlatformProbe {
  env?: NodeJS.ProcessEnv;
  /** /proc/version 的内容。null 表示没有这份文件。 */
  procVersion?: string | null;
}

export interface HostPlatform {
  platform: NodeJS.Platform;
  osLabel: string;
  shell: ShellKind;
  /** 环境段里的一行 */
  shellLine: string;
  /** 路径分隔符说明 */
  pathLine: string;
  /** 发给模型的 bash 工具描述 */
  toolDescription: string;
  /** 「用工具」里跟 shell 有关的几条 */
  toolBullets: string[];
}

const POSIX_BULLETS = [
  '读文件用 read_file，搜索内容用 grep，按名字找文件用 glob，改已有文件用 edit_file。这些事不要用 bash 里的 cat、grep、find、sed。',
  'read_file 的行尾已经收成普通换行。edit_file 和 write_file 按文件原来的换行符和 BOM 写回，不要为了换行符重写整份文件。',
  'bash 跑的是 bash。留给没有专用工具的事：构建、测试、git、启动进程。命令用 bash 语法。',
];

function wslBullets(distro: string): string[] {
  const which = distro ? `WSL（${distro}）` : 'WSL';
  return [
    '读文件用 read_file，搜索内容用 grep，按名字找文件用 glob，改已有文件用 edit_file。这些事不要用 bash 里的 cat、grep、find、sed。',
    'read_file 的行尾已经收成普通换行。edit_file 和 write_file 按文件原来的换行符和 BOM 写回，不要为了换行符重写整份文件。',
    `bash 跑的是 ${which} 里的 bash。留给没有专用工具的事：构建、测试、git、启动进程。命令用 bash 语法。`,
    '当前是 WSL，不是 Windows 本机。路径用正斜杠。Windows 盘挂在 /mnt/c、/mnt/d 这类目录下，不要写 C:\\ 这种路径，也不要调用 powershell.exe 或 cmd.exe。',
  ];
}

const WINDOWS_BULLETS = [
  '读文件用 read_file，搜索内容用 grep，按名字找文件用 glob，改已有文件用 edit_file。这些事不要用 PowerShell 的 Get-Content、Select-String、Get-ChildItem。',
  'read_file 的行尾已经收成普通换行。edit_file 和 write_file 按文件原来的换行符和 BOM 写回，CRLF 文件不会被整文件改成 LF。路径用 / 或 \\ 都可以。',
  'bash 是工具名，实际解释器是 powershell.exe（Windows PowerShell）。留给没有专用工具的事：构建、测试、git、启动进程。',
  '命令用 PowerShell 语法。环境变量写成 $env:NAME。串联用分号，不要用 && 和 ||。路径用反斜杠或正斜杠都可以。不要写 bash/sh 专有写法，例如 export、source、heredoc。',
];

export function detectPlatform(platform?: NodeJS.Platform, probe?: PlatformProbe): HostPlatform {
  const resolved = platform ?? process.platform;
  const useHost = platform === undefined && probe === undefined;
  const env = probe?.env ?? (useHost ? process.env : {});
  const procVersion = probe && 'procVersion' in probe ? (probe.procVersion ?? null) : useHost && resolved === 'linux' ? readProcVersion() : null;
  const distro = typeof env.WSL_DISTRO_NAME === 'string' ? env.WSL_DISTRO_NAME : '';

  if (resolved === 'win32') {
    return {
      platform: resolved,
      osLabel: 'Windows',
      shell: 'powershell',
      shellLine: 'powershell.exe（Windows PowerShell）。工具名仍是 bash，命令按 PowerShell 写',
      pathLine: '\\（正斜杠通常也可以）',
      toolDescription:
        'Run a command in Windows PowerShell (powershell.exe). The tool is named bash, but the command must be PowerShell, not bash/sh. Chain with a semicolon, not && or ||. Environment variables are $env:NAME. Returns combined stdout/stderr. Use timeout for long commands.',
      toolBullets: WINDOWS_BULLETS,
    };
  }

  if (isWsl(resolved, env, procVersion)) {
    const osLabel = distro ? `WSL ${distro}` : 'WSL';
    return {
      platform: resolved,
      osLabel,
      shell: 'bash',
      shellLine: distro
        ? `bash（WSL 发行版 ${distro}）。命令用 bash 语法。Windows 盘在 /mnt/<盘符> 下`
        : 'bash（WSL）。命令用 bash 语法。Windows 盘在 /mnt/<盘符> 下',
      pathLine: '/',
      toolDescription: distro
        ? `Run a bash command inside WSL (${distro}). Use bash syntax and POSIX paths. Windows drives are mounted under /mnt/<drive>, for example /mnt/c. Do not use PowerShell, cmd, or C:\\ paths. Returns combined stdout/stderr. Use timeout for long commands.`
        : 'Run a bash command inside WSL. Use bash syntax and POSIX paths. Windows drives are mounted under /mnt/<drive>, for example /mnt/c. Do not use PowerShell, cmd, or C:\\ paths. Returns combined stdout/stderr. Use timeout for long commands.',
      toolBullets: wslBullets(distro),
    };
  }

  const osLabel = resolved === 'darwin' ? 'macOS' : resolved === 'linux' ? 'Linux' : resolved;
  return {
    platform: resolved,
    osLabel,
    shell: 'bash',
    shellLine: 'bash，命令用 bash 语法',
    pathLine: '/',
    toolDescription: 'Run a bash command. Returns combined stdout/stderr. Use timeout for long commands.',
    toolBullets: POSIX_BULLETS,
  };
}

function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, procVersion: string | null): boolean {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return procVersion != null && /microsoft/i.test(procVersion);
}

function readProcVersion(): string | null {
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return null;
  }
}

let cachedRg: string | null | undefined;

/** 解析 rg 可执行文件。优先 PATH，其次 ~/.local/bin。进程内缓存。 */
export function findRg(): string | null {
  if (cachedRg !== undefined) return cachedRg;
  cachedRg = locateRg();
  return cachedRg;
}

function locateRg(): string | null {
  const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['rg'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status === 0) {
    const found = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (found) return found;
  }
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  return existsSync(local) ? local : null;
}

export interface ShellInvocation {
  file: string;
  args: string[];
}

/** 把一条用户命令变成当前平台的 spawn 参数。 */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): ShellInvocation {
  if (platform === 'win32') {
    // PowerShell 5.1 的 `-Command -` 按控制台代码页读 stdin，不认 UTF-8 BOM。
    // `-EncodedCommand` 用 UTF-16LE base64，绕开代码页，也不需要临时文件。
    const encoded = Buffer.from(powershellScript(command), 'utf16le').toString('base64');
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    };
  }
  return { file: 'bash', args: ['-c', command] };
}

/**
 * Windows PowerShell 5 在管道重定向时默认用 UTF-16，并且原生命令的退出码不会传给进程。
 * 脚本开头改成 UTF-8，结尾用 $? 对齐 bash「最后一条命令决定退出码」的语义。
 */
export function powershellScript(command: string): string {
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    command,
    'if (-not $?) { exit 1 }',
  ].join('\n');
}

/** PowerShell 有时仍把 stdout 写成 UTF-16 LE。识别后再解码，避免中文变成空字节。 */
export function decodeShellOutput(buf: Buffer, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && looksLikeUtf16Le(buf)) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buf.toString('utf8');
}

function looksLikeUtf16Le(buf: Buffer): boolean {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 200));
  if (sample.length < 4) return false;
  let nulls = 0;
  for (const byte of sample) if (byte === 0) nulls += 1;
  return nulls > sample.length / 4;
}
