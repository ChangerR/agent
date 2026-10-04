/**
 * 平台区分：系统提示、shell 选择、输出解码。
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../src/core/context/system-prompt.js';
import { decodeShellOutput, detectPlatform, powershellScript, shellInvocation } from '../src/core/platform.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';

const stubTool: Tool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object' },
  risk: 'read',
  async execute() {
    return { content: '' };
  },
};

function promptFor(platform: NodeJS.Platform, probe?: { env?: NodeJS.ProcessEnv; procVersion?: string | null }): string {
  const tools = new ToolRegistry();
  tools.register(stubTool);
  return buildSystemPrompt({ cwd: '/work', tools, skills: [], platform, probe });
}

describe('detectPlatform', () => {
  it('Windows 使用 PowerShell', () => {
    const host = detectPlatform('win32');
    expect(host.osLabel).toBe('Windows');
    expect(host.shell).toBe('powershell');
    expect(host.toolDescription).toContain('PowerShell');
    expect(shellInvocation('Write-Output hi', 'win32')).toEqual({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      input: powershellScript('Write-Output hi'),
    });
  });

  it('macOS 与 Linux 使用 bash', () => {
    expect(detectPlatform('darwin')).toMatchObject({ osLabel: 'macOS', shell: 'bash' });
    expect(detectPlatform('linux', { env: {}, procVersion: null })).toMatchObject({ osLabel: 'Linux', shell: 'bash' });
    expect(shellInvocation('echo hi', 'linux')).toEqual({ file: 'bash', args: ['-c', 'echo hi'] });
  });

  it('WSL 使用 bash，并标出发行版和 /mnt', () => {
    const host = detectPlatform('linux', { env: { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion: null });
    expect(host).toMatchObject({ osLabel: 'WSL Ubuntu', shell: 'bash' });
    expect(host.shellLine).toContain('/mnt/');
    expect(host.toolDescription).toContain('WSL (Ubuntu)');
    expect(shellInvocation('echo hi', 'linux')).toEqual({ file: 'bash', args: ['-c', 'echo hi'] });
  });

  it('没有发行版名时，/proc/version 里的 microsoft 也算 WSL', () => {
    const host = detectPlatform('linux', {
      env: {},
      procVersion: 'Linux version 5.15.0-microsoft-standard-WSL2',
    });
    expect(host.osLabel).toBe('WSL');
    expect(host.shell).toBe('bash');
  });
});

describe('buildSystemPrompt', () => {
  it('Windows 提示按 PowerShell 写命令', () => {
    const prompt = promptFor('win32');
    expect(prompt).toContain('操作系统: Windows (win32)');
    expect(prompt).toContain('powershell.exe');
    expect(prompt).toContain('$env:NAME');
    expect(prompt).not.toContain('cat、grep、find、sed');
  });

  it('POSIX 提示按 bash 写命令', () => {
    const prompt = promptFor('linux');
    expect(prompt).toContain('操作系统: Linux (linux)');
    expect(prompt).toContain('命令用 bash 语法');
    expect(prompt).toContain('cat、grep、find、sed');
    expect(prompt).not.toContain('powershell.exe');
  });

  it('WSL 提示使用 Linux 路径，而不是 Windows 命令', () => {
    const prompt = promptFor('linux', { env: { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion: null });
    expect(prompt).toContain('操作系统: WSL Ubuntu (linux)');
    expect(prompt).toContain('/mnt/c');
    expect(prompt).toContain('powershell.exe');
    expect(prompt).not.toContain('$env:NAME');
  });
});

describe('decodeShellOutput', () => {
  it('把 PowerShell 的 UTF-16 LE 解成文本', () => {
    const buf = Buffer.from(`\uFEFFok`, 'utf16le');
    expect(decodeShellOutput(buf, 'win32')).toBe('ok');
  });

  it('UTF-8 原样解码', () => {
    expect(decodeShellOutput(Buffer.from('你好'), 'linux')).toBe('你好');
  });
});
