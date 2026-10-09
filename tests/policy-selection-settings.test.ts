import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createAgent } from '../src/index.js';
const signal = () => new AbortController().signal;
it('实现选择只在明确 Save 后写项目配置，下次启动生效，保持当前审批实现', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-policy-selection-'));
  const path = join(cwd, 'agent.config.json');
  const original = JSON.stringify({ provider: 'fake', custom: { keep: true } }); await writeFile(path, original);
  let agent = await createAgent(cwd, { autoSaveSessions: false });
  try {
    const section = agent.settings.find(s => s.id === 'capability-selection')!.section;
    const values = await section.read!(signal()) as Record<string, unknown>;
    expect(values.policy).toBe('legacy-v1'); expect(values.reviewer).toBe('model-v1');
    const draft = await section.draft!({ ...values, reviewer: 'model-v2' }, signal());
    expect(await readFile(path, 'utf8')).toBe(original);
    await section.commit!(draft, signal());
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ custom: { keep: true }, capabilities: { reviewer: 'model-v2' } });
    expect(agent.plugins.selected('reviewer')?.id).toBe('model-v1');
    await agent.dispose(); agent = await createAgent(cwd, { autoSaveSessions: false });
    expect(agent.plugins.selected('reviewer')?.id).toBe('model-v2');
    expect(agent.loop.getJudgeStatus()).toMatchObject({ loaded: true, provider: 'fake', source: 'current' });
  } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
it('未加载实现、必需能力禁用、过期草稿均拒绝，不损坏配置', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-policy-selection-'));
  const path = join(cwd, 'agent.config.json'); await writeFile(path, '{"provider":"fake"}');
  const agent = await createAgent(cwd, { autoSaveSessions: false });
  try {
    const section = agent.settings.find(s => s.id === 'capability-selection')!.section;
    const value = await section.read!(signal()) as Record<string, unknown>;
    expect(() => section.draft!({ ...value, policy: false }, signal())).toThrow('必需能力');
    expect(() => section.draft!({ ...value, reviewer: 'missing' }, signal())).toThrow('未加载');
    const draft = await section.draft!({ ...value, reviewer: false }, signal());
    await writeFile(path, '{"provider":"fake","external":true}');
    expect(() => section.commit!(draft, signal())).toThrow('配置已变化');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ provider: 'fake', external: true });
  } finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

it('显式关闭 cacheStrategy 不会偷偷回退到内核旧缓存建议', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-disable-cache-'));
  const agent = await createAgent(cwd, { autoSaveSessions: false, config: { provider: 'fake', capabilities: { cacheStrategy: false } } });
  let request: unknown;
  agent.events.on('model_request', event => { if (event.purpose === 'agent') request = event.request; });
  try { await agent.loop.run('hello'); expect(request).toMatchObject({ cache: undefined }); }
  finally { await agent.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
