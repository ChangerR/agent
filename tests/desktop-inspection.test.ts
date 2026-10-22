import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import type { PluginSetupContext, Tool, ToolContext } from '../src/sdk/index.js';
import { inspectionPlugin } from '../desktop/worker/inspection.js';
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function tool() {
  let result: Tool | undefined;
  const plugin = inspectionPlugin(async () => '/trusted/git');
  await plugin.setup({
    provide: {
      tool: (_id: string, value: Tool) => {
        result = value;
      },
    },
  } as unknown as PluginSetupContext);
  return result!;
}
describe('桌面 Git 检查保持子工具授权边界', () => {
  it('拒绝 read_file 的目标不交给 Git，并使用字面路径与受控环境', async () => {
    const callback = vi.mocked(execFile);
    callback.mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      done: (error: null, out: string) => void,
    ) => {
      done(null, 'diff output');
      return {} as never;
    }) as unknown as typeof execFile);
    vi.stubEnv('GIT_WORK_TREE', '/unrelated');
    vi.stubEnv('GIT_DIR', '/unrelated/.git');
    const invokeTool = vi.fn(async (name: string, input: Record<string, unknown>) =>
      name === 'glob'
        ? { content: 'safe.ts\n.env\n:(glob)**' }
        : input.path === 'safe.ts'
          ? { content: '1\tallowed' }
          : { isError: true, content: 'Permission denied' },
    );
    const result = await (
      await tool()
    ).execute({}, {
      cwd: '/repo',
      signal: new AbortController().signal,
      invokeTool,
    } as ToolContext);
    expect(result.content).toBe('diff output');
    expect(invokeTool).toHaveBeenCalledWith('read_file', { path: '.env', limit: 1 });
    const call = callback.mock.calls.at(-1)!;
    expect(call[0]).toBe('/trusted/git');
    const args = call[1] as string[];
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['safe.ts']);
    expect(args).toContain('--literal-pathspecs');
    expect(args).toContain('--no-ext-diff');
    expect(args).toContain('--no-textconv');
    expect((call[2] as { env: NodeJS.ProcessEnv }).env.GIT_WORK_TREE).toBeUndefined();
    expect((call[2] as { env: NodeJS.ProcessEnv }).env.GIT_DIR).toBeUndefined();
  });
  it('所有目标被拒绝时不运行 Git', async () => {
    vi.mocked(execFile).mockClear();
    const invokeTool = vi.fn(async (name: string) =>
      name === 'glob' ? { content: 'secret.ts' } : { isError: true, content: 'denied' },
    );
    const result = await (
      await tool()
    ).execute({}, {
      cwd: '/repo',
      signal: new AbortController().signal,
      invokeTool,
    } as ToolContext);
    expect(result.content).toContain('没有本次已授权');
    expect(execFile).not.toHaveBeenCalled();
  });
});
