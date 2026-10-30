import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { DesktopController } from '../desktop/worker/controller.js';
import { gitEnvironment, resolveGitExecutable } from '../desktop/worker/git-executable.js';
import { createAgent, type Agent } from '../src/index.js';
import { definePlugin, type TypedHookHandler } from '../src/sdk/index.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('../desktop/worker/git-executable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../desktop/worker/git-executable.js')>()),
  resolveGitExecutable: vi.fn(),
}));

const folders: string[] = [];
const controllers: DesktopController[] = [];
beforeEach(() => {
  vi.mocked(resolveGitExecutable).mockResolvedValue('/trusted/git');
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _options: unknown,
    done: (error: null, out: string) => void,
  ) => {
    done(null, 'authorized diff output');
    return {} as never;
  }) as unknown as typeof execFile);
});
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()));
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture(
  options: {
    demo?: boolean;
    approveGit?: boolean;
    deny?: string[];
    ask?: string[];
    pre?: TypedHookHandler<'PreToolUse'>;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'desktop-inspection-'));
  folders.push(cwd);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/safe.ts'), 'const safe = true;\n');
  await writeFile(join(cwd, '.env'), 'SECRET=do-not-read\n');
  const pre: string[] = [],
    post: string[] = [],
    models: unknown[] = [];
  let agent!: Agent;
  const controller = new DesktopController(
    () => {},
    async (path, input) => {
      agent = await createAgent(path, {
        ...input,
        config: {
          ...input?.config,
          provider: 'fake',
          model: 'inspection-test',
          pluginEntries: [],
          mcpConfig: '.inspection-no-mcp.json',
          capabilities: { reviewer: false },
          pluginConfig: { 'agentlab.planning': { mode: 'off' } },
          permissions: {
            allow: [],
            deny: options.deny ?? [],
            ask: options.ask ?? [],
          },
        },
        plugins: [
          ...(input?.plugins ?? []),
          definePlugin({
            manifest: { id: 'test.inspection-hooks', version: '1.0.0', apiVersion: 1 },
            setup(ctx) {
              ctx.hooks.register('PreToolUse', (payload) => {
                pre.push(payload.toolName);
                return options.pre?.(payload);
              });
              ctx.hooks.register('PostToolUse', ({ toolName }) => {
                post.push(toolName);
              });
            },
          }),
        ],
      });
      agent.events.on('model_request', (event) => models.push(event));
      return agent;
    },
  );
  controllers.push(controller);
  await controller.initialize(cwd, options.demo ?? false, randomUUID());
  const latest = () => controller.snapshot!;
  const send = (action: Record<string, unknown>) =>
    controller.handle({
      ...action,
      generation: latest().generation,
      sessionId: latest().sessionId,
    });
  const settled = () => vi.waitFor(() => expect(latest().busy).toBe(false));
  const inspect = async (kind: 'files' | 'read' | 'diff', path = 'src/safe.ts') => {
    await send({ type: 'inspect', kind, ...(kind === 'read' ? { path } : {}) });
    // Git 插件的副作用未被确定性分析器验证；测试显式批准外层，继续检查子工具边界。
    if (kind === 'diff' && options.approveGit !== false) {
      await vi.waitFor(() => expect(latest().approvals.length > 0 || !latest().busy).toBe(true));
      const approval = latest().approvals[0];
      if (approval?.toolName === 'desktop_git_diff')
        await send({ type: 'approve', approvalId: approval.id, allow: true });
    }
  };
  return { cwd, agent, latest, send, settled, inspect, pre, post, models };
}

describe('桌面检查的唯一执行器边界', () => {
  it.each([false, true])(
    '真实/演示装配（demo=%s）均注册 Git 工具；允许的检查经过钩子且不请求模型',
    async (demo) => {
      const f = await fixture({ demo });
      expect(f.latest().tools.some(({ name }) => name === 'desktop_git_diff')).toBe(true);
      await f.inspect('files');
      await f.settled();
      expect(f.latest().inspection).toMatchObject({ kind: 'files', content: 'src/safe.ts' });
      await f.inspect('read');
      await f.settled();
      expect(f.latest().inspection.content).toContain('1\tconst safe = true;');
      await f.inspect('diff');
      await f.settled();
      expect(f.latest().inspection).toMatchObject({ content: 'authorized diff output' });
      expect(f.pre).toEqual(['glob', 'read_file', 'desktop_git_diff', 'glob', 'read_file']);
      expect(f.post).toEqual(['glob', 'read_file', 'glob', 'read_file', 'desktop_git_diff']);
      expect(f.models).toEqual([]);
    },
  );

  it.each([
    { kind: 'files', rule: 'glob' },
    { kind: 'read', rule: 'read_file(src/safe.ts)' },
    { kind: 'diff', rule: 'desktop_git_diff' },
    { kind: 'diff', rule: 'glob' },
    { kind: 'diff', rule: 'read_file(src/safe.ts)' },
  ] as const)('$kind 遵守 $rule 的 deny，拒绝后不读取内容或执行 Git', async ({ kind, rule }) => {
    const f = await fixture({ deny: [rule] });
    await f.inspect(kind);
    await f.settled();
    expect(f.latest().inspection.error).toBe(true);
    expect(f.latest().inspection.content).toContain('Permission denied');
    expect(f.latest().inspection.content).not.toContain('const safe');
    expect(execFile).not.toHaveBeenCalled();
    expect(f.post).not.toContain('read_file');
    expect(f.latest().approvals).toHaveLength(0);
  });

  it.each([
    { kind: 'files', rule: 'glob', tool: 'glob' },
    { kind: 'read', rule: 'read_file(src/safe.ts)', tool: 'read_file' },
    { kind: 'diff', rule: 'desktop_git_diff', tool: 'desktop_git_diff' },
    { kind: 'diff', rule: 'glob', tool: 'glob' },
    { kind: 'diff', rule: 'read_file(src/safe.ts)', tool: 'read_file' },
  ] as const)('$kind 的 $rule ask 等待人工批准，批准后才执行', async ({ kind, rule, tool }) => {
    const f = await fixture({ ask: [rule], approveGit: tool !== 'desktop_git_diff' });
    await f.inspect(kind);
    await vi.waitFor(() => expect(f.latest().approvals).toHaveLength(1));
    expect(f.latest().busy).toBe(true);
    expect(f.latest().approvals[0].toolName).toBe(tool);
    expect(f.post).not.toContain(tool);
    expect(execFile).not.toHaveBeenCalled();
    await f.send({ type: 'approve', approvalId: f.latest().approvals[0].id, allow: true });
    await f.settled();
    expect(f.latest().inspection.error).toBeUndefined();
    expect(f.post).toContain(tool);
    expect(execFile).toHaveBeenCalledTimes(kind === 'diff' ? 1 : 0);
    expect(f.models).toEqual([]);
  });

  it('Git 必须审批注册工具，不能凭 read 风险声明放行', async () => {
    const f = await fixture({ approveGit: false });
    await f.inspect('diff');
    await vi.waitFor(() => expect(f.latest().approvals).toHaveLength(1));
    expect(f.latest().approvals[0].toolName).toBe('desktop_git_diff');
    expect(execFile).not.toHaveBeenCalled();
    await f.send({ type: 'approve', approvalId: f.latest().approvals[0].id, allow: false });
    await f.settled();
    expect(f.latest().inspection.error).toBe(true);
    expect(f.pre).toEqual(['desktop_git_diff']);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('逐文件人工拒绝中止整个 Git 检查，不继续读取或运行 Git', async () => {
    const f = await fixture({ ask: ['read_file'] });
    await writeFile(join(f.cwd, 'src/another.ts'), 'another file');
    await f.inspect('diff');
    await vi.waitFor(() => expect(f.latest().approvals).toHaveLength(1));
    await f.send({ type: 'approve', approvalId: f.latest().approvals[0].id, allow: false });
    await f.settled();
    expect(f.latest().inspection.content).toContain('User denied');
    expect(f.pre.filter((name) => name === 'read_file')).toHaveLength(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('停止撤销嵌套审批，迟到批准不能运行 Git；新检查使用新的授权', async () => {
    const f = await fixture({ ask: ['read_file'] });
    await f.inspect('diff');
    await vi.waitFor(() => expect(f.latest().approvals).toHaveLength(1));
    const id = f.latest().approvals[0].id;
    await f.send({ type: 'stop' });
    await f.settled();
    expect(f.latest().approvals).toHaveLength(0);
    await expect(f.send({ type: 'approve', approvalId: id, allow: true })).rejects.toThrow(
      '审批已结束',
    );
    expect(execFile).not.toHaveBeenCalled();
    await f.inspect('diff');
    await vi.waitFor(() => expect(f.latest().approvals).toHaveLength(1));
    expect(f.latest().approvals[0].id).not.toBe(id);
    await f.send({ type: 'approve', approvalId: f.latest().approvals[0].id, allow: true });
    await f.settled();
    expect(f.latest().inspection.content).toBe('authorized diff output');
  });

  it.each([
    { kind: 'files', tool: 'glob' },
    { kind: 'read', tool: 'read_file' },
    { kind: 'diff', tool: 'desktop_git_diff' },
    { kind: 'diff', tool: 'glob' },
    { kind: 'diff', tool: 'read_file' },
  ] as const)('$kind 遵守 $tool 的 PreToolUse 否决', async ({ kind, tool }) => {
    const f = await fixture({
      pre: ({ toolName }) => (toolName === tool ? { veto: 'inspection blocked' } : undefined),
    });
    await f.inspect(kind);
    await f.settled();
    expect(f.latest().inspection).toMatchObject({ error: true });
    expect(f.latest().inspection.content).toContain('Vetoed by PreToolUse');
    expect(f.post).not.toContain(tool);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('Git 仅接收已授权普通路径，禁用外部 diff/textconv/fsmonitor 并过滤 Git 环境', async () => {
    const f = await fixture();
    vi.stubEnv('GIT_WORK_TREE', '/unrelated');
    vi.stubEnv('GIT_DIR', '/unrelated/.git');
    await f.inspect('diff');
    await f.settled();
    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[0]).toBe('/trusted/git');
    const args = call[1] as string[];
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['src/safe.ts']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--literal-pathspecs',
        '--no-ext-diff',
        '--no-textconv',
        'core.fsmonitor=false',
      ]),
    );
    const env = (call[2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
  });

  it('保留预览的敏感、越界、普通文件、大小与行数限制', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
    for (const path of ['.env', '../escape.txt', join(f.cwd, 'src/safe.ts'), 'src', 'large.txt']) {
      await f.inspect('read', path);
      await f.settled();
      expect(f.latest().inspection.error, path).toBe(true);
    }
    expect(f.pre).toEqual([]);
    await writeFile(
      join(f.cwd, 'lines.txt'),
      Array.from({ length: 502 }, (_, i) => 'line ' + (i + 1)).join('\n'),
    );
    await f.inspect('read', 'lines.txt');
    await f.settled();
    expect(f.latest().inspection.content).toContain('500\tline 500');
    expect(f.latest().inspection.content).not.toContain('501\t');
    expect(f.post).toEqual(['read_file']);
  });

  it.skipIf(process.platform === 'win32')(
    '预览拒绝符号链接、硬链接和通过目录链接越界',
    async () => {
      const f = await fixture(),
        outside = await mkdtemp(join(tmpdir(), 'inspection-outside-'));
      folders.push(outside);
      await writeFile(join(outside, 'external.txt'), 'outside content');
      await symlink(join(f.cwd, 'src/safe.ts'), join(f.cwd, 'alias.ts'));
      await link(join(f.cwd, 'src/safe.ts'), join(f.cwd, 'hard.ts'));
      await symlink(outside, join(f.cwd, 'external'), 'dir');
      for (const path of ['alias.ts', 'hard.ts', 'external/external.txt']) {
        await f.inspect('read', path);
        await f.settled();
        expect(f.latest().inspection.error, path).toBe(true);
      }
      expect(f.pre).toEqual([]);
    },
  );

  it('空候选不运行 Git', async () => {
    const f = await fixture();
    await rm(join(f.cwd, 'src'), { recursive: true });
    await f.inspect('diff');
    await f.settled();
    expect(f.latest().inspection.content).toContain('没有本次已授权');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('真实本地 Git 仍显示已授权的改动，不包含隐藏、敏感、删除和未跟踪文件', async () => {
    const childProcess =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const gitModule = await vi.importActual<typeof import('../desktop/worker/git-executable.js')>(
      '../desktop/worker/git-executable.js',
    );
    vi.mocked(execFile).mockImplementation(childProcess.execFile);
    vi.mocked(resolveGitExecutable).mockImplementation(gitModule.resolveGitExecutable);
    const f = await fixture(),
      git = await gitModule.resolveGitExecutable(f.cwd);
    const run = (args: string[]) =>
      promisify(childProcess.execFile)(git, args, { cwd: f.cwd, env: gitEnvironment() });
    await writeFile(join(f.cwd, 'removed.txt'), 'removed before');
    await run(['init', '--quiet']);
    await run(['add', '-f', 'src/safe.ts', '.env', 'removed.txt']);
    await run([
      '-c',
      'user.name=Inspection Test',
      '-c',
      'user.email=inspection@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    await writeFile(join(f.cwd, 'src/safe.ts'), 'const safe = false;\n');
    await writeFile(join(f.cwd, '.env'), 'SECRET=changed-secret\n');
    await writeFile(join(f.cwd, 'untracked.txt'), 'untracked content');
    await rm(join(f.cwd, 'removed.txt'));
    await f.inspect('diff');
    await f.settled();
    expect(f.latest().inspection.error).toBeUndefined();
    expect(f.latest().inspection.content).toContain('+const safe = false;');
    expect(f.latest().inspection.content).not.toMatch(/SECRET|untracked|removed/);
    expect(f.models).toEqual([]);
  });
});
