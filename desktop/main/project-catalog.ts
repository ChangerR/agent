import { basename } from 'node:path';
import { z } from 'zod';
import type { ProjectSummary, RuntimeSnapshot } from '../shared/protocol.js';

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  demo: z.boolean(),
  lastSessionId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .optional(),
});

/** 目录只记录项目身份与最近会话；会话内容仍由项目自己的 SessionManager 管理。 */
export class ProjectCatalog {
  private entries: ProjectSummary[] = [];
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
    this.entries = parsed.projects.filter(
      (p, i, all) => p.id === p.path && all.findIndex((other) => other.id === p.id) === i,
    );
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
    const project = this.entries.find((p) => p.path === runtime.cwd);
    if (project) project.lastSessionId = runtime.sessionId;
  }
}
