import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { listRemoteDirectories } from '../desktop/main/remote-directories.js';

describe('SSH 远程目录选择', () => {
  it('使用只读 find 并保护远程路径，返回当前目录和子目录', async () => {
    const calls: Array<[string, string[]]> = [];
    const execute = ((_file: string, args: string[], _options: unknown, callback: Function) => {
      calls.push([_file, args]);
      callback(null, '/home\0/home/ubuntu\0/home/ubuntu/project\0', '');
      return {} as never;
    }) as unknown as typeof execFile;
    const result = await listRemoteDirectories(
      { target: 'ubuntu@example.com', path: '/home' },
      execute,
    );
    expect(result).toEqual(['/home', '/home/ubuntu', '/home/ubuntu/project']);
    const [file, args] = calls[0];
    expect(file).toBe('ssh');
    expect(args).toContain('find');
    expect(args).toContain("'/home'");
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('-print0');
  });

  it('拒绝控制字符和非绝对路径', async () => {
    await expect(listRemoteDirectories({ target: 'host', path: '../outside' })).rejects.toThrow();
    await expect(
      listRemoteDirectories({ target: 'host', path: '/tmp\nrm -rf /' }),
    ).rejects.toThrow();
  });
  it('保留目录名称两端空格，不将换行名称误认为另一个项目', async () => {
    const execute = ((_file: string, _args: string[], _options: unknown, callback: Function) => {
      callback(null, '/home\0/home/project with space \0/home/bad\nname\0', '');
      return {} as never;
    }) as unknown as typeof execFile;
    expect(await listRemoteDirectories({ target: 'host', path: '/home' }, execute)).toEqual([
      '/home',
      '/home/project with space ',
    ]);
  });
});
