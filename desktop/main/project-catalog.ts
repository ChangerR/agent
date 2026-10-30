import { basename } from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { sshProjectSchema, type SshProjectInput } from '../remote/protocol.js';
import type { ProjectSummary, RuntimeSnapshot, RemoteHostSummary } from '../shared/protocol.js';

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  demo: z.boolean(),
  remote: sshProjectSchema.optional(),
  remoteIdentity: z.string().optional(),
  remoteHostId: z.string().optional(),
  lastSessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),
});
const hostSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  target: sshProjectSchema.shape.target,
  identity: z.string().optional(),
  home: z.string().startsWith('/').max(4096),
});

/** 目录只记录项目身份与最近会话；会话内容仍由项目自己的 SessionManager 管理。 */
export class ProjectCatalog {
  private entries: ProjectSummary[] = [];
  private hosts: RemoteHostSummary[] = [];
  restore(value: unknown) {
    // 升级早期桌面偏好的目录格式，保留已添加的项目，不读取或迁移 agent 配置。
    const legacy = z.object({ recentProjects: z.array(z.string().min(1)) }).safeParse(value);
    const parsed = legacy.success
      ? {
          projects: legacy.data.recentProjects.map((path) => ({
            id: path,
            path,
            name: basename(path) || path,
            demo: false,
          })),
        }
      : z.object({ projects: z.array(projectSchema) }).parse(value);
    const hostData = z.object({ remoteHosts: z.array(hostSchema).optional() }).parse(value);
    this.hosts = (hostData.remoteHosts ?? []).filter(
      (h, i, all) => all.findIndex((other) => other.id === h.id || other.target === h.target) === i,
    );
    this.entries = (parsed.projects as ProjectSummary[]).filter(
      (p, i, all) =>
        (p.remote ? p.id.startsWith('ssh-') : p.id === p.path) &&
        all.findIndex((other) => other.id === p.id) === i,
    );
    // 已添加的远程项目归属到独立主机，保留项目 ID 与最近会话。
    for (const project of this.entries) {
      if (!project.remote) continue;
      let host = this.hosts.find((h) => h.target === project.remote!.target);
      if (!host) {
        host = {
          id: project.remoteHostId ?? 'host-' + randomUUID(),
          name: project.remote.target,
          target: project.remote.target,
          identity: project.remoteIdentity,
          home: '/',
        };
        this.hosts.push(host);
      }
      project.remoteHostId = host.id;
    }
  }
  get remoteHosts(): RemoteHostSummary[] {
    return this.hosts.map((h) => ({ ...h }));
  }
  getHost(id: string) {
    return this.remoteHosts.find((h) => h.id === id);
  }
  addHost(input: Omit<RemoteHostSummary, 'id'>) {
    const previous = this.hosts.find((h) => h.target === input.target);
    if (previous?.identity && input.identity && previous.identity !== input.identity)
      throw new Error('HOST_TARGET_CHANGED');
    const host = hostSchema.parse({
      ...previous,
      ...input,
      id: previous?.id ?? 'host-' + randomUUID(),
    });
    this.hosts = [host, ...this.hosts.filter((h) => h.id !== host.id)];
    return { ...host };
  }
  get projects(): ProjectSummary[] {
    return this.entries.map((p) => ({ ...p }));
  }
  get(id: string) {
    return this.projects.find((p) => p.id === id);
  }
  open(canonicalPath: string, demo: boolean) {
    const previous = this.get(canonicalPath);
    const project = {
      ...previous,
      id: canonicalPath,
      path: canonicalPath,
      name: basename(canonicalPath) || canonicalPath,
      demo,
    };
    this.entries = [project, ...this.entries.filter((p) => p.id !== project.id)];
  }
  observe(runtime?: RuntimeSnapshot) {
    if (!runtime || runtime.busy || !runtime.sessions.some((s) => s.id === runtime.sessionId))
      return;
    const project = this.entries.find((p) => p.id === (runtime.projectId ?? runtime.cwd));
    if (project) project.lastSessionId = runtime.sessionId;
  }
  openRemote(input: SshProjectInput, identity: string, hostId?: string) {
    const host = hostId
      ? this.getHost(hostId)
      : (this.hosts.find((h) => h.target === input.target) ??
        this.addHost({ target: input.target, name: input.target, identity, home: '/' }));
    if (hostId && !host) throw new Error('HOST_NOT_FOUND');
    if (host && (host.target !== input.target || (host.identity && host.identity !== identity)))
      throw new Error('HOST_TARGET_CHANGED');
    const previous = this.entries.find(
      (p) => p.remote?.target === input.target && p.path === input.path,
    );
    if (previous?.remoteIdentity && previous.remoteIdentity !== identity)
      throw new Error('HOST_TARGET_CHANGED');
    const project: ProjectSummary = {
      ...previous,
      id: previous?.id ?? 'ssh-' + randomUUID(),
      path: input.path,
      name: input.path.split('/').filter(Boolean).at(-1) ?? input.path,
      demo: false,
      remote: input,
      remoteIdentity: identity,
      remoteHostId: host?.id,
    };
    this.entries = [project, ...this.entries.filter((p) => p.id !== project.id)];
    return project;
  }
}
