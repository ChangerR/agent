import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectCatalog } from '../desktop/main/project-catalog.js';
import { DesktopController } from '../desktop/worker/controller.js';
import { resolveProjectRoot } from '../src/core/paths.js';

describe('桌面以项目为边界', () => {
  it('同一规范目录只有一个项目，返回项目记住已保存的会话，空会话不覆盖记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentlab-projects-'));
    const first = join(root, 'first'),
      second = join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'README.md'), '# First\n');
    await writeFile(join(second, 'README.md'), '# Second\n');
    const catalog = new ProjectCatalog();
    let controller = new DesktopController(() => {});
    const send = (payload: Record<string, unknown>) =>
      controller.handle({
        ...payload,
        generation: controller.snapshot!.generation,
        sessionId: controller.snapshot!.sessionId,
      });
    try {
      await controller.initialize(first, true, randomUUID());
      catalog.open(controller.snapshot!.cwd, true);
      await send({ type: 'setting', field: 'model', value: 'project-one-model' });
      await vi.waitFor(() => expect(controller.snapshot!.busy).toBe(false));
      const nested = join(first, 'src');
      await mkdir(nested);
      catalog.open(resolveProjectRoot(nested), true);
      expect(catalog.projects).toHaveLength(1);
      await send({ type: 'submit', text: '项目一任务', invocationId: randomUUID() });
      await vi.waitFor(() => expect(controller.snapshot!.approvals).toHaveLength(1));
      await send({
        type: 'approve',
        approvalId: controller.snapshot!.approvals[0].id,
        allow: false,
      });
      await vi.waitFor(() => expect(controller.snapshot!.busy).toBe(false));
      const saved = controller.snapshot!;
      expect(saved.sessions.some((s) => s.id === saved.sessionId)).toBe(true);
      catalog.observe(saved);
      await controller.dispose();
      controller = new DesktopController(() => {});
      await controller.initialize(second, true, randomUUID());
      catalog.open(controller.snapshot!.cwd, true);
      expect(controller.snapshot!.sessions).toHaveLength(0);
      expect(controller.snapshot!.rows).toHaveLength(0);
      expect(controller.snapshot!.model).toBe('fake-desktop');
      await expect(send({ type: 'resume', id: saved.sessionId })).resolves.toBeUndefined();
      await vi.waitFor(() => expect(controller.snapshot!.busy).toBe(false));
      expect(controller.snapshot!.error).toBeDefined();
      expect(controller.snapshot!.rows).toHaveLength(0);
      await controller.dispose();
      controller = new DesktopController(() => {});
      await controller.initialize(first, true, randomUUID());
      catalog.open(controller.snapshot!.cwd, true);
      catalog.observe(controller.snapshot);
      expect(catalog.projects).toHaveLength(2);
      expect(catalog.get(first)?.lastSessionId).toBe(saved.sessionId);
      await send({ type: 'resume', id: catalog.get(first)!.lastSessionId });
      await vi.waitFor(() => expect(controller.snapshot!.busy).toBe(false));
      expect(controller.snapshot!.sessionId).toBe(saved.sessionId);
      expect(controller.snapshot!.model).toBe('project-one-model');
      expect(controller.snapshot!.rows.some((r) => r.text === '项目一任务')).toBe(true);
      expect(controller.snapshot!.approvals).toHaveLength(0);
      const reloaded = new ProjectCatalog();
      reloaded.restore(JSON.parse(JSON.stringify({ projects: catalog.projects })));
      expect(reloaded.projects).toEqual(catalog.projects);
      const copy = reloaded.projects;
      copy[0].name = '不能修改宿主目录';
      expect(reloaded.projects[0].name).not.toBe(copy[0].name);
      const upgraded = new ProjectCatalog();
      upgraded.restore({ recentProjects: [first, second, first] });
      expect(upgraded.projects.map((p) => p.path)).toEqual([first, second]);
    } finally {
      await controller.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
