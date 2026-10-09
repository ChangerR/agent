/** 真实默认装配的搜索权限回归：模型脚本、执行门、分析、审批与工具结果均不打桩。 */
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent, definePlugin, type Agent, type PermissionMode, type SessionRules } from '../src/index.js';
import type { AgentEvent } from '../src/core/events.js';
import type { ToolResult } from '../src/core/protocol/types.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import * as platform from '../src/core/platform.js';

type Call = { name: string; input: Record<string, unknown> };
type FixtureOptions = {
  mode?: PermissionMode;
  rules?: Partial<SessionRules>;
  pluginFixture?: boolean;
  prepare?: (cwd: string, outside: string, root: string) => Promise<void>;
};
const roots: string[] = [];
const agents: Agent[] = [];
const installedRg = platform.findRg();

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(options: FixtureOptions = {}) {
  // tests/setup-home.ts 已隔离 HOME 和假凭据；项目另设根边界，绝不继承宿主配置。
  const root = await mkdtemp(join(tmpdir(), 'agent-search-runtime-'));
  roots.push(root);
  const cwd = join(root, 'repo');
  const outside = join(root, 'outside');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await mkdir(join(cwd, 'src/nested'), { recursive: true });
  await mkdir(join(cwd, 'empty'));
  await mkdir(outside);
  await writeFile(join(cwd, 'README.md'), 'needle root\n');
  await writeFile(join(cwd, 'src/a.ts'), 'export const needle = 1;\n');
  await writeFile(join(cwd, 'src/nested/b.ts'), 'export const needle = 2;\n');
  await writeFile(join(cwd, 'src/a.txt'), 'needle text\n');
  await writeFile(join(outside, 'a.ts'), 'OUTSIDE_SENTINEL needle\n');
  let pluginEntries: string[] = [];
  if (options.pluginFixture) {
    await mkdir(join(cwd, 'extensions'));
    const entry = join(cwd, 'extensions/adapter.mjs');
    await writeFile(entry, '/* PLUGIN_SENTINEL needle */\nexport default { manifest: { id: "test.search-entry", version: "1.0.0", apiVersion: 1 }, setup() {} };\n');
    await symlink('extensions/adapter.mjs', join(cwd, 'adapter-alias.mjs'));
    pluginEntries = [entry];
  }
  await options.prepare?.(cwd, outside, root);
  let pending: Array<Call & { id: string }> = [];
  let emitted = false;
  let sequence = 0;
  const provider = new FakeProvider([request => {
    if (!request.tools.length) return textResponse(JSON.stringify({
      decision: 'ask', reasonCode: 'offline_unknown', reason: '离线审批测试保守询问',
    }));
    if (emitted) return textResponse('done');
    emitted = true;
    return toolUseResponse(pending);
  }]);
  const plugin = definePlugin({
    manifest: { id: 'test.search-provider', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.provider('search-fixture', {
        name: 'search-fixture', capabilities: provider.capabilities, stream: provider.stream.bind(provider),
      });
    },
  });
  const agent = await createAgent(cwd, {
    autoSaveSessions: false,
    plugins: [plugin],
    config: {
      provider: 'search-fixture', model: 'offline-search-model', permissionMode: options.mode ?? 'auto',
      pluginEntries,
      permissions: { allow: [], ask: [], deny: [], ...options.rules },
    },
  });
  agents.push(agent);
  expect(agent.plugins.selected('policy')?.id).toBe('deterministic');
  expect(agent.plugins.selected('reviewer')?.id).toBe('model');
  const events: AgentEvent[] = [];
  agent.events.onAll(event => events.push(event));
  agent.events.on('permission_request', event => event.resolve({ allow: false }));
  async function run(calls: Call[]) {
    pending = calls.map((call, index) => ({ ...call, id: `search-${sequence}-${index}` }));
    sequence++;
    emitted = false;
    const eventStart = events.length;
    const requestStart = provider.requests.length;
    expect((await agent.loop.run('Inspect the requested project files without changing anything.')).reason).toBe('completed');
    const current = events.slice(eventStart);
    const results = pending.map(call => {
      const result = current.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result' && event.toolUseId === call.id);
      expect(result, `${call.name} must return a real tool result`).toBeDefined();
      return result!.result;
    });
    const judge = current.filter(event => event.type === 'model_request' && event.purpose === 'judge').length;
    // 同时检查模型实际请求和审计，防止只把审批 UI 隐藏后假称零审批。
    expect(provider.requests.slice(requestStart).filter(request => !request.tools.length)).toHaveLength(judge);
    return {
      results, events: current, judge,
      human: current.filter(event => event.type === 'permission_request').length,
      executed: current.filter(event => event.type === 'tool_call').length,
    };
  }
  return { agent, cwd, outside, root, run };
}

function expectSuccessful(results: ToolResult[]) {
  for (const result of results) expect(result.isError, result.content).not.toBe(true);
}

// 原生 Windows 尚未通过确定性文件分析验收；这里不冒充 Windows 安全测试。
describe.skipIf(process.platform === 'win32')('默认 auto 真实搜索链路', () => {
  for (const backend of ['rg', 'builtin'] as const) {
  it.runIf(backend === 'builtin' || Boolean(installedRg))(`${backend}：普通 read_file、grep、glob 完整正常矩阵均零模型和人工审批`, async () => {
    vi.spyOn(platform, 'findRg').mockReturnValue(backend === 'rg' ? installedRg : null);
    const f = await fixture();
    const cases: Array<{ call: Call; has?: string; absent?: string; exact?: string }> = [
      { call: { name: 'read_file', input: { path: 'README.md' } }, has: 'needle root' },
      { call: { name: 'read_file', input: { path: 'src/a.ts' } }, has: 'needle = 1' },
      { call: { name: 'read_file', input: { path: join(f.cwd, 'src/a.ts') } }, has: 'needle = 1' },
      { call: { name: 'read_file', input: { path: 'src/nested/b.ts', offset: 1, limit: 1 } }, has: 'needle = 2' },
      { call: { name: 'glob', input: { pattern: '*.md' } }, exact: 'README.md' },
      { call: { name: 'glob', input: { pattern: '*.ts', path: 'src' } }, exact: 'a.ts' },
      { call: { name: 'glob', input: { pattern: '**/*.ts', path: join(f.cwd, 'src') } }, has: 'nested/b.ts' },
      { call: { name: 'glob', input: { pattern: 'src/**/*.ts' } }, has: 'src/nested/b.ts' },
      { call: { name: 'glob', input: { pattern: '**/*.absent' } }, exact: '(no matches)' },
      { call: { name: 'glob', input: { pattern: '**/*', path: 'empty' } }, exact: '(no matches)' },
      { call: { name: 'grep', input: { pattern: 'needle' } }, has: 'README.md:1:' },
      { call: { name: 'grep', input: { pattern: 'needle', path: 'src' } }, has: 'nested/b.ts:1:', absent: 'README.md' },
      { call: { name: 'grep', input: { pattern: 'needle', path: join(f.cwd, 'src'), glob: '*.ts' } }, has: 'nested/b.ts:1:', absent: 'a.txt' },
      { call: { name: 'grep', input: { pattern: 'needle', glob: 'src/**/*.ts' } }, has: 'src/a.ts:1:' },
      { call: { name: 'grep', input: { pattern: 'NEEDLE', case_insensitive: true, glob: 'README.md' } }, has: 'README.md:1:' },
      { call: { name: 'grep', input: { pattern: 'never_present_fixture' } }, exact: '(no matches)' },
      { call: { name: 'grep', input: { pattern: 'needle', glob: '**/*.absent' } }, exact: '(no matches)' },
      { call: { name: 'grep', input: { pattern: 'needle', path: 'empty' } }, exact: '(no matches)' },
    ];
    const result = await f.run(cases.map(row => row.call));
    expectSuccessful(result.results);
    expect(result).toMatchObject({ judge: 0, human: 0, executed: cases.length });
    for (const [index, row] of cases.entries()) {
      const content = result.results[index]!.content;
      if (row.has !== undefined) expect(content).toContain(row.has);
      if (row.absent !== undefined) expect(content).not.toContain(row.absent);
      if (row.exact !== undefined) expect(content).toBe(row.exact);
    }
    expect(result.events.filter(event => event.type === 'permission_decision' && event.phase === 'pipeline')).toHaveLength(cases.length);
    expect(result.events.filter(event => event.type === 'permission_decision' && event.phase === 'pipeline')
      .every(event => event.type === 'permission_decision' && event.decision.reasonCode === 'safe_read')).toBe(true);
  });
  }

  it('显式敏感文件、外部路径、符号链接与逃逸过滤模式均硬询问，不委托模型', async () => {
    const f = await fixture({ prepare: async (cwd, outside) => {
      await writeFile(join(cwd, 'src/.env'), 'SECRET_SENTINEL=needle');
      await mkdir(join(cwd, 'credentials'));
      await writeFile(join(cwd, 'credentials/token.txt'), 'SECRET_SENTINEL needle');
      await symlink(outside, join(cwd, 'external'));
      await symlink('src/.env', join(cwd, 'env-alias.txt'));
      await link(join(cwd, 'src/.env'), join(cwd, 'hard-alias.txt'));
    } });
    const calls: Call[] = [
      { name: 'read_file', input: { path: 'src/.env' } },
      { name: 'read_file', input: { path: 'credentials/token.txt' } },
      { name: 'read_file', input: { path: '../outside/a.ts' } },
      { name: 'read_file', input: { path: 'external/a.ts' } },
      { name: 'read_file', input: { path: 'env-alias.txt' } },
      { name: 'read_file', input: { path: 'hard-alias.txt' } },
      { name: 'glob', input: { pattern: '**/.env' } },
      { name: 'glob', input: { pattern: '**/*', path: 'credentials' } },
      { name: 'glob', input: { pattern: '../outside/**' } },
      { name: 'glob', input: { pattern: '{../outside,src}/**' } },
      { name: 'glob', input: { pattern: '**/*', path: f.outside } },
      { name: 'glob', input: { pattern: '**/*', path: 'external' } },
      { name: 'grep', input: { pattern: 'needle', glob: '**/.env' } },
      { name: 'grep', input: { pattern: 'needle', path: 'credentials' } },
      { name: 'grep', input: { pattern: 'needle', path: '../outside' } },
      { name: 'grep', input: { pattern: 'needle', path: 'external' } },
      { name: 'grep', input: { pattern: 'needle', glob: '../outside/**' } },
      { name: 'grep', input: { pattern: 'needle', glob: '{../outside,src}/**' } },
    ];
    const result = await f.run(calls);
    expect(result).toMatchObject({ judge: 0, human: calls.length, executed: 0 });
    for (const item of result.results) {
      expect(item.isError).toBe(true);
      expect(item.content).not.toContain('SECRET_SENTINEL');
      expect(item.content).not.toContain('OUTSIDE_SENTINEL');
    }
  });

  for (const backend of ['rg', 'builtin'] as const) {
  it.runIf(backend === 'builtin' || Boolean(installedRg))(`${backend}：普通根搜索排除真实敏感文件、硬链接、文件及目录 symlink 和自定义插件入口`, async () => {
    vi.spyOn(platform, 'findRg').mockReturnValue(backend === 'rg' ? installedRg : null);
    const f = await fixture({ pluginFixture: true, prepare: async (cwd, outside) => {
      await writeFile(join(cwd, 'src/.env'), 'SECRET_SENTINEL needle');
      await writeFile(join(cwd, 'credentials.json'), 'SECRET_SENTINEL needle');
      await link(join(cwd, 'src/.env'), join(cwd, 'hard-alias.txt'));
      await symlink('src/.env', join(cwd, 'env-alias.txt'));
      await symlink(join(outside, 'a.ts'), join(cwd, 'outside-alias.ts'));
      await symlink(outside, join(cwd, 'external'));
    } });
    const result = await f.run([
      { name: 'grep', input: { pattern: 'needle' } },
      { name: 'glob', input: { pattern: '**/*' } },
    ]);
    expectSuccessful(result.results);
    expect(result).toMatchObject({ judge: 0, human: 0, executed: 2 });
    const output = result.results.map(item => item.content).join('\n');
    for (const denied of ['SECRET_SENTINEL', 'OUTSIDE_SENTINEL', 'PLUGIN_SENTINEL', '.env', 'credentials.json', 'hard-alias', 'env-alias', 'outside-alias', 'external/', 'adapter.mjs', 'adapter-alias']) expect(output).not.toContain(denied);
    expect(output).toContain('src/a.ts');
    const protectedResult = await f.run([
      { name: 'read_file', input: { path: 'adapter-alias.mjs' } },
      { name: 'glob', input: { pattern: 'extensions/adapter.mjs' } },
      { name: 'grep', input: { pattern: 'needle', glob: 'extensions/adapter.mjs' } },
    ]);
    expect(protectedResult).toMatchObject({ judge: 0, human: 3, executed: 0 });
  });
  }

  for (const backend of ['rg', 'builtin'] as const) {
  it.runIf(backend === 'builtin' || Boolean(installedRg))(`${backend}：层级 gitignore、否定规则与子目录 path 保持一致，零模型和人工审批`, async () => {
    vi.spyOn(platform, 'findRg').mockReturnValue(backend === 'rg' ? installedRg : null);
    const f = await fixture({ prepare: async cwd => {
      await writeFile(join(cwd, '.gitignore'), '*.log\nsrc/root-drop.ts\nsrc/nested/revive.ts\nsrc/nested/blocked/\n');
      await writeFile(join(cwd, 'src/.gitignore'), 'local-drop.ts\n');
      await writeFile(join(cwd, 'src/nested/.gitignore'), '!revive.ts\nnested-drop.ts\n');
      await mkdir(join(cwd, 'src/nested/blocked'));
      await writeFile(join(cwd, 'src/nested/blocked/.gitignore'), '!keep.ts\n');
      for (const path of ['ignored.log', 'src/root-drop.ts', 'src/local-drop.ts', 'src/nested/nested-drop.ts', 'src/nested/ignored.log', 'src/nested/blocked/keep.ts']) {
        await writeFile(join(cwd, path), 'IGNORED_SENTINEL needle\n');
      }
      await writeFile(join(cwd, 'src/nested/revive.ts'), 'REVIVED_SENTINEL needle\n');
      await writeFile(join(cwd, 'src/nested/plain.ts'), 'VISIBLE_SENTINEL needle\n');
    } });
    const calls: Call[] = [
      { name: 'grep', input: { pattern: 'needle' } },
      { name: 'glob', input: { pattern: '**/*' } },
      { name: 'grep', input: { pattern: 'needle', path: 'src' } },
      { name: 'glob', input: { pattern: '**/*', path: 'src' } },
      { name: 'grep', input: { pattern: 'needle', path: join(f.cwd, 'src/nested') } },
      { name: 'glob', input: { pattern: '**/*', path: 'src/nested' } },
      { name: 'grep', input: { pattern: 'needle', path: 'src/nested/blocked' } },
      { name: 'glob', input: { pattern: '**/*', path: 'src/nested/blocked' } },
    ];
    const result = await f.run(calls);
    expectSuccessful(result.results);
    expect(result).toMatchObject({ judge: 0, human: 0, executed: calls.length });
    for (const item of result.results.slice(0, 6)) {
      expect(item.content).toContain('revive.ts');
      expect(item.content).toContain('plain.ts');
      expect(item.content).toContain('b.ts');
      expect(item.content).not.toMatch(/IGNORED_SENTINEL|ignored\.log|root-drop\.ts|local-drop\.ts|nested-drop\.ts|keep\.ts|\.gitignore/);
    }
    for (const index of [0, 2, 4]) {
      expect(result.results[index]!.content).toContain('REVIVED_SENTINEL');
      expect(result.results[index]!.content).toContain('VISIBLE_SENTINEL');
    }
    expect(result.results[0]!.content).toContain('README.md:1:');
    expect(result.results[2]!.content).not.toContain('README.md');
    expect(result.results[4]!.content).toContain('revive.ts:1:');
    expect(result.results[6]!.content).toBe('(no matches)');
    expect(result.results[7]!.content).toBe('(no matches)');
  });
  }

  const ruleCases = (['config', 'session'] as const).flatMap(source => (['ask', 'deny'] as const).flatMap(kind =>
    (['read_file', 'grep', 'glob'] as const).map(name => ({ source, kind, name }))));
  it.each(ruleCases)('$source $kind 对 $name 的真实目标优先于 allow 和 auto 安全读', async ({ source, kind, name }) => {
    const restriction = `${name}(="src/a.ts")`;
    const f = await fixture({ rules: { allow: [name, restriction], ...(source === 'config' ? { [kind]: [restriction] } : {}) } });
    if (source === 'session') f.agent.permission.addSessionRule(kind, restriction);
    const input = name === 'read_file' ? { path: './src/a.ts' } : name === 'glob' ? { pattern: 'src/**/*.ts' } : { pattern: 'needle', glob: 'src/**/*.ts' };
    const result = await f.run([{ name, input }]);
    expect(result).toMatchObject({ judge: 0, human: kind === 'ask' ? 1 : 0, executed: 0 });
    expect(result.results[0]!.isError).toBe(true);
    expect(result.events).toContainEqual(expect.objectContaining({
      type: 'permission_decision', phase: 'pipeline', decision: expect.objectContaining({
        kind, source, matchedRule: restriction, reasonCode: kind === 'ask' ? 'explicit_ask' : 'deny_rule',
      }),
    }));
  });

  it.each((['config', 'session'] as const).flatMap(source => (['grep', 'glob'] as const).map(name => ({ source, name }))))
  ('$source 单候选 allow 不会在 ask 模式授权 $name 的整批文件', async ({ source, name }) => {
    const grant = `${name}(="src/a.ts")`;
    const f = await fixture({ mode: 'ask', rules: { allow: source === 'config' ? [grant] : [] } });
    if (source === 'session') f.agent.permission.addSessionRule('allow', grant);
    const input = name === 'glob' ? { pattern: 'src/**/*.ts' } : { pattern: 'needle', glob: 'src/**/*.ts' };
    const result = await f.run([{ name, input }]);
    expect(result).toMatchObject({ judge: 0, human: 1, executed: 0 });
    expect(result.results[0]!.isError).toBe(true);
  });

  it('同一 runtime 调用间新增普通文件重新枚举，并对新增文件应用既有 deny', async () => {
    const f = await fixture();
    const calls: Call[] = [
      { name: 'glob', input: { pattern: 'src/**/*.ts' } },
      { name: 'grep', input: { pattern: 'added_fixture', glob: 'src/**/*.ts' } },
    ];
    const first = await f.run(calls);
    expect(first).toMatchObject({ judge: 0, human: 0, executed: 2 });
    expect(first.results[0]!.content).not.toContain('added.ts');
    expect(first.results[1]!.content).toBe('(no matches)');
    await writeFile(join(f.cwd, 'src/added.ts'), 'added_fixture\n');
    const second = await f.run(calls);
    expect(second).toMatchObject({ judge: 0, human: 0, executed: 2 });
    expectSuccessful(second.results);
    expect(second.results[0]!.content).toContain('src/added.ts');
    expect(second.results[1]!.content).toContain('src/added.ts:1:');
    for (const name of ['glob', 'grep']) f.agent.permission.addSessionRule('deny', `${name}(="src/later.ts")`);
    await writeFile(join(f.cwd, 'src/later.ts'), 'added_fixture\n');
    const third = await f.run(calls);
    expect(third).toMatchObject({ judge: 0, human: 0, executed: 0 });
    expect(third.results.every(result => result.isError)).toBe(true);
  });

  it('同一 runtime 的搜索根 symlink 从项目内重定向项目外后不复用先前放行', async () => {
    const f = await fixture({ prepare: async cwd => { await symlink('src', join(cwd, 'selected')); } });
    const calls: Call[] = [
      { name: 'read_file', input: { path: 'selected/a.ts' } },
      { name: 'glob', input: { pattern: '**/*.ts', path: 'selected' } },
      { name: 'grep', input: { pattern: 'needle', path: 'selected' } },
    ];
    const first = await f.run(calls);
    expectSuccessful(first.results);
    expect(first).toMatchObject({ judge: 0, human: 0, executed: 3 });
    await unlink(join(f.cwd, 'selected'));
    await symlink(f.outside, join(f.cwd, 'selected'));
    const second = await f.run(calls);
    expect(second).toMatchObject({ judge: 0, human: 3, executed: 0 });
    for (const item of second.results) expect(item.content).not.toContain('OUTSIDE_SENTINEL');
  });

  it.each(['grep', 'glob'] as const)('%s 放行决定后新增受 deny 保护的候选，执行前重验使旧决定失效', async name => {
    const f = await fixture({ rules: { deny: [`${name}(="src/blocked.ts")`] } });
    let inserted = false;
    f.agent.events.on('permission_decision', event => {
      if (!inserted && event.phase === 'pipeline' && event.toolName === name && event.decision.kind === 'allow') {
        inserted = true;
        writeFileSync(join(f.cwd, 'src/blocked.ts'), 'NEW_DENIED_SENTINEL needle\n');
      }
    });
    const input = name === 'glob' ? { pattern: 'src/**/*.ts' } : { pattern: 'needle', glob: 'src/**/*.ts' };
    const result = await f.run([{ name, input }]);
    expect(inserted).toBe(true);
    expect(result).toMatchObject({ judge: 0, human: 0, executed: 0 });
    expect(result.results[0]!.isError).toBe(true);
    expect(result.results[0]!.content).not.toContain('NEW_DENIED_SENTINEL');
    expect(result.events.some(event => event.type === 'tool_execution' && event.reasonCode === 'environment_changed')).toBe(true);
  });

  it.each(['grep', 'glob'] as const)('%s 放行决定后搜索根被重定向项目外，执行前重验转为人工确认', async name => {
    const f = await fixture({ prepare: async cwd => { await symlink('src', join(cwd, 'selected')); } });
    let redirected = false;
    f.agent.events.on('permission_decision', event => {
      if (!redirected && event.phase === 'pipeline' && event.toolName === name && event.decision.kind === 'allow') {
        redirected = true;
        unlinkSync(join(f.cwd, 'selected'));
        symlinkSync(f.outside, join(f.cwd, 'selected'));
      }
    });
    const input = name === 'glob' ? { pattern: '**/*.ts', path: 'selected' } : { pattern: 'needle', path: 'selected' };
    const result = await f.run([{ name, input }]);
    expect(redirected).toBe(true);
    expect(result).toMatchObject({ judge: 0, human: 1, executed: 0 });
    expect(result.results[0]!.isError).toBe(true);
    expect(result.results[0]!.content).not.toContain('OUTSIDE_SENTINEL');
    expect(result.events.some(event => event.type === 'tool_execution' && event.reasonCode === 'environment_changed')).toBe(true);
  });

  it.each((['grep', 'glob'] as const).flatMap(name => (['deny', 'ask'] as const).map(kind => ({ name, kind }))))
  ('$name 最终重验后才出现的 $kind 目标不进入已经绑定的搜索范围', async ({ name, kind }) => {
    const f = await fixture({ rules: { [kind]: [`${name}(="src/later.ts")`] } });
    let inserted = false;
    // tool_call 在最终 analyzer.revalidate 之后、工具 execute 之前同步发出。
    f.agent.events.on('tool_call', event => {
      if (!inserted && event.toolUse.name === name) {
        inserted = true;
        writeFileSync(join(f.cwd, 'src/later.ts'), 'AFTER_REVALIDATION_SENTINEL needle\n');
      }
    });
    const input = name === 'glob' ? { pattern: 'src/**/*.ts' } : { pattern: 'needle', glob: 'src/**/*.ts' };
    const result = await f.run([{ name, input }]);
    expect(inserted).toBe(true);
    // 已发出一次 tool_call，但实际搜索必须在发现范围变化时失败，不能读取新候选。
    expect(result).toMatchObject({ judge: 0, human: 0, executed: 1 });
    expect(result.results[0]!.isError).toBe(true);
    expect(result.results[0]!.content).toContain('approval_stale');
    expect(result.results[0]!.content).not.toContain('AFTER_REVALIDATION_SENTINEL');
    expect(result.results[0]!.content).not.toContain('src/later.ts');
    expect(result.events.some(event => event.type === 'tool_execution' && event.phase === 'execution' && event.reasonCode === 'tool_error')).toBe(true);
    expect(result.events.some(event => event.type === 'tool_execution' && event.reasonCode === 'tool_success')).toBe(false);
  });

  it.runIf(Boolean(installedRg))('真实 rg 忽略预处理器/隐藏文件/跟随链接配置，不执行配置中的程序', async () => {
    vi.spyOn(platform, 'findRg').mockReturnValue(installedRg);
    const f = await fixture({ prepare: async (cwd, outside, root) => {
      await writeFile(join(cwd, 'src/.env'), 'SECRET_SENTINEL needle');
      await symlink(outside, join(cwd, 'external'));
      const script = join(root, 'preprocess.sh');
      await writeFile(script, `#!/bin/sh\nprintf ran > '${join(root, 'preprocessor-ran')}'\ncat "$1"\n`, { mode: 0o700 });
      const config = join(root, 'ripgrep-config');
      await writeFile(config, `--hidden\n--follow\n--pre\n${script}\n`);
      vi.stubEnv('RIPGREP_CONFIG_PATH', config);
    } });
    const result = await f.run([{ name: 'grep', input: { pattern: 'needle' } }]);
    expectSuccessful(result.results);
    expect(result).toMatchObject({ judge: 0, human: 0, executed: 1 });
    expect(result.results[0]!.content).toContain('README.md:1:');
    expect(result.results[0]!.content).not.toMatch(/SECRET_SENTINEL|OUTSIDE_SENTINEL/);
    await expect(readFile(join(f.root, 'preprocessor-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('对照：未知 shell 仍实际调用一次 reviewer，再进行人工审批，计数器不是空壳', async () => {
    const f = await fixture();
    const result = await f.run([{ name: 'bash', input: { command: 'npm test' } }]);
    expect(result).toMatchObject({ judge: 1, human: 1, executed: 0 });
    expect(result.results[0]!.isError).toBe(true);
    expect(result.events.some(event => event.type === 'tool_execution' && event.phase === 'reviewer')).toBe(true);
  });
});

it.each(['grep', 'glob'] as const)('%s：实际读取的 .gitignore 也受路径 deny/ask 保护', async name => {
  for (const kind of ['deny', 'ask'] as const) {
    const state = await fixture({ rules: { [kind]: [`${name}(=".gitignore")`] }, prepare: async cwd => {
      await writeFile(join(cwd, '.gitignore'), '*.log\n');
    } });
    const outcome = await state.run([{ name, input: { pattern: name === 'grep' ? 'needle' : '**/*' } }]);
    expect(outcome.judge).toBe(0); expect(outcome.human).toBe(kind === 'ask' ? 1 : 0); expect(outcome.executed).toBe(0);
  }
});

it('literal glob 精确授权只匹配真实请求文件，辅助ignore和根目录不能放行其他文件', async () => {
  const state = await fixture({ mode: 'ask', rules: { allow: ['glob(=".gitignore")', 'glob(="src/a.ts")'] }, prepare: async cwd => {
    await writeFile(join(cwd, '.gitignore'), '*.log\n');
  } });
  const allowed = await state.run([{ name: 'glob', input: { pattern: 'a.ts', path: 'src' } }]);
  expect(allowed.judge).toBe(0); expect(allowed.human).toBe(0); expect(allowed.results[0].content).toBe('a.ts');
  const refused = await state.run([{ name: 'glob', input: { pattern: 'a.txt', path: 'src' } }]);
  expect(refused.judge).toBe(0); expect(refused.human).toBe(1); expect(refused.executed).toBe(0);
  state.agent.permission.addSessionRule('allow', `glob(=${JSON.stringify(state.cwd)})`);
  const rootOnly = await state.run([{ name: 'glob', input: { pattern: 'README.md' } }]);
  expect(rootOnly.human).toBe(1); expect(rootOnly.executed).toBe(0);
});
