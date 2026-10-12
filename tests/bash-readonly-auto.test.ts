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
import type { Message } from '../src/core/protocol/types.js';
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
    messages: Message[] = [],
  ) =>
    executor.invokeTool(
      'bash',
      { command },
      { signal: signal(), runId: 'synthetic', userRequest, messages },
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
  it.each([
    'ls -la src 2>/dev/null | head -50',
    'cd . && ls -la src',
    'ls -- src 2>/dev/null',
    'ls -- 2>/dev/null',
    'ls -R src 2>/dev/null | head -80',
    'cat src/*.ts | wc -l',
    "cd . && find src -name '*.ts' -type f | wc -l && cat src/*.ts | wc -l",
    'cd src && ls -Ra',
    'cd src && ls --recursive',
  ])('绑定单目录列举保留输出：%s', async (command) => {
    const { cwd } = await project(220);
    const state = chain(cwd);
    const result = await state.run(command);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(await reference(cwd, command));
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).not.toHaveBeenCalled();
  });
  it.each([
    'ls -d src 2>/dev/null',
    'ls -Rl src 2>/dev/null',
    'ls src . 2>/dev/null',
    'cd . && ls -la src 2>/dev/null | head -50',
  ])('不改写需要路径标签或递归的目录列举：%s', async (command) => {
    const { cwd } = await project();
    expect((await analyzeReadOnlyShell(command, cwd, [], signal())).complete).toBe(false);
  });
  it.each([
    "find src -type f -name '*.ts' -print0 | xargs -0 cat | wc -l",
    "find src -type f -name '*.ts' -print0 | xargs --null cat 2>/dev/null | wc -l",
    "echo count; find . -type f -name '*.ts' | wc -l; find . -type f -name '*.ts' -print0 | xargs -0 cat 2>/dev/null | wc -l",
    "cd src && find . -type f -name '*.ts' -print0 | xargs -0 cat | wc -l",
    'cat src/module-0000.ts 2>/dev/null',
  ])('绑定的 NUL find/xargs 与 stderr 丢弃保持输出：%s', async (command) => {
    const { cwd } = await project(220);
    for (const name of ['white space.ts', 'new\nline.ts', '-dash.ts', 'glob*.ts', "quote'file.ts"])
      await writeFile(join(cwd, 'src', name), 'one\ntwo\n');
    const state = chain(cwd);
    const result = await state.run(command);
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe(await reference(cwd, command));
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).not.toHaveBeenCalled();
  });
  it('NUL find/xargs 空输入与符号链接排除保持原语义', async () => {
    const { root, cwd } = await project(0);
    await writeFile(join(root, 'outside.ts'), 'SECRET\n');
    await symlink(join(root, 'outside.ts'), join(cwd, 'src', 'link.ts'));
    const command = "find src -type f -name '*.ts' -print0 | xargs -0 cat | wc -l";
    const state = chain(cwd);
    expect((await state.run(command)).content).toBe(await reference(cwd, command));
    expect(state.provider.requests).toHaveLength(0);
  });
  it('find -name 的 -print0 值不是输出动作，不能改变分隔符或误接 xargs -0', async () => {
    const { cwd } = await project(0);
    await writeFile(join(cwd, 'src', '-print0'), 'one\n');
    const find = "find src -type f -name '-print0'";
    const state = chain(cwd);
    expect((await state.run(find)).content).toBe(await reference(cwd, find));
    expect((await state.run(`wc -l $(${find})`)).content).toBe(
      await reference(cwd, `wc -l $(${find})`),
    );
    expect(state.provider.requests).toHaveLength(0);
    expect((await analyzeReadOnlyShell(`${find} | xargs -0 cat`, cwd, [], signal())).complete).toBe(
      false,
    );
  });
  it('NUL 内容候选中的硬链接和敏感文件仍不能由规则放行', async () => {
    const { root, cwd } = await project();
    await writeFile(join(root, 'outside.ts'), 'EXTERNAL');
    await link(join(root, 'outside.ts'), join(cwd, 'src', 'linked.ts'));
    const command = 'find src -type f -print0 | xargs -0 cat';
    expect((await analyzeReadOnlyShell(command, cwd, [], signal())).complete).toBe(false);
    await unlink(join(cwd, 'src', 'linked.ts'));
    await writeFile(join(cwd, 'src', '.env'), 'SECRET');
    const state = chain(cwd);
    expect((await state.run(command)).isError).toBe(true);
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).toHaveBeenCalledTimes(1);
  });
  it.each(["'xargs'", '"xargs"', 'xar"gs"', 'xar\\gs'])(
    '解码命令名 %s 时前序 cat 也必须绑定，替换 symlink 不越界',
    async (name) => {
      const { root, cwd } = await project();
      await writeFile(join(cwd, 'notes.txt'), 'APPROVED\n');
      await writeFile(join(root, 'outside.txt'), 'OUTSIDE_REPLACEMENT\n');
      const analysis = await analyzeReadOnlyShell(
        `cat notes.txt; find src -type f -print0 | ${name} -0 cat`,
        cwd,
        [],
        signal(),
      );
      expect(analysis.complete).toBe(true);
      expect(analysis.bindings!.some((binding) => binding.path === join(cwd, 'notes.txt'))).toBe(
        true,
      );
      const bound = await openShellBindings(analysis.bindings!, cwd);
      try {
        await unlink(join(cwd, 'notes.txt'));
        await symlink(join(root, 'outside.txt'), join(cwd, 'notes.txt'));
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            '/usr/bin/bash',
            ['--noprofile', '--norc', '-p', '-c', analysis.command!],
            {
              cwd: bound.cwd,
              env: { ...readOnlyShellEnvironment(), ...bound.env },
              stdio: bound.stdio,
            },
          );
          let stdout = '';
          child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
          child.once('error', reject);
          child.once('close', () => resolve(stdout));
        });
        expect(output).toContain('APPROVED');
        expect(output).not.toContain('OUTSIDE_REPLACEMENT');
      } finally {
        await bound.close();
      }
    },
  );
  it.each([false, true])('新候选在读取任何内容之前拒绝，末端 wc=%s 不隐藏诊断', async (tail) => {
    const { cwd } = await project();
    const command =
      "find src -type f -name '*.ts' -print0 | xargs -0 cat 2>/dev/null" + (tail ? ' | wc -l' : '');
    const analysis = await analyzeReadOnlyShell(command, cwd, [], signal());
    expect(analysis.complete).toBe(true);
    const bound = await openShellBindings(analysis.bindings!, cwd);
    try {
      await writeFile(join(cwd, 'src', 'new.ts'), 'UNAUTHORIZED');
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            '/usr/bin/bash',
            ['--noprofile', '--norc', '-p', '-c', analysis.command!],
            {
              cwd: bound.cwd,
              env: { ...readOnlyShellEnvironment(), ...bound.env },
              stdio: bound.stdio,
            },
          );
          let stdout = '',
            stderr = '';
          child.stdout!.on('data', (chunk) => (stdout += String(chunk)));
          child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stdout, stderr }));
        },
      );
      expect(result.code).toBe(tail ? 0 : 125);
      expect(result.stdout).toBe(tail ? '0\n' : '');
      expect(result.stderr).toContain('approval_stale');
    } finally {
      await bound.close();
    }
  });
  it('discard 描述符不接受普通文件替代 null 设备', async () => {
    const { cwd } = await project();
    const analysis = await analyzeReadOnlyShell(
      'cat src/module-0000.ts 2>/dev/null',
      cwd,
      [],
      signal(),
    );
    const file = analysis.bindings!.find((b) => b.kind === 'file')!;
    await expect(
      openShellBindings([analysis.bindings![0], { ...file, kind: 'discard' }], cwd),
    ).rejects.toThrow('approval_stale');
  });
  it.each([
    'find src -type f -print | xargs cat',
    'find src -type f -print0 | xargs -0 sh -c \'cat"$@"\' --',
    'find src -type f -print0 | xargs -0 -I{} cat {}',
    'find src -type f -print0 | xargs -0 -P2 cat',
    'find src -type f -print0 | xargs -0 cat -n',
    'find src -type f -exec cat {} + | wc -l',
    'wc -l $(find src -type f -print0)',
    'cat src/module-0000.ts 2>errors.txt',
    'cat src/module-0000.ts >/dev/null',
    'cat src/module-0000.ts 2>>/dev/null',
    'cat src/module-0000.ts 2>&1',
    'cat src/module-0000.ts 2>/dev/null >/dev/null',
  ])('不推广任意 xargs/重定向：%s', async (command) => {
    const { cwd } = await project();
    expect((await analyzeReadOnlyShell(command, cwd, [], signal())).complete).toBe(false);
  });
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
  it.each([
    lines,
    'ls -la src 2>/dev/null',
    'cd . && ls -la src',
    'ls -R src',
    'cat src/*.ts',
    "cat src/module-0000.ts && ls '-R' src",
    "cat src/module-0000.ts && ls -'R' src",
    'cat src/module-0000.ts && ls "--recursive" src',
  ])('绑定后换掉目录和文件不会读取替换的项目外内容：%s', async (command) => {
    const { root, cwd } = await project();
    const expected = await reference(cwd, command);
    const current = await analyzeReadOnlyShell(command, cwd, [], signal());
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
      // 重命名会改变目录自身的时间戳，ls -l 比较稳定的子文件行。
      if (command === lines) expect(output).toBe(expected);
      else {
        const fileLines = (text: string) =>
          text.split('\n').filter((line) => line.includes('module-'));
        expect(fileLines(output)).toEqual(fileLines(expected));
      }
    } finally {
      await bound.close();
    }
  });
});

describe.skipIf(process.platform !== 'linux')('紧凑审查证据和完整批准绑定', () => {
  it('find/xargs 的未支持 cat 选项，带规划历史仍保留证据并进入默认预算审批', async () => {
    const { cwd } = await project(220);
    const state = chain(cwd);
    const command =
      "echo '--- ts count ---'; find . -type f -name '*.ts' | wc -l; echo '--- total lines ---'; find . -type f -name '*.ts' -print0 | xargs -0 cat -n 2>/dev/null | wc -l";
    const messages: Message[] = Array.from({ length: 5 }, (_, index) => ({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: `plan-${index}`,
          content: JSON.stringify({
            step: index,
            evidence: '只读取项目文件，不修改，不联网。'.repeat(35),
          }),
        },
      ],
    }));
    const result = await state.run(command, '只浏览并统计项目，禁止修改或联网。', messages);
    expect(result.isError).toBe(true);
    expect(state.provider.requests).toHaveLength(1);
    expect(state.human).toHaveBeenCalledTimes(1);
    const request = state.provider.requests[0];
    expect(byteSize(request)).toBeLessThan(32768);
    const data = JSON.parse(request.messages[0].content as string);
    expect(data.operation.input.command).toBe(command);
    expect(data.context.conversation).toHaveLength(5);
    expect(data.analysis.completeness).toBe('unknown');
    expect(
      data.analysis.paths.filter((path: unknown) => JSON.stringify(path).includes('module-')),
    ).toHaveLength(220);
  });
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
      evidence.effects.map(([profile, target]: [number, number | null]) => ({
        kind: evidence.effectProfiles[profile][0],
        ...(target === null ? {} : { target: paths[target] }),
        ...(evidence.effectProfiles[profile][1] === null
          ? {}
          : { scope: evidence.effectProfiles[profile][1] }),
      })),
    ).toEqual(analysis.effects);
    expect(evidence.targets.map((index: number) => paths[index])).toEqual(analysis.targets);
    expect(evidence.evidence).toEqual(
      analysis.evidence?.filter(({ source }) => source !== 'shell-path-boundaries'),
    );
    expect(
      evidence.pathFacts.map(([raw, actual, profile]: [number, number, number]) => ({
        raw: paths[raw],
        actual: paths[actual],
        exists: evidence.pathFactProfiles[profile][0],
        kind: evidence.pathFactProfiles[profile][1],
        symlink: evidence.pathFactProfiles[profile][2],
        nlink: evidence.pathFactProfiles[profile][3],
      })),
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
      pathFacts: Array<[number, number, number]>;
      pathFactProfiles: Array<[boolean, string, boolean, number]>;
    };
    expect(evidence.paths).toContain(outside);
    expect(
      evidence.pathFacts.some(
        ([raw, actual, profile]) =>
          evidence.paths[raw].endsWith('/external-link') &&
          evidence.paths[actual] === outside &&
          evidence.pathFactProfiles[profile][2],
      ),
    ).toBe(true);
  });
});

describe.skipIf(process.platform !== 'linux')('递归列举与末级 glob 绑定边界', () => {
  it.each([
    'ls -R src',
    'ls -Ra src/',
    'ls --recursive -A src',
    'ls -R src 2>/dev/null | head -80',
    'ls -RaA src',
    'ls -RAa src',
    'ls -R --all --almost-all src',
    'ls -R --almost-all --all src',
  ])('递归输出逐字等同 Bash：%s', async (command) => {
    const { root, cwd } = await project(2);
    for (const name of [
      '-dash',
      'white space',
      'new\nline',
      "quote'file",
      '字节',
      '.hidden',
      'glob*name',
    ]) {
      await mkdir(join(cwd, 'src', name, 'nested'), { recursive: true });
      await writeFile(join(cwd, 'src', name, 'nested', 'file.ts'), 'ok\n');
    }
    await mkdir(join(root, 'external'));
    await writeFile(join(root, 'external', 'SECRET'), 'outside');
    await symlink(join(root, 'external'), join(cwd, 'src', 'link-out'));
    const state = chain(cwd);
    const actual = await state.run(command);
    expect(actual.isError).toBeFalsy();
    expect(actual.content).toBe(await reference(cwd, command));
    expect(actual.content).not.toContain('SECRET');
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).not.toHaveBeenCalled();
  });
  it.each([
    'cat src/*.ts',
    'cat -n src/*.ts',
    'cat src/*.ts src/module-0000.ts | wc -l',
    'cd src && cat -- *.ts',
  ])('glob 保留排序、特殊文件名和多操作数：%s', async (command) => {
    const { cwd } = await project(2);
    for (const [i, name] of [
      'white space.ts',
      'new\nline.ts',
      '-dash.ts',
      'glob*.ts',
      "quote'file.ts",
      '大小.ts',
      'UPPER.TS',
      '.hidden.ts',
    ].entries())
      await writeFile(join(cwd, 'src', name), `${i}\n`);
    const state = chain(cwd);
    const actual = await state.run(command);
    expect(actual.isError).toBeFalsy();
    expect(actual.content).toBe(await reference(cwd, command));
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).not.toHaveBeenCalled();
  });
  it.each([
    'cat src/*.missing',
    'cat src/**/*.ts',
    'cat src/?.ts',
    'cat src/[a-z]*.ts',
    'cat src/.*',
    'ls -RL src',
    'ls -R src .',
    'ls -R -l src',
    "ls -R ''",
    "cd . && ls ''",
  ])('不猜测空 glob、扩展匹配或其他递归选项：%s', async (command) => {
    const { cwd } = await project();
    expect((await analyzeReadOnlyShell(command, cwd, [], signal())).complete).toBe(false);
  });
  it('glob 没有 -- 的选项注入、目录匹配、symlink 和硬链接不确定性放行', async () => {
    const { root, cwd } = await project(0);
    await writeFile(join(cwd, 'src', '-n.ts'), 'ordinary');
    expect((await analyzeReadOnlyShell('cd src && cat *.ts', cwd, [], signal())).complete).toBe(
      false,
    );
    await unlink(join(cwd, 'src', '-n.ts'));
    await writeFile(join(root, 'outside.ts'), 'SECRET');
    await symlink(join(root, 'outside.ts'), join(cwd, 'src', 'file.ts'));
    expect((await analyzeReadOnlyShell('cat src/*.ts', cwd, [], signal())).complete).toBe(false);
    await unlink(join(cwd, 'src', 'file.ts'));
    await link(join(root, 'outside.ts'), join(cwd, 'src', 'file.ts'));
    expect((await analyzeReadOnlyShell('cat src/*.ts', cwd, [], signal())).complete).toBe(false);
    await unlink(join(cwd, 'src', 'file.ts'));
    await mkdir(join(cwd, 'src', 'dir.ts'));
    expect((await analyzeReadOnlyShell('cat src/*.ts', cwd, [], signal())).complete).toBe(false);
  });
  it.each(['cat src/*.ts', 'ls -R src'])('敏感候选不从审查集合偷偷过滤：%s', async (command) => {
    const { cwd } = await project();
    if (command.startsWith('cat')) await writeFile(join(cwd, 'src', 'credentials.ts'), 'SENSITIVE');
    else await mkdir(join(cwd, 'src', 'secrets'));
    const state = chain(cwd);
    expect((await state.run(command)).isError).toBe(true);
    expect(state.provider.requests).toHaveLength(0);
    expect(state.human).toHaveBeenCalledTimes(1);
  });
  it('glob 候选在分析后新增时执行重新分析拒绝旧授权', async () => {
    const { cwd } = await project();
    const state = chain(cwd);
    const command = 'cat src/*.ts';
    const analysis = await state.policy.analyzer!.analyze(
      { tool: bash, input: { command }, cwd },
      signal(),
    );
    await writeFile(join(cwd, 'src', 'new.ts'), 'NEW');
    await expect(
      bashTool.execute({ command }, { cwd, signal: signal(), analysis }),
    ).rejects.toThrow('approval_stale');
  });
  it('递归目录和 glob 内容都受 FD 上限约束', async () => {
    const { cwd } = await project(770);
    expect((await analyzeReadOnlyShell('cat src/*.ts', cwd, [], signal())).reasonCode).toBe(
      'shell_descriptor_limit',
    );
    for (let i = 0; i < 770; i++) await mkdir(join(cwd, 'src', `dir-${i}`));
    expect((await analyzeReadOnlyShell('ls -R src', cwd, [], signal())).reasonCode).toBe(
      'shell_descriptor_limit',
    );
  });
});

it.skipIf(process.platform !== 'linux')(
  '-- 后的 -R/--recursive 是目录操作数，不触发递归改写',
  async () => {
    const { cwd } = await project();
    for (const name of ['-R', '--recursive']) {
      await mkdir(join(cwd, name, 'nested'), { recursive: true });
      const command = `cd . && ls -- ${name}`;
      const state = chain(cwd);
      expect((await state.run(command)).content).toBe(await reference(cwd, command));
      expect(state.provider.requests).toHaveLength(0);
      expect(state.human).not.toHaveBeenCalled();
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  '获授权后的 glob 新增匹配失败关闭，所有候选验证前不读取内容',
  async () => {
    const { cwd } = await project(1);
    const current = await analyzeReadOnlyShell('cat src/*.ts', cwd, [], signal());
    expect(current.complete).toBe(true);
    const bound = await openShellBindings(current.bindings!, cwd);
    try {
      await writeFile(join(cwd, 'src', 'new.ts'), 'UNAPPROVED\n');
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
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
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stdout, stderr }));
        },
      );
      expect(result.code).toBe(125);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('approval_stale: glob selection changed');
    } finally {
      await bound.close();
    }
  },
);
