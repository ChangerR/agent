/** 真实 auto runtime 的 shell 回归：隔离 HOME/项目、假 provider、真实执行与审批计数。 */
import { execFileSync } from 'node:child_process';
import { symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent, definePlugin, type Agent, type PermissionMode, type SessionRules } from '../src/index.js';
import type { AgentEvent } from '../src/core/events.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';

const roots: string[] = [];
const agents: Agent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

type Options = { mode?: PermissionMode; rules?: Partial<SessionRules>; reviewer?: 'allow' | 'ask'; prepare?: (cwd: string, root: string) => Promise<void> };
async function fixture(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-shell-runtime-')); roots.push(root);
  const cwd = join(root, 'project'); const home = join(root, 'home');
  await mkdir(cwd); await mkdir(home); await mkdir(join(cwd, 'src'));
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  for (const name of ['BASH_ENV', 'ENV', 'RIPGREP_CONFIG_PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'PAGER']) vi.stubEnv(name, '');
  execFileSync('git', ['init', '-q', cwd], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } });
  await writeFile(join(cwd, 'package.json'), '{"name":"shell-fixture","private":true}\n');
  await writeFile(join(cwd, 'README.md'), 'before tracked\n');
  const gitEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  execFileSync('git', ['add', 'README.md'], { cwd, env: gitEnv });
  execFileSync('git', ['-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd, env: gitEnv });
  await writeFile(join(cwd, 'README.md'), 'needle first\nsecond line\nneedle last\n');
  await writeFile(join(cwd, 'quoted name.txt'), 'quoted needle\n');
  await writeFile(join(cwd, 'src/a.ts'), 'export const needle = 1;\n');
  await writeFile(join(cwd, 'src/b.ts'), 'export const other = 2;\n');
  await options.prepare?.(cwd, root);
  let pending: Array<{ id: string; name: string; input: { command: string } }> = []; let emitted = false; let sequence = 0;
  const provider = new FakeProvider([request => {
    if (!request.tools.length) return textResponse(JSON.stringify({ decision: options.reviewer ?? 'ask', reasonCode: 'offline_shell_fixture', reason: '离线测试审批' }));
    if (emitted) return textResponse('done');
    emitted = true; return toolUseResponse(pending);
  }]);
  const plugin = definePlugin({ manifest: { id: 'test.shell-provider', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    ctx.provide.provider('shell-fixture', { name: 'shell-fixture', capabilities: provider.capabilities, stream: provider.stream.bind(provider) });
  } });
  const agent = await createAgent(cwd, { autoSaveSessions: false, plugins: [plugin], config: {
    provider: 'shell-fixture', model: 'offline-shell-model', permissionMode: options.mode ?? 'auto', permissions: { allow: [], ask: [], deny: [], ...options.rules },
  } }); agents.push(agent);
  expect(agent.plugins.selected('policy')?.id).toBe('deterministic'); expect(agent.plugins.selected('reviewer')?.id).toBe('model');
  const events: AgentEvent[] = []; agent.events.onAll(event => events.push(event));
  agent.events.on('permission_request', event => event.resolve({ allow: false }));
  async function run(commands: string[]) {
    pending = commands.map((command, index) => ({ id: `shell-${sequence}-${index}`, name: 'bash', input: { command } })); sequence++; emitted = false;
    const eventStart = events.length; const requestStart = provider.requests.length;
    expect((await agent.loop.run('Inspect these project files with the requested shell commands.')).reason).toBe('completed');
    const current = events.slice(eventStart);
    const results = pending.map(call => {
      const result = current.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result' && event.toolUseId === call.id);
      expect(result, call.input.command).toBeDefined(); return result!.result;
    });
    const judge = current.filter(event => event.type === 'model_request' && event.purpose === 'judge').length;
    expect(provider.requests.slice(requestStart).filter(request => !request.tools.length)).toHaveLength(judge);
    return { results, events: current, judge, human: current.filter(event => event.type === 'permission_request').length, executed: current.filter(event => event.type === 'tool_call').length };
  }
  return { agent, root, cwd, home, run };
}

describe.skipIf(process.platform === 'win32')('默认 auto shell 真实执行', () => {
  it('原始 ls && echo && cat 请求输出正确且无需模型或人工审批', async () => {
    const f = await fixture({ reviewer: 'allow' });
    const result = await f.run(['ls -la && echo "---" && cat package.json']);
    if (process.env.SHELL_BASELINE_REPORT) console.log(JSON.stringify({ command: 'ls -la && echo "---" && cat package.json', judge: result.judge, human: result.human, executed: result.executed, result: result.results[0] }, null, 2));
    expect(result.results[0].isError, result.results[0].content).not.toBe(true);
    expect(result.results[0].content).toContain('package.json'); expect(result.results[0].content).toContain('---\n{"name":"shell-fixture","private":true}');
    expect(result).toMatchObject({ judge: 0, human: 0, executed: 1 });
  });
});

// 每种语法分别通过真实执行门，不能靠隐藏审批 UI 或只改计数器通过。
describe.skipIf(process.platform === 'win32')('只读 shell 命令矩阵', () => {
  it('常用命令、引号、条件连接与管道均执行并保持真实输出', async () => {
    const f = await fixture();
    const cases = [
      { command: 'ls -la', has: 'package.json' },
      { command: 'pwd', has: f.cwd },
      { command: 'echo "literal ; && | text"', exact: 'literal ; && | text\n' },
      { command: 'cat "quoted name.txt"', exact: 'quoted needle\n' },
      { command: "cat 'quoted name.txt'", exact: 'quoted needle\n' },
      { command: 'cat quoted\\ name.txt', exact: 'quoted needle\n' },
      { command: `cat 'quoted 'name.txt`, exact: 'quoted needle\n' },
      { command: 'cat -- README.md', has: 'needle first' },
      { command: 'head -n 1 README.md', exact: 'needle first\n' },
      { command: 'tail -n 1 README.md', exact: 'needle last\n' },
      { command: 'wc -l README.md', has: '3 README.md' },
      { command: 'grep -n needle README.md', has: '1:needle first' },
      { command: 'grep -in NEEDLE README.md', has: '3:needle last' },
      { command: 'rg -n needle README.md', has: '1:needle first' },
      { command: 'rg -in NEEDLE README.md', has: '3:needle last' },
      { command: "find src -type f -name '*.ts'", has: 'src/a.ts' },
      { command: 'git status --short', has: ' M README.md' },
      { command: 'git diff -- README.md', has: '+needle first' },
      { command: 'cat package.json && echo done', has: '\ndone\n' },
      { command: 'grep absent README.md || echo fallback', exact: 'fallback\n' },
      { command: 'echo first; echo second', exact: 'first\nsecond\n' },
      { command: 'cat README.md | grep needle | wc -l', exact: '2\n' },
      { command: 'head -n 2 README.md | tail -n 1', exact: 'second line\n' },
      { command: 'echo "---" && cat "quoted name.txt" | head -n 1', exact: '---\nquoted needle\n' },
    ];
    for (const row of cases) {
      const result = await f.run([row.command]);
      expect(result, row.command).toMatchObject({ judge: 0, human: 0, executed: 1 });
      expect(result.results[0].isError, `${row.command}: ${result.results[0].content}`).not.toBe(true);
      if (row.has) expect(result.results[0].content, row.command).toContain(row.has);
      if (row.exact) expect(result.results[0].content, row.command).toBe(row.exact);
    }
  });

  it.each([
    'echo $((1 + 2))', 'items=(README.md); cat "${items[0]}"', 'readit() { cat README.md; }; readit',
    '(cat README.md)', '{ cat README.md; }', 'cat README.md &', 'cat <<EOF\nfixture\nEOF',
    'echo changed > mutated.txt', 'cat README.md >> mutated.txt', 'cat < README.md',
    'ls -la && touch mutated.txt', 'grep absent README.md || touch mutated.txt',
    'echo changed; touch mutated.txt', 'cat README.md | tee mutated.txt',
    'echo "$(touch mutated.txt)"', 'echo `touch mutated.txt`', 'cat <(echo changed)',
    'VALUE=x cat README.md', 'env cat README.md', 'bash -c "cat README.md"',
    'tail -f README.md', 'find src -exec touch mutated.txt \\;', 'find src -delete',
    'rg --pre ./preprocess.sh needle README.md', 'grep -f .env README.md',
    'git -c alias.scan="!touch mutated.txt" scan', 'git diff --output=mutated.txt',
    'git -c diff.external=./preprocess.sh diff', 'git status --porcelain && git add README.md',
    'rm README.md', 'sed -i s/needle/changed/ README.md', 'chmod 777 README.md',
  ])('未知或含副作用的命令保持审批并不执行：%s', async command => {
    const f = await fixture(); const before = await readFile(join(f.cwd, 'README.md'), 'utf8');
    const result = await f.run([command]);
    expect(result.executed, command).toBe(0); expect(result.results[0].isError).toBe(true);
    expect(result.human + result.events.filter(event => event.type === 'permission_decision' && event.decision.kind === 'deny').length, command).toBeGreaterThan(0);
    expect(await readFile(join(f.cwd, 'README.md'), 'utf8')).toBe(before);
    await expect(readFile(join(f.cwd, 'mutated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(f.cwd, 'src/a.ts'), 'utf8')).toContain('needle = 1');
  });

  it.each(['cat .env', 'head -n 1 .env', 'tail -n 1 .env', 'wc -l .env', 'grep SECRET .env', 'rg SECRET .env', "rg -g '.env' SECRET .", "rg -g '**' SECRET .", "rg --iglob '.ENV' SECRET .", 'grep -r SECRET .', 'cat ../outside.txt'])
  ('敏感或越界读取直接人工询问：%s', async command => {
    const f = await fixture({ prepare: async (cwd, root) => {
      await writeFile(join(cwd, '.env'), 'SHELL_SECRET_SENTINEL=fixture-only\n');
      await writeFile(join(root, 'outside.txt'), 'SHELL_OUTSIDE_SENTINEL\n');
    } });
    const result = await f.run([command]);
    expect(result).toMatchObject({ judge: 0, human: 1, executed: 0 });
    expect(result.results[0].content).not.toMatch(/SHELL_SECRET_SENTINEL|SHELL_OUTSIDE_SENTINEL/);
  });

  it.each(['ask', 'deny'] as const)('显式 %s 规则优先于已证明只读 shell', async kind => {
    const command = 'cat package.json'; const f = await fixture({ rules: { [kind]: ['bash(cat *)'] } });
    const result = await f.run([command]);
    expect(result).toMatchObject({ judge: 0, human: kind === 'ask' ? 1 : 0, executed: 0 });
    expect(result.results[0].isError).toBe(true);
  });

  it('未知 npm 命令确实进入 reviewer 与人工审批，计数器不是空壳', async () => {
    const f = await fixture(); const result = await f.run(['npm test']);
    expect(result).toMatchObject({ judge: 1, human: 1, executed: 0 });
  });

  it('注入 ENV、函数、搜索预处理器、PATH 与 Git 配置不能改变已证明的只读执行', async () => {
    const f = await fixture();
    const marker = join(f.root, 'injected-ran'); const hook = join(f.root, 'injected.sh');
    await writeFile(hook, `#!/bin/sh\nprintf injected > '${marker}'\n`, { mode: 0o700 });
    const bin = join(f.root, 'bin'); await mkdir(bin);
    for (const name of ['bash', 'cat', 'ls', 'grep', 'rg', 'git']) await writeFile(join(bin, name), `#!/bin/sh\nprintf injected > '${marker}'\nprintf INJECTED_OUTPUT\n`, { mode: 0o700 });
    const rgConfig = join(f.root, 'rg-config'); await writeFile(rgConfig, `--pre\n${hook}\n`);
    const gitConfig = join(f.root, 'git-config'); await writeFile(gitConfig, `[core]\n pager = ${hook}\n[diff]\n external = ${hook}\n`);
    vi.stubEnv('BASH_ENV', hook); vi.stubEnv('ENV', hook); vi.stubEnv('BASH_FUNC_cat%%', `() { '${hook}'; }`);
    vi.stubEnv('RIPGREP_CONFIG_PATH', rgConfig); vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', 'core.fsmonitor'); vi.stubEnv('GIT_CONFIG_VALUE_0', hook);
    vi.stubEnv('GIT_EXTERNAL_DIFF', hook); vi.stubEnv('GIT_PAGER', hook); vi.stubEnv('PAGER', hook);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    for (const command of ['ls -la && echo "---" && cat package.json', 'rg -n needle README.md', 'git status --short', 'git diff -- README.md']) {
      const result = await f.run([command]);
      expect(result, command).toMatchObject({ judge: 0, human: 0, executed: 1 });
      expect(result.results[0].isError, result.results[0].content).not.toBe(true);
      expect(result.results[0].content).not.toContain('INJECTED_OUTPUT');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe.skipIf(process.platform === 'win32')('shell 目标与规则的真实身份', () => {
  it.each(['ask', 'deny'] as const)('规范化 shell 文件操作数匹配 %s 路径规则', async kind => {
    const f = await fixture({ rules: { [kind]: ['bash(="README.md")'] } });
    for (const command of ['cat ./src/../README.md', 'head -n 1 README.md', 'cat README.md | wc -l']) {
      const result = await f.run([command]);
      expect(result, command).toMatchObject({ judge: 0, human: kind === 'ask' ? 1 : 0, executed: 0 });
    }
  });

  it.each(['secret-link.txt', 'secret-hardlink.txt', 'outside-link.txt'])('文件别名不能读取敏感或外部数据：%s', async path => {
    const f = await fixture({ prepare: async (cwd, root) => {
      await writeFile(join(cwd, '.env'), 'SHELL_SECRET_SENTINEL=fixture-only\n');
      await writeFile(join(root, 'outside.txt'), 'SHELL_OUTSIDE_SENTINEL\n');
      await symlink('.env', join(cwd, 'secret-link.txt'));
      await link(join(cwd, '.env'), join(cwd, 'secret-hardlink.txt'));
      await symlink(join(root, 'outside.txt'), join(cwd, 'outside-link.txt'));
    } });
    const result = await f.run([`cat ${path}`]);
    expect(result).toMatchObject({ judge: 0, human: 1, executed: 0 });
    expect(result.results[0].content).not.toMatch(/SHELL_SECRET_SENTINEL|SHELL_OUTSIDE_SENTINEL/);
  });

  it('ask 模式仍需人工确认，yolo 仍尊重 deny 与危险检测', async () => {
    const ask = await fixture({ mode: 'ask' });
    expect(await ask.run(['cat package.json'])).toMatchObject({ judge: 0, human: 1, executed: 0 });
    const yolo = await fixture({ mode: 'yolo', rules: { deny: ['bash(cat *)'] } });
    expect(await yolo.run(['cat package.json'])).toMatchObject({ judge: 0, human: 0, executed: 0 });
    expect(await yolo.run(['sudo cat package.json'])).toMatchObject({ judge: 0, human: 1, executed: 0 });
  });
});

it.skipIf(process.platform === 'win32')('最终执行前文件替换为敏感链接时拒绝旧只读授权', async () => {
  const f = await fixture({ prepare: async cwd => { await writeFile(join(cwd, '.env'), 'SHELL_RACE_SECRET=fixture-only\n'); } });
  let changed = false;
  f.agent.events.on('tool_call', event => {
    if (event.toolUse.name !== 'bash' || changed) return;
    changed = true;
    unlinkSync(join(f.cwd, 'README.md'));
    symlinkSync('.env', join(f.cwd, 'README.md'));
  });
  const result = await f.run(['cat README.md']);
  expect(changed).toBe(true); expect(result).toMatchObject({ judge: 0, human: 0, executed: 1 });
  expect(result.results[0].isError).toBe(true); expect(result.results[0].content).toContain('approval_stale');
  expect(result.results[0].content).not.toContain('SHELL_RACE_SECRET');
});

it.skipIf(process.platform === 'win32')('最终执行前递归搜索范围增加敏感文件时拒绝旧授权', async () => {
  const f = await fixture(); let changed = false;
  f.agent.events.on('tool_call', event => {
    if (event.toolUse.name !== 'bash' || changed) return;
    changed = true;
    writeFileSync(join(f.cwd, 'src/.env'), 'SHELL_RACE_SECRET=needle\n');
  });
  const result = await f.run(['grep -r needle src']);
  expect(changed).toBe(true); expect(result).toMatchObject({ judge: 0, human: 0, executed: 1 });
  expect(result.results[0].isError).toBe(true); expect(result.results[0].content).toContain('approval_stale');
  expect(result.results[0].content).not.toContain('SHELL_RACE_SECRET');
});

it.skipIf(process.platform === 'win32')('rg -E 编码参数不能误作 pattern 而漏掉默认递归搜索范围', async () => {
  const f = await fixture({ prepare: async cwd => {
    await mkdir(join(cwd, 'secrets'));
    await writeFile(join(cwd, 'secrets/data.txt'), 'SHELL_ENCODING_SECRET NEEDLE\n');
  } });
  const result = await f.run(['rg -E utf-8 NEEDLE']);
  expect(result).toMatchObject({ judge: 0, human: 1, executed: 0 });
  expect(result.results[0].content).not.toContain('SHELL_ENCODING_SECRET');
});

it.skipIf(process.platform === 'win32')('中间符号链接加 .. 保留内核路径语义，不能词法化为项目内普通文件', async () => {
  const f = await fixture({ prepare: async (cwd, root) => {
    await mkdir(join(root, 'outside/child'), { recursive: true });
    await writeFile(join(root, 'outside/notes.txt'), 'SHELL_PHYSICAL_OUTSIDE needle\n');
    await writeFile(join(cwd, 'notes.txt'), 'ordinary project needle\n');
    await symlink('../outside/child', join(cwd, 'link'));
  } });
  for (const command of ['cat link/../notes.txt', 'grep needle link/../notes.txt', 'find link/.. -name notes.txt']) {
    const result = await f.run([command]);
    expect(result, command).toMatchObject({ judge: 0, human: 1, executed: 0 });
    expect(result.results[0].content).not.toContain('SHELL_PHYSICAL_OUTSIDE');
  }
});

it.skipIf(process.platform === 'win32')('Git clean filter 即使 --no-ext-diff/--no-textconv 也必须保守审批且不能运行', async () => {
  const f = await fixture({ prepare: async (cwd, root) => {
    const marker = join(root, 'git-filter-ran');
    await writeFile(join(cwd, '.gitattributes'), 'README.md filter=pwn\n');
    execFileSync('git', ['config', 'filter.pwn.clean', `printf FILTER_EXECUTED > '${marker}'; cat`], {
      cwd, env: { PATH: process.env.PATH, HOME: join(root, 'home'), USERPROFILE: join(root, 'home') },
    });
  } });
  for (const command of ['git diff -- README.md', 'git status --short']) {
    const result = await f.run([command]);
    expect(result.executed, command).toBe(0); expect(result.human, command).toBe(1);
    expect(result.results[0].isError).toBe(true);
    await expect(readFile(join(f.root, 'git-filter-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it.skipIf(process.platform === 'win32')('反斜杠换行不能被误重写为两个参数，保持未解析审批', async () => {
  const f = await fixture();
  const command = ['echo a\\', 'b'].join('\n');
  const result = await f.run([command]);
  expect(result).toMatchObject({ judge: 1, human: 1, executed: 0 });
  expect(result.results[0].isError).toBe(true);
});

it.skipIf(process.platform === 'win32')('普通 git status 仅报告已跟踪敏感文件元数据，git diff 仍直接人工询问', async () => {
  const f = await fixture({ prepare: async (cwd, root) => {
    await writeFile(join(cwd, '.env'), 'SHELL_TRACKED_SECRET=fixture-original\n');
    await writeFile(join(cwd, 'AGENTS.md'), 'SHELL_TRACKED_AGENT_SENTINEL original\n');
    const env = { PATH: process.env.PATH, HOME: join(root, 'home'), USERPROFILE: join(root, 'home') };
    execFileSync('git', ['add', '.env', 'AGENTS.md'], { cwd, env });
    execFileSync('git', ['-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tracked metadata fixture'], { cwd, env });
    await writeFile(join(cwd, '.env'), 'SHELL_TRACKED_SECRET=fixture-changed\n');
    await writeFile(join(cwd, 'AGENTS.md'), 'SHELL_TRACKED_AGENT_SENTINEL changed\n');
  } });
  for (const command of ['git status', 'git status --short', 'git status --porcelain', 'git status --short -- .']) {
    const result = await f.run([command]);
    expect(result, command).toMatchObject({ judge: 0, human: 0, executed: 1 });
    expect(result.results[0].isError, result.results[0].content).not.toBe(true);
    expect(result.results[0].content).toContain('.env'); expect(result.results[0].content).toContain('AGENTS.md');
    expect(result.results[0].content).not.toMatch(/SHELL_TRACKED_SECRET|SHELL_TRACKED_AGENT_SENTINEL/);
  }
  for (const command of ['git diff -- .env', 'git diff -- AGENTS.md']) {
    const result = await f.run([command]);
    expect(result, command).toMatchObject({ judge: 0, human: 1, executed: 0 });
    expect(result.results[0].content).not.toMatch(/SHELL_TRACKED_SECRET|SHELL_TRACKED_AGENT_SENTINEL/);
  }
});
