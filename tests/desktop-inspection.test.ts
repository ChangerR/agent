import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectLocalProject, readLocalFile } from '../desktop/worker/inspection.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'desktop-local-inspection-'));
  folders.push(cwd);
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/safe.ts'), 'const safe = true;\n');
  await writeFile(join(cwd, '.env'), 'SECRET=do-not-read\n');
  return cwd;
}

function gitResponse(files: string, diff: string) {
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    done: (error: null, out: string) => void,
  ) => {
    done(null, args.includes('ls-files') ? files : diff);
    return {} as never;
  }) as unknown as typeof execFile);
}

describe('桌面本地只读检查', () => {
  it('直接列出项目文件并读取普通文件，敏感路径不进入预览', async () => {
    const cwd = await fixture();
    const listed = await inspectLocalProject({
      cwd,
      kind: 'files',
      signal: new AbortController().signal,
    });
    expect(listed.error).toBeUndefined();
    expect(listed.content).toContain('src/safe.ts');
    expect(listed.content).not.toContain('.env');
    expect(await readLocalFile(cwd, 'src/safe.ts', new AbortController().signal)).toContain(
      '1\tconst safe = true;',
    );
    const secret = await readFile(join(cwd, '.env'), 'utf8');
    expect(secret).toBe('SECRET=do-not-read\n');
    await expect(readLocalFile(cwd, '.env', new AbortController().signal)).rejects.toThrow(
      '受保护内容',
    );
  });

  it('直接执行受控 Git，不调用 Agent，并过滤敏感文件和环境变量', async () => {
    const cwd = await fixture();
    gitResponse('src/safe.ts\0.env\0', 'diff output');
    vi.stubEnv('GIT_WORK_TREE', '/unrelated');
    vi.stubEnv('GIT_DIR', '/unrelated/.git');
    const result = await inspectLocalProject({
      cwd,
      kind: 'diff',
      signal: new AbortController().signal,
      resolveGit: async () => '/trusted/git',
    });
    expect(result.content).toBe('diff output');
    const diffCall = vi
      .mocked(execFile)
      .mock.calls.find((call) => (call[1] as string[]).includes('diff'))!;
    expect(diffCall[0]).toBe('/trusted/git');
    const args = diffCall[1] as string[];
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['src/safe.ts']);
    expect(args).toContain('--literal-pathspecs');
    expect(args).toContain('--no-ext-diff');
    expect(args).toContain('--no-textconv');
    expect((diffCall[2] as { env: NodeJS.ProcessEnv }).env.GIT_WORK_TREE).toBeUndefined();
    expect((diffCall[2] as { env: NodeJS.ProcessEnv }).env.GIT_DIR).toBeUndefined();
  });

  it('没有可检查的已跟踪文件时不运行 diff', async () => {
    const cwd = await fixture();
    gitResponse('.env\0', 'must not execute');
    const result = await inspectLocalProject({
      cwd,
      kind: 'diff',
      signal: new AbortController().signal,
      resolveGit: async () => '/trusted/git',
    });
    expect(result.content).toContain('没有可检查');
    const calls = vi.mocked(execFile).mock.calls;
    expect(calls.some((call) => (call[1] as string[]).includes('diff'))).toBe(false);
  });
});
