import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { execFile } from 'node:child_process';
import { ProjectCatalog } from '../desktop/main/project-catalog.js';
import { selectSessionProject } from '../desktop/main/session-target.js';
import {
  createLocalProjectDirectory,
  createRemoteProjectDirectory,
} from '../desktop/main/create-project.js';
import { resolveProjectRoot } from '../src/core/paths.js';
import { newProjectSchema } from '../desktop/remote/protocol.js';
import type { RuntimeSnapshot } from '../desktop/shared/protocol.js';

describe('新建会话选择工作区', () => {
  it('可在未打开工作区时选择已有远程项目；不默认绑定当前项目', () => {
    const catalog = new ProjectCatalog();
    catalog.open('/local/project', false);
    const host = catalog.addHost({
      name: '测试主机',
      target: 'ubuntu@test',
      home: '/home/ubuntu',
      identity: 'test',
    });
    const remote = catalog.openRemote(
      { target: host.target, path: '/srv/project', mappings: {} },
      'test',
      host.id,
    );
    expect(selectSessionProject(catalog, undefined, { projectId: remote.id })).toEqual(remote);
    const current = { projectId: '/local/project', cwd: '/local/project' } as RuntimeSnapshot;
    expect(selectSessionProject(catalog, current, { projectId: remote.id }).remoteHostId).toBe(
      host.id,
    );
    expect(selectSessionProject(catalog, current, undefined).id).toBe('/local/project');
    expect(() => selectSessionProject(catalog, current, { projectId: 'unknown' })).toThrow(
      '项目不存在',
    );
    expect(() => selectSessionProject(catalog, undefined, undefined)).toThrow('请先选择');
  });
  it('新项目有独立根目录，已有目录不会被覆盖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentlab-new-project-'));
    try {
      await writeFile(join(root, 'package.json'), '{}');
      const input = { location: 'local' as const, parentPath: root, name: '中文 project' };
      const project = await createLocalProjectDirectory(input);
      expect(await readFile(join(project, 'agent.config.json'), 'utf8')).toBe('{}\n');
      await mkdir(join(project, 'src'));
      expect(resolveProjectRoot(join(project, 'src'))).toBe(project);
      await writeFile(join(project, 'keep.txt'), 'KEEP');
      await expect(createLocalProjectDirectory(input)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(join(project, 'keep.txt'), 'utf8')).toBe('KEEP');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['../escape', 'a/b', 'a\\b', '.', '..', 'CON', 'NUL.txt', 'trailing.'])(
    '拒绝无效项目名 %s',
    (name) => {
      expect(
        newProjectSchema.safeParse({ location: 'local', parentPath: '/tmp', name }).success,
      ).toBe(false);
    },
  );
  it('远程新建只运行固定脚本，父目录和名称经独立引用', async () => {
    let script = '',
      args: string[] = [];
    const execute = ((file: string, argv: string[], _options: unknown, callback: Function) => {
      expect(file).toBe('ssh');
      args = argv;
      return {
        stdin: {
          end: (input: string) => {
            script = input;
            callback(null, '/srv/parent/new project\0', '');
          },
        },
      };
    }) as unknown as typeof execFile;
    const path = await createRemoteProjectDirectory(
      'ubuntu@test',
      {
        location: 'ssh',
        hostId: 'host-test',
        parentPath: "/srv/parent'quoted",
        name: 'new project',
      },
      execute,
    );
    expect(path).toBe('/srv/parent/new project');
    expect(args.at(-1)).toBe('sh -s');
    expect(args.join(' ')).not.toContain('quoted');
    expect(script).toContain("'/srv/parent'\\''quoted'");
    expect(script).toContain('mkdir -m 700');
    expect(script).toContain('set -C');
    expect(script).not.toContain('mkdir -p');
  });
});
