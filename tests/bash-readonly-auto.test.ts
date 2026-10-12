/** 常用组合读取的真实 analyzer → policy → reviewer → executor，以及绑定/预算反例。 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/model.js';
import { shellReviewEvidence } from '../src/builtin/reviewer-model/shell-evidence.js';
import { EventBus, type AgentEvent } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import { bashTool } from '../src/tools/bash.js';
import { openShellBindings } from '../src/tools/shell-bound.js';
import { analyzeReadOnlyShell, readOnlyShellEnvironment } from '../src/tools/shell-readonly.js';

const temporary: string[] = [];
const bash = { ...bashTool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' };
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const signal = () => new AbortController().signal;
const original = (cwd: string) =>
  `cd ${cwd} && ls -la && echo "---" && find src -type f -name '*.ts' | head -100 && echo "---" && wc -l $(find src -type f -name '*.ts') | tail -5`;
const lines = "wc -l $(find src -type f -name '*.ts')";
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
async function project(count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'bash-auto-'));
  temporary.push(root);
  const cwd = join(root, 'project');
  await mkdir(join(cwd, 'src'), { recursive: true });
  for (let i = 0; i < count; i++)
    await writeFile(
      join(cwd, 'src', `module-${String(i).padStart(4, '0')}.ts`),
      'export const value = 1;\n',
    );
  return { root, cwd };
}
function chain(
  cwd: string,
  rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
) {
  const policy = createDeterministicPolicy({ cwd, mode: 'auto', rules });
  const tools = new ToolRegistry();
  tools.register(bash);
  const provider = new FakeProvider([
    textResponse('{"decision":"ask","reasonCode":"controlled_ask","reason":"受控审批要求询问"}'),
  ]);
  const reviewer = createModelReviewer({ provider, model: 'controlled' });
  const events = new EventBus();
  const observed: AgentEvent[] = [];
  events.onAll((event) => observed.push(event));
  const human = vi.fn(async () => ({ allow: false as const }));
  const executor = new ToolExecutor({
    cwd,
    tools,
    policy,
    reviewer,
    events,
    hooks: new HookRunner(),
    approvalResponder: human,
  });
  const run = (
    command: string,
    userRequest = '查看项目普通 TypeScript 文件和行数；不读取凭据，不修改文件。',
  ) =>
    executor.invokeTool(
      'bash',
      { command },
      { signal: signal(), runId: 'synthetic', userRequest, messages: [] },
    );
  return { policy, provider, reviewer, human, observed, run };
}
async function reference(cwd: string, command: string) {
  const { stdout, stderr } = await promisify(execFile)(
    '/usr/bin/bash',
    ['--noprofile', '--norc', '-p', '-c', command],
    { cwd, env: readOnlyShellEnvironment() },
  );
  expect(stderr).toBe('');
  return stdout || '(no output)';
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('Bash 普通读取与受约束替换', () => {
  it.each([220, 300])('原命令同形，%i 个 TS 文件实际输出一致，零人工零模型', async (count) => {
    const { cwd } = await project(count);
    const state = chain(cwd);
    const command = original(cwd);
    const expected = await reference(cwd, command);
    const result = await state.run(command);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(expected);
    expect(result.content).toContain(`${count} total`);
    expect(state.human).not.toHaveBeenCalled();
    expect(state.provider.requests).toHaveLength(0);
    expect(
      state.observed.filter((event) => event.type === 'tool_execution' && event.phase === 'policy'),
    ).toMatchObject([{ reasonCode: 'safe_read', decision: 'allow' }]);
  });
  it.each(['-dash.ts', "quote'.ts", 'dollar$.ts', '日本語.ts'])(
    '保留安全文件名 %s 和 wc 输出标签',
    async (name) => {
      const { cwd } = await project();
      await writeFile(join(cwd, 'src', name), 'one\ntwo\n');
      const state = chain(cwd);
      const result = await state.run(lines);
      expect(result.content).toBe(await reference(cwd, lines));
      expect(result.isError).toBeFalsy();
      expect(state.human).not.toHaveBeenCalled();
      expect(state.provider.requests).toHaveLength(0);
    },
  );
  it.each([
    'white space.ts',
    'line\nbreak.ts',
    'tab\tfile.ts',
    'glob*.ts',
    'glob?.ts',
    'glob[ab].ts',
    'a --files0-from=.env.ts',
  ])('拆分/通配/选项注入候选 %j 不冒充 complete', async (name) => {
    const { cwd } = await project();
    await writeFile(join(cwd, 'src', name), 'fixture');
    const state = chain(cwd);
    const operation = { tool: bash, input: { command: lines }, cwd };
    const analysis = await state.policy.analyzer!.analyze(operation, signal());
    expect(analysis.completeness).toBe('unknown');
    expect(analysis.evidence?.[0].detail).toContain('shell_substitution_word_expansion');
    expect((await state.policy.decide({ ...operation, analysis }, signal())).kind).not.toBe(
      'allow',
    );
  });
  it('find 的过滤保留：未匹配的敏感文件不成为 wc 内容目标', async () => {
    const { cwd } = await project();
    await writeFile(join(cwd, 'src', '.env'), 'SYNTHETIC_SECRET');
    await writeFile(join(cwd, 'src', 'ignored weird\nname.txt'), 'SYNTHETIC_SECRET');
    const state = chain(cwd);
    const result = await state.run(lines);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(await reference(cwd, lines));
    expect(state.human).not.toHaveBeenCalled();
    expect(state.provider.requests).toHaveLength(0);
  });
  it('find -P 排除途中链接；外部文件与外部子目录不成为读取目标', async () => {
    const { root, cwd } = await project();
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', 'external.ts'), 'EXTERNAL_SENTINEL\n');
    await symlink(join(root, 'outside', 'external.ts'), join(cwd, 'src', 'link.ts'));
    await symlink(join(root, 'outside'), join(cwd, 'src', 'external'));
    const state = chain(cwd);
    const result = await state.run(lines);
    expect(result.content).toBe(await reference(cwd, lines));
    expect(result.content).not.toContain('EXTERNAL_SENTINEL');
    expect(state.human).not.toHaveBeenCalled();
    expect(state.provider.requests).toHaveLength(0);
  });
  it('硬链接及敏感 TS 目标仍询问，拒绝时不读取', async () => {
    const { root, cwd } = await project();
    await link(join(cwd, 'src', 'module-0000.ts'), join(root, 'alias.ts'));
    const state = chain(cwd);
    const result = await state.run(lines);
    expect(result.isError).toBe(true);
    expect(state.human).toHaveBeenCalledTimes(1);
    expect(state.provider.requests).toHaveLength(0);
    await unlink(join(root, 'alias.ts'));
    await writeFile(join(cwd, 'src', '.env.ts'), 'SYNTHETIC_SECRET');
    const sensitive = chain(cwd);
    expect((await sensitive.run(lines)).isError).toBe(true);
    expect(sensitive.human).toHaveBeenCalledTimes(1);
    expect(sensitive.provider.requests).toHaveLength(0);
  });
  it.each([
    'wc -l $(printf "%s" src/module-0000.ts)',
    'wc -l "$(find src -type f -name \'*.ts\')"',
    'wc -l prefix$(find src -type f)',
    'wc -l $(find src -type f | head -1)',
    'wc -l $(find src -type f -delete)',
    "wc -l $(find src -type f -exec sh -c 'echo bad > marker' ';')",
    "wc -l $(find src -type f -name '?.ts')",
    'wc -l $(find -L src -type f)',
    'IFS=/ wc -l $(find src -type f)',
    'wc --files0-from=src/list',
    'cd src; cat module-0000.ts',
    "'c'd src; cat module-0000.ts",
    'cd src || cat module-0000.ts',
    'cd src | cat module-0000.ts',
    'cd src && head -v module-0000.ts',
    'cd src && head module-0000.ts module-0000.ts',
    'cd src && wc -l module-0000.ts ./module-0000.ts',
    'cd src && grep value module-0000.ts',
    'cd src && rg value',
    'cd src && git status',
    'cd src && ls -Ra',
    'cd src && ls --recursive',
    'cd - && pwd',
    "wc -l $(find src/// -type f -name '*.ts')",
    "wc -l $(find src ./src -type f -name '*.ts')",
    "wc -l $(find '!' -type f)",
  ])('未证明的语义 %s 不确定性放行，分析不执行子命令', async (command) => {
    const { cwd } = await project();
    const state = chain(cwd);
    const analysis = await state.policy.analyzer!.analyze(
      { tool: bash, input: { command }, cwd },
      signal(),
    );
    expect(analysis.completeness).toBe('unknown');
    expect(existsSync(join(cwd, 'marker'))).toBe(false);
    expect(existsSync(join(cwd, 'src', 'module-0000.ts'))).toBe(true);
  });
  it('固定运行环境不执行 BASH_ENV、不继承 IFS、函数、加载器或项目 PATH 的 find', async () => {
    const { cwd } = await project();
    const startup = join(cwd, 'startup.sh');
    await writeFile(startup, `echo UNAUTHORIZED > ${quote(join(cwd, 'marker'))}\n`);
    vi.stubEnv('BASH_ENV', startup);
    vi.stubEnv('IFS', '/');
    vi.stubEnv('BASH_FUNC_wc%%', '() { echo injected; }');
    vi.stubEnv('LD_PRELOAD', join(cwd, 'not-a-library'));
    vi.stubEnv('PATH', `${cwd}:${process.env.PATH}`);
    const state = chain(cwd);
    const result = await state.run(original(cwd));
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(await reference(cwd, original(cwd)));
    expect(existsSync(join(cwd, 'marker'))).toBe(false);
    expect(state.human).not.toHaveBeenCalled();
  });
  it('wc 已有 -- 不产生第二个未授权文件操作数', async () => {
    const { root, cwd } = await project();
    await writeFile(join(root, '.env'), 'EXTERNAL\n'.repeat(99));
    await symlink(join(root, '.env'), join(cwd, '--'));
    const state = chain(cwd);
    const command = "wc -l -- $(find src -type f -name '*.ts')";
    const result = await state.run(command);
    expect(result.content).toBe(await reference(cwd, command));
    expect(result.content).not.toContain('99');
    expect(state.human).not.toHaveBeenCalled();
    expect(state.provider.requests).toHaveLength(0);
  });
  it('find -name 的值 -print 保留为匹配模式', async () => {
    const { cwd } = await project();
    await writeFile(join(cwd, 'src', '-print'), 'one\ntwo\n');
    const state = chain(cwd);
    const command = "wc -l $(find src -type f -name '-print')";
    expect((await state.run(command)).content).toBe(await reference(cwd, command));
    expect(state.human).not.toHaveBeenCalled();
    expect(state.provider.requests).toHaveLength(0);
  });
  it('明确 ask/deny 不被规则只读放行覆盖', async () => {
    const { cwd } = await project();
    const asked = chain(cwd, { allow: [], ask: ['bash'], deny: [] });
    expect((await asked.run(lines)).isError).toBe(true);
    expect(asked.human).toHaveBeenCalledTimes(1);
    expect(asked.provider.requests).toHaveLength(0);
    const denied = chain(cwd, { allow: [], ask: [], deny: ['bash'] });
    expect((await denied.run(lines)).isError).toBe(true);
    expect(denied.human).not.toHaveBeenCalled();
    expect(denied.provider.requests).toHaveLength(0);
  });
  it('切换到项目内子目录的 && 路径传播与 pwd 保持原语义', async () => {
    const { cwd } = await project();
    const command = "cd src && pwd && wc -l $(find . -type f -name '*.ts')";
    const state = chain(cwd);
    const result = await state.run(command);
    expect(result.content).toBe(await reference(cwd, command));
    expect(state.human).not.toHaveBeenCalled();
  });
  it.each([
    'cat module-0000.ts | head -1',
    'cat module-0000.ts module-0001.ts',
    'head -1 module-0000.ts',
    'tail -1 module-0000.ts',
    'head -1 -q module-0000.ts module-0001.ts',
    'tail -n 1 -q module-0000.ts module-0001.ts',
    'wc -l module-0000.ts module-0001.ts',
    'wc module-0000.ts -l module-0001.ts',
    'wc -l -- module-0000.ts',
    "wc -l -- 'white space.ts' '-file.ts'",
    "cat -- '-file.ts'",
  ])('目录传播后的通用读取 %s 输出一致、零模型零人工', async (read) => {
    const { cwd } = await project(2);
    await writeFile(join(cwd, 'src', 'white space.ts'), 'one\ntwo\n');
    await writeFile(join(cwd, 'src', '-file.ts'), 'one\n');
    const command = `cd src && ${read}`;
    const state = chain(cwd);
    const result = await state.run(command);
    expect(result.content).toBe(await reference(cwd, command));
    expect(result.isError).toBeFalsy();
    expect(state.human).not.toHaveBeenCalled();
    expect(state.provider.requests).toHaveLength(0);
  });
  it('绑定后换掉目录和文件不会读取替换的项目外内容', async () => {
    const { root, cwd } = await project();
    const current = await analyzeReadOnlyShell(lines, cwd, [], signal());
    expect(current.complete).toBe(true);
    const bound = await openShellBindings(current.bindings!, cwd);
    try {
      await mkdir(join(root, 'outside'));
      await writeFile(join(root, 'outside', 'module-0000.ts'), 'EXTERNAL\n'.repeat(99));
      await rename(join(cwd, 'src'), join(cwd, 'original-src'));
      await symlink(join(root, 'outside'), join(cwd, 'src'));
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          '/usr/bin/bash',
          ['--noprofile', '--norc', '-p', '-c', current.command!],
          {
            cwd: bound.cwd,
            env: { ...readOnlyShellEnvironment(), ...bound.env },
            stdio: bound.stdio,
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.stderr!.on('data', (chunk) => {
          stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
      });
      expect(output).toContain('1 src/module-0000.ts');
      expect(output).not.toContain('99');
    } finally {
      await bound.close();
    }
  });
});

describe.skipIf(process.platform !== 'linux')('紧凑审查证据和完整批准绑定', () => {
  it('200+ 文件的不完整请求仍经过真实模型 reviewer，全部路径/效果/限制保留且低于32KiB', async () => {
    const { cwd } = await project(220);
    await writeFile(join(cwd, 'src', 'unsafe space.ts'), 'fixture');
    const command = original(cwd);
    const state = chain(cwd);
    const input = { command };
    const analysis = await state.policy.analyzer!.analyze({ tool: bash, input, cwd }, signal());
    expect(byteSize(analysis)).toBeGreaterThan(82_000);
    const userRequest =
      '查看 TypeScript 行数。尾部限制：不要修改、不要读取凭据，也不要读取项目外文件。';
    const analyzed = vi.spyOn(state.policy.analyzer!, 'analyze');
    const result = await state.run(command, userRequest);
    expect(result.isError).toBe(true);
    expect(state.human).toHaveBeenCalledTimes(1);
    expect(state.provider.requests).toHaveLength(1);
    const request = state.provider.requests[0];
    expect(byteSize(request)).toBeLessThan(32768);
    const data = JSON.parse(request.messages[0].content as string);
    expect(data.operation.input).toEqual(input);
    expect(data.currentUserRequest).toEqual({ source: 'runtime_user_request', text: userRequest });
    const evidence = data.analysis;
    const paths = evidence.paths.map((path: string | [number, string]) =>
      typeof path === 'string' ? path : evidence.pathPrefixes[path[0]] + path[1],
    );
    expect(evidence.encoding).toBe('shell_path_index');
    expect(evidence.completeness).toBe('unknown');
    expect(
      evidence.effects.map(([kind, target, scope]: [string, number | null, string | null]) => ({
        kind,
        ...(target === null ? {} : { target: paths[target] }),
        ...(scope === null ? {} : { scope }),
      })),
    ).toEqual(analysis.effects);
    expect(evidence.targets.map((index: number) => paths[index])).toEqual(analysis.targets);
    expect(evidence.evidence).toEqual(
      analysis.evidence?.filter(({ source }) => source !== 'shell-path-boundaries'),
    );
    expect(
      evidence.pathFacts.map(
        ([raw, actual, exists, kind, symlink, nlink]: [
          number,
          number,
          boolean,
          string,
          boolean,
          number,
        ]) => ({
          raw: paths[raw],
          actual: paths[actual],
          exists,
          kind,
          symlink,
          nlink,
        }),
      ),
    ).toEqual(
      JSON.parse(
        analysis.evidence!.find(({ source }) => source === 'shell-path-boundaries')!.detail,
      ),
    );
    const boundAnalysis = await analyzed.mock.results[0].value;
    expect(evidence.environment.sha256).toBe(
      createHash('sha256').update(JSON.stringify(boundAnalysis.environment)).digest('hex'),
    );
    expect(JSON.stringify(evidence)).not.toContain('mtimeNs');
    expect(
      state.observed.filter(
        (event) => event.type === 'tool_execution' && event.phase === 'reviewer',
      ),
    ).toMatchObject([{ decision: 'ask', reasonCode: 'controlled_ask' }]);
  });
  it('证据过大时不省略路径或尾部限制，维持原32KiB硬预算并拒绝发送', async () => {
    const { cwd } = await project(220);
    const command = `ls -la && ${lines} && echo $UNVERIFIED`;
    const state = chain(cwd);
    const userRequest = '只查看。'.repeat(1300) + '禁止网络或读取凭据';
    const result = await state.run(command, userRequest);
    expect(result.isError).toBe(true);
    expect(
      state.observed.some(
        (event) =>
          event.type === 'permission_decision' && event.decision.reasonCode === 'request_budget',
      ),
    ).toBe(true);
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).toHaveBeenCalledTimes(1);
    const analysis = await state.policy.analyzer!.analyze(
      { tool: bash, input: { command }, cwd },
      signal(),
    );
    const evidence = shellReviewEvidence(analysis) as { paths: string[]; targets: number[] };
    expect(evidence.targets.map((index) => evidence.paths[index])).toEqual(analysis.targets);
  });
  it('未读取的 symlink 也保留 raw→canonical 路径与链接事实', async () => {
    const { root, cwd } = await project();
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(cwd, 'src', 'external-link'));
    const analysis = await chain(cwd).policy.analyzer!.analyze(
      { tool: bash, input: { command: "find src -type f -name '*.ts' && echo $(pwd)" }, cwd },
      signal(),
    );
    const evidence = shellReviewEvidence(analysis) as {
      paths: string[];
      pathFacts: Array<[number, number, boolean, string, boolean, number]>;
    };
    expect(evidence.paths).toContain(outside);
    expect(
      evidence.pathFacts.some(
        ([raw, actual, , , symlink]) =>
          evidence.paths[raw].endsWith('/external-link') &&
          evidence.paths[actual] === outside &&
          symlink,
      ),
    ).toBe(true);
  });
});
