/** 父子权限迁移通过真实会话存储与 supervisor 恢复验证，不执行真实模型请求。 */
import { afterEach, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempProject } from './helpers/project.js';
import { createExecutionAgent } from './helpers/execution-agent.js';
import type { Agent } from '../src/runtime/agent.js';
import { definePlugin } from '../src/sdk/index.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import {
  loadSession,
  saveSessionVersioned,
  sessionPath,
} from '../src/builtin/session-file/implementation.js';
import { migrateSessionPermissions } from '../src/builtin/policy/migration.js';

const roots: string[] = [],
  agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0).reverse()) await agent.dispose();
  for (const cwd of roots.splice(0)) await rm(cwd, { recursive: true, force: true });
});
async function open(cwd: string, autoSaveSessions = true) {
  const fake = new FakeProvider([() => textResponse('离线历史')]);
  const agent = await createExecutionAgent(cwd, {
    autoSaveSessions,
    config: { provider: 'migration-fixture', model: 'fixture', permissionMode: 'ask' },
    plugins: [
      definePlugin({
        manifest: { id: 'test.permission-migration', version: '1.0.0', apiVersion: 1 },
        setup(ctx) {
          ctx.provide.provider('migration-fixture', {
            ...fake,
            name: 'migration-fixture',
            stream: fake.stream.bind(fake),
          });
        },
      }),
    ],
  });
  agents.push(agent);
  return { agent, fake };
}
async function legacyTree() {
  const cwd = await mkdtempProject(join(tmpdir(), 'permission-migration-'));
  roots.push(cwd);
  const { agent } = await open(cwd);
  await agent.loop.run('父会话历史');
  for (const task of ['子任务一', '子任务二']) {
    const child = agent.agents.spawn({ task });
    await agent.agents.wait(child.agentId, { runId: child.runId });
  }
  await agent.agents.whenSettled();
  await agent.session.save();
  const id = agent.session.id;
  await agent.dispose();
  const root = await loadSession(cwd, id);
  const ids = [id, ...root.agents!.children!.map((record) => record.sessionId)];
  for (const sessionId of ids) {
    const file = await loadSession(cwd, sessionId);
    await saveSessionVersioned({
      ...file,
      policy: { ...file.policy, version: '2.0.0' },
      permissionMode: 'yolo',
      sessionRules: { allow: ['write_file'], ask: ['bash'], deny: ['read_file(secret)'] },
    });
  }
  const files = await Promise.all(ids.map((sessionId) => loadSession(cwd, sessionId)));
  return { cwd, root: files[0], children: files.slice(1), signal: new AbortController().signal };
}

it('根会话迁移预览覆盖所有归属子会话，应用后真实恢复且不重放请求', async () => {
  const f = await legacyTree();
  const preview = await migrateSessionPermissions(f.cwd, f.root.id, false, f.signal);
  expect(preview).toMatchObject({
    applied: false,
    children: f.children.map((file) => ({
      id: file.id,
      from: '2.0.0',
      applied: false,
      droppedTemporaryAllows: 1,
    })),
  });
  for (const file of [f.root, ...f.children])
    expect(await loadSession(f.cwd, file.id)).toEqual(file);
  expect(await migrateSessionPermissions(f.cwd, f.root.id, true, f.signal)).toMatchObject({
    applied: true,
    children: f.children.map((file) => ({ id: file.id, applied: true })),
  });
  for (const file of [f.root, ...f.children]) {
    expect(await loadSession(f.cwd, file.id)).toEqual({
      ...file,
      policy: { ...file.policy, version: '3.0.0' },
      revision: file.revision + 1,
      updatedAt: expect.any(String),
      permissionMode: 'ask',
      sessionRules: { ...file.sessionRules, allow: [] },
    });
  }
  const restored = await open(f.cwd, false);
  await restored.agent.session.resume(f.root.id);
  expect(restored.fake.requests).toHaveLength(0);
  expect(restored.agent.agents.status().map((record) => record.sessionId)).toEqual(
    f.children.map((file) => file.id),
  );
  expect(restored.agent.permission.getSessionRules()).toEqual({
    allow: [],
    ask: ['bash'],
    deny: ['read_file(secret)'],
  });
});

it.each(['root', 'child'] as const)(
  '混合版本中已迁移的 %s 保持原版本，剩余会话仍可迁移',
  async (kind) => {
    const f = await legacyTree(),
      migrated = kind === 'root' ? f.root : f.children[0];
    await saveSessionVersioned({
      ...migrated,
      policy: { ...migrated.policy, version: '3.0.0' },
      permissionMode: 'ask',
      sessionRules: { ...migrated.sessionRules, allow: [] },
    });
    const before = await loadSession(f.cwd, migrated.id);
    expect(await migrateSessionPermissions(f.cwd, f.root.id, true, f.signal)).toMatchObject({
      applied: true,
    });
    expect(await loadSession(f.cwd, migrated.id)).toEqual(before);
    for (const file of [f.root, ...f.children])
      expect((await loadSession(f.cwd, file.id)).policy.version).toBe('3.0.0');
    expect(await migrateSessionPermissions(f.cwd, f.root.id, true, f.signal)).toMatchObject({
      applied: false,
    });
  },
);

it.each(['foreign-owner', 'unknown-version'] as const)(
  '子会话 %s 时整棵树预检失败且不写入',
  async (kind) => {
    const f = await legacyTree(),
      file = f.children[1];
    await saveSessionVersioned(
      kind === 'foreign-owner'
        ? {
            ...file,
            agents: {
              ...file.agents,
              owner: { ...file.agents!.owner!, rootSessionId: 'foreign-root' },
            },
          }
        : { ...file, policy: { ...file.policy, version: '9.0.0' } },
    );
    const files = await Promise.all(
      [f.root, ...f.children].map((value) => loadSession(f.cwd, value.id)),
    );
    await expect(migrateSessionPermissions(f.cwd, f.root.id, true, f.signal)).rejects.toThrow();
    for (const before of files) expect(await loadSession(f.cwd, before.id)).toEqual(before);
  },
);

it('子会话不能单独迁移，已取消的迁移不写入', async () => {
  const f = await legacyTree();
  await expect(migrateSessionPermissions(f.cwd, f.children[0].id, true, f.signal)).rejects.toThrow(
    '根会话',
  );
  await expect(
    migrateSessionPermissions(f.cwd, f.root.id, true, AbortSignal.abort()),
  ).rejects.toThrow();
  for (const file of [f.root, ...f.children])
    expect(await loadSession(f.cwd, file.id)).toEqual(file);
});

it('子会话写锁等待中取消不提交根会话，重试能完成已部分迁移的树', async () => {
  const f = await legacyTree();
  const lock = sessionPath(f.cwd, f.children[1].id) + '.lock';
  await writeFile(lock, 'test-lock');
  const cancel = new AbortController();
  const outcome = migrateSessionPermissions(f.cwd, f.root.id, true, cancel.signal).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  try {
    await vi.waitFor(async () =>
      expect((await loadSession(f.cwd, f.children[0].id)).policy.version).toBe('3.0.0'),
    );
    cancel.abort();
    expect(await outcome).toHaveProperty('error');
    expect(await loadSession(f.cwd, f.root.id)).toEqual(f.root);
    expect(await loadSession(f.cwd, f.children[1].id)).toEqual(f.children[1]);
  } finally {
    cancel.abort();
    await outcome;
    await rm(lock, { force: true });
  }
  const alreadyMigrated = await loadSession(f.cwd, f.children[0].id);
  expect(await migrateSessionPermissions(f.cwd, f.root.id, true, f.signal)).toMatchObject({
    applied: true,
    children: [{ applied: false }, { applied: true }],
  });
  expect(await loadSession(f.cwd, alreadyMigrated.id)).toEqual(alreadyMigrated);
});
