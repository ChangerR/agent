/** 产品路径是一次明确切换：不读旧配置、不导入旧状态、不删除旧数据。 */
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadConfigWithSources } from '../src/core/config.js';
import { resolveAgentPaths } from '../src/core/paths.js';
import { SkillLoader } from '../src/skills/loader.js';
import { createAgent, type Agent } from '../src/index.js';
let root: string, home: string, project: string, agent: Agent | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentlab-identity-'));
  home = join(root, 'home');
  project = join(root, 'project');
  await mkdir(join(home, '.agent'), { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(async () => {
  await agent?.dispose();
  agent = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it('默认配置/模型/MCP/会话/日志只使用 .agentlab，旧目录即使非法也不读取', async () => {
  const legacy = join(home, '.agent');
  for (const file of ['config.json', 'models.json', 'mcp.json'])
    await writeFile(join(legacy, file), 'not valid JSON\n');
  await mkdir(join(legacy, 'skills', 'legacy'), { recursive: true });
  await writeFile(
    join(legacy, 'skills/legacy/SKILL.md'),
    '---\nname: legacy\n---\nold private data',
  );
  await writeFile(
    join(project, 'agent.config.json'),
    JSON.stringify({
      provider: 'fake',
      capabilities: { reviewer: false },
      pluginConfig: { 'agentlab.planning': { mode: 'off' } },
    }),
  );
  const loaded = loadConfigWithSources(project),
    paths = resolveAgentPaths(project);
  expect(paths.agentHome).toBe(join(home, '.agentlab'));
  expect(paths.globalConfigPath).toBe(join(home, '.agentlab/config.json'));
  expect(paths.projectConfigPath).toBe(join(project, 'agent.config.json'));
  expect(paths.logsDir).toBe(join(home, '.agentlab/state/projects', paths.projectId, 'logs'));
  expect(paths.sessionsDir).toBe(
    join(home, '.agentlab/state/projects', paths.projectId, 'sessions'),
  );
  expect(loaded.config.modelsFile).toBe(join(home, '.agentlab/models.json'));
  expect(loaded.config.mcpConfig).toBe(join(home, '.agentlab/mcp.json'));
  agent = await createAgent(project);
  expect(agent.paths.sessionsDir).toBe(paths.sessionsDir);
  expect(agent.logPath.startsWith(paths.logsDir)).toBe(true);
  expect((await agent.session.list()).sessions).toHaveLength(0);
  await agent.loop.run('offline identity check');
  await agent.session.save();
  await access(join(paths.sessionsDir, agent.session.id + '.json'));
  expect(await readFile(join(legacy, 'config.json'), 'utf8')).toBe('not valid JSON\n');
  expect(agent.skillLoader.list().some((s) => s.name === 'legacy')).toBe(false);
  await expect(access(join(paths.agentHome, 'config.json'))).rejects.toThrow(); // SDK 不隐式生成用户配置。
});
it('用户和项目技能只扫描新目录，项目覆盖同名用户技能', async () => {
  for (const [base, name, body] of [
    [join(home, '.agentlab'), 'shared', 'global'],
    [join(project, '.agentlab'), 'shared', 'project'],
    [join(project, '.agent'), 'old-only', 'do not read'],
  ] as const) {
    await mkdir(join(base, 'skills', name), { recursive: true });
    await writeFile(
      join(base, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name}\n---\n${body}`,
    );
  }
  const loader = new SkillLoader(project);
  loader.load();
  expect(loader.get('shared')?.body).toBe('project');
  expect(loader.get('old-only')).toBeUndefined();
  expect(await readFile(join(project, '.agent/skills/old-only/SKILL.md'), 'utf8')).toContain(
    'do not read',
  );
});
