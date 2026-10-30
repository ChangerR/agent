import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { ProjectCatalog } from '../desktop/main/project-catalog.js';
import { inspectRemoteHost } from '../desktop/main/remote-host-profile.js';
import { sshHostInputSchema, openRemoteProjectSchema } from '../desktop/remote/protocol.js';

describe('SSH 主机先于项目', () => {
  it('添加主机不添加项目；同一主机可打开多个目录', () => {
    const catalog = new ProjectCatalog();
    const host = catalog.addHost({
      target: 'ubuntu@server',
      name: '开发服务器',
      home: '/home/ubuntu',
      identity: 'verified',
    });
    expect(catalog.projects).toEqual([]);
    expect(catalog.remoteHosts).toHaveLength(1);
    const one = catalog.openRemote(
      { target: host.target, path: '/srv/one', mappings: {} },
      'verified',
      host.id,
    );
    const two = catalog.openRemote(
      { target: host.target, path: '/srv/two', mappings: {} },
      'verified',
      host.id,
    );
    expect(one.id).not.toBe(two.id);
    expect(one.remoteHostId).toBe(host.id);
    expect(two.remoteHostId).toBe(host.id);
    expect(catalog.remoteHosts).toHaveLength(1);
    const restored = new ProjectCatalog();
    restored.restore({ projects: catalog.projects, remoteHosts: catalog.remoteHosts });
    expect(restored.projects).toEqual(catalog.projects);
    expect(restored.remoteHosts).toEqual(catalog.remoteHosts);
  });
  it('仅保存主机后重新加载仍能找到主机，项目保持为空', () => {
    const c = new ProjectCatalog();
    c.addHost({ target: 'server', name: '服务器', home: '/home/test', identity: 'a' });
    const restored = new ProjectCatalog();
    restored.restore({ projects: [], remoteHosts: c.remoteHosts });
    expect(restored.remoteHosts).toEqual(c.remoteHosts);
    expect(restored.projects).toEqual([]);
    expect(() =>
      restored.openRemote(
        { target: 'other', path: '/srv', mappings: {} },
        'a',
        c.remoteHosts[0].id,
      ),
    ).toThrow('HOST_TARGET_CHANGED');
  });
  it('旧远程项目归属到主机，保留项目 ID 和最近会话', () => {
    const catalog = new ProjectCatalog();
    catalog.restore({
      projects: [
        {
          id: 'ssh-existing',
          name: 'one',
          path: '/srv/one',
          demo: false,
          remote: { target: 'server', path: '/srv/one', mappings: {} },
          remoteIdentity: 'a',
          lastSessionId: 's-existing',
        },
      ],
    });
    expect(catalog.remoteHosts).toHaveLength(1);
    expect(catalog.projects[0].remoteHostId).toBe(catalog.remoteHosts[0].id);
    expect(catalog.projects[0].id).toBe('ssh-existing');
    expect(catalog.projects[0].lastSessionId).toBe('s-existing');
  });
  it('主机表单拒绝项目字段，项目选择必须指定已保存主机 ID', () => {
    expect(sshHostInputSchema.safeParse({ target: 'server', path: '/srv' }).success).toBe(false);
    expect(openRemoteProjectSchema.safeParse({ target: 'server', path: '/srv' }).success).toBe(
      false,
    );
  });
  it('主机验证只有 SSH 配置和环境探测，不部署或初始化模型', async () => {
    const calls: string[][] = [];
    const execute = ((file: string, args: string[], _options: unknown, callback: Function) => {
      expect(file).toBe('ssh');
      calls.push(args);
      callback(
        null,
        args[0] === '-G'
          ? 'hostname server\nport 22\nuser ubuntu\n'
          : 'Linux\nx86_64\n/home/ubuntu\n',
        '',
      );
      return {} as never;
    }) as unknown as typeof execFile;
    const result = await inspectRemoteHost({ target: 'ubuntu@server', name: '开发机' }, execute);
    expect(result.home).toBe('/home/ubuntu');
    expect(result.name).toBe('开发机');
    expect(result.identity).toHaveLength(64);
    expect(calls).toHaveLength(2);
    expect(calls.flat().join(' ')).not.toMatch(/sftp|runtime.init|broker|apiKey|mkdir/);
  });
});
