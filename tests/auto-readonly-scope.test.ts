/** auto 模式下内置只读工具的放行范围回归矩阵：误伤修复与保留的安全收紧。 */
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectRelativePattern } from '../src/tools/search-scope.js';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { createGlobTool } from '../src/tools/glob.js';
import { createGrepTool } from '../src/tools/grep.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';
import type { PolicyInput } from '../src/sdk/index.js';

const trusted = (tool: Tool): Tool => ({ ...tool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
const read = trusted(readFileTool); const write = trusted(writeFileTool); const glob = trusted(createGlobTool()); const grep = trusted(createGrepTool());
const tools = { read_file: read, write_file: write, glob, grep } as const;
const signal = () => new AbortController().signal;
// 非 root 才能让 chmod 000 真正不可读；原生 Windows 不做确定性文件授予（见 nativeFilesystemAnalysisSupported）。
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let root: string; let cwd: string; let outside: string; let locked: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'auto-readonly-')); cwd = join(root, 'project'); outside = join(root, 'outside'); locked = join(root, 'locked-project');
  const files: Record<string, string> = {
    'src/a.ts': 'export const needle = 1;\n', 'README.md': '# readme\n', 'AGENTS.md': '# agents\n', 'CLAUDE.md': '# claude\n', 'agent.config.json': '{}\n',
    'mcp.json': '{}\n', '.env': 'TOKEN=fixture\n', '.eslintrc.json': '{}\n', 'plugins/vite-plugin.ts': 'export const needle = 2;\n', 'src/i18n.key': 'k\n',
    'config/credentials.json': '{}\n', 'node_modules/pkg/index.js': 'module.exports = 1;\n', 'node_modules/.pnpm/zod@1.0.0/node_modules/zod/package.json': '{}\n',
    'src/hard.ts': 'h\n', '!private.txt': 'bang\n',
  };
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(cwd, name)), { recursive: true }); await writeFile(join(cwd, name), content); }
  // pnpm 布局：包目录是指向 .pnpm 的符号链接，文件与全局 store 硬链接（nlink ≥ 2）。
  await mkdir(join(root, 'store'), { recursive: true });
  await link(join(cwd, 'node_modules/.pnpm/zod@1.0.0/node_modules/zod/package.json'), join(root, 'store/zod-package.json'));
  await symlink(join(cwd, 'node_modules/.pnpm/zod@1.0.0/node_modules/zod'), join(cwd, 'node_modules/zod'));
  await mkdir(join(cwd, 'docs'));
  await link(join(cwd, 'src/hard.ts'), join(cwd, 'docs/hard-copy.ts'));
  await mkdir(outside); await writeFile(join(outside, 'o.txt'), 'outside\n');
  // 回归：项目外密钥被硬链接进 node_modules（路径段不能证明 inode 来自 pnpm store）。
  await writeFile(join(outside, 'id_rsa'), 'PRIVATE-KEY-FIXTURE\n'); await link(join(outside, 'id_rsa'), join(cwd, 'node_modules/pkg/index2.js'));
  await symlink(join(outside, 'o.txt'), join(cwd, 'src/link-out.txt'));
  await symlink('a.ts', join(cwd, 'src/link-in.ts'));
  await mkdir(join(locked, 'src'), { recursive: true }); await writeFile(join(locked, 'src/a.ts'), 'export const needle = 3;\n');
  await mkdir(join(locked, 'data-volume')); await writeFile(join(locked, 'data-volume/x.ts'), 'needle\n'); await chmod(join(locked, 'data-volume'), 0o000);
});
afterAll(async () => { await chmod(join(locked, 'data-volume'), 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }); });

type Outcome = 'allow' | 'ask-human' | 'ask-model';
async function decide(project: string, name: keyof typeof tools, input: Record<string, unknown>): Promise<{ outcome: Outcome; reasonCode?: string }> {
  const policy = createDeterministicPolicy({ cwd: project, mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
  const operation: PolicyInput = { tool: tools[name], input, cwd: project, configRevision: 'c', policyRevision: 'p' };
  const decision = await policy.decide(operation, signal());
  return { outcome: decision.kind === 'allow' ? 'allow' : decision.kind === 'review' ? 'ask-model' : 'ask-human', reasonCode: decision.reasonCode };
}

describe.skipIf(process.platform === 'win32')('auto 只读工具放行矩阵', () => {
  const abs = (path: string) => join(cwd, path);
  // [工具, 输入, 期望结果, 期望 reasonCode]；input 中的 {cwd} / {outside} 在运行时替换。
  const matrix: Array<[keyof typeof tools, Record<string, unknown>, Outcome, string]> = [
    // 正常放行
    ['read_file', { path: 'src/a.ts' }, 'allow', 'safe_read'],
    ['read_file', { path: '{cwd}/src/a.ts' }, 'allow', 'safe_read'],
    ['read_file', { path: '.eslintrc.json' }, 'allow', 'safe_read'],
    ['read_file', { path: 'src/link-in.ts' }, 'allow', 'safe_read'],
    ['read_file', { path: 'node_modules/pkg/index.js' }, 'allow', 'safe_read'],
    ['glob', { pattern: '**/*.ts' }, 'allow', 'safe_read'],
    ['glob', { pattern: 'src/**' }, 'allow', 'safe_read'],
    ['glob', { pattern: '*.ts', path: 'src' }, 'allow', 'safe_read'],
    ['glob', { pattern: '**/*.ts', path: '{cwd}/src' }, 'allow', 'safe_read'],
    ['grep', { pattern: 'needle' }, 'allow', 'safe_read'],
    ['grep', { pattern: 'needle', glob: '*.ts', path: 'src' }, 'allow', 'safe_read'],
    // 本次修复的误伤
    ['read_file', { path: 'src/missing.ts' }, 'allow', 'safe_read'],
    ['read_file', { path: '~/.bashrc' }, 'allow', 'safe_read'],
    ['read_file', { path: 'src' }, 'allow', 'safe_read'],
    ['read_file', { path: 'AGENTS.md' }, 'allow', 'safe_read'],
    ['read_file', { path: 'CLAUDE.md' }, 'allow', 'safe_read'],
    ['read_file', { path: 'agent.config.json' }, 'allow', 'safe_read'],
    ['read_file', { path: 'plugins/vite-plugin.ts' }, 'allow', 'safe_read'],
    ['glob', { pattern: 'plugins/*.ts' }, 'allow', 'safe_read'],
    ['glob', { pattern: '*.ts', path: 'plugins' }, 'allow', 'safe_read'],
    ['glob', { pattern: '{cwd}/src/**/*.ts' }, 'allow', 'safe_read'],
    ['grep', { pattern: 'needle', path: 'plugins' }, 'allow', 'safe_read'],
    // 保留的安全收紧
    ['read_file', { path: '.env' }, 'ask-human', 'sensitive_target'],
    ['read_file', { path: 'mcp.json' }, 'ask-human', 'sensitive_target'],
    ['read_file', { path: 'src/i18n.key' }, 'ask-human', 'sensitive_target'],
    ['read_file', { path: 'config/credentials.json' }, 'ask-human', 'sensitive_target'],
    ['read_file', { path: '.env.missing' }, 'ask-human', 'sensitive_target'],
    ['read_file', { path: '{outside}/o.txt' }, 'ask-human', 'external_target'],
    ['read_file', { path: '{outside}/missing.txt' }, 'ask-human', 'external_target'],
    ['read_file', { path: 'src/link-out.txt' }, 'ask-human', 'external_target'],
    ['read_file', { path: 'src/hard.ts' }, 'ask-human', 'aliased_target'],
    // 多硬链接一律保持审批：pnpm store 硬链接与外部密钥硬链接在路径上无法区分
    ['read_file', { path: 'node_modules/zod/package.json' }, 'ask-human', 'aliased_target'],
    ['read_file', { path: 'node_modules/pkg/index2.js' }, 'ask-human', 'aliased_target'],
    // 绝对 pattern 的相对部分以 ! 开头时不转换（避免 minimatch 取反），按项目外处理
    ['glob', { pattern: '{cwd}/!private.txt' }, 'ask-human', 'external_target'],
    ['glob', { pattern: 'src/hard.ts' }, 'ask-human', 'aliased_target'],
    ['glob', { pattern: '**/*.key' }, 'ask-human', 'sensitive_target'],
    ['glob', { pattern: '{outside}/*' }, 'ask-human', 'external_target'],
    ['glob', { pattern: '{cwd}/../outside/*' }, 'ask-human', 'external_target'],
    ['glob', { pattern: '*', path: '{outside}' }, 'ask-human', 'external_target'],
    ['grep', { pattern: 'x', path: '{outside}' }, 'ask-human', 'external_target'],
  ];
  it.each(matrix)('%s %j → %s', async (name, raw, outcome, reasonCode) => {
    const input = Object.fromEntries(Object.entries(raw)
      .map(([key, value]) => [key, typeof value === 'string' ? value.replaceAll('{cwd}', cwd).replaceAll('{outside}', outside) : value]));
    expect(await decide(cwd, name, input)).toEqual({ outcome, reasonCode });
  });

  it('写入方向保持保护：AGENTS.md / CLAUDE.md / agent.config.json / plugins 与 node_modules 硬链接写入仍询问', async () => {
    for (const path of ['AGENTS.md', 'CLAUDE.md', 'agent.config.json', 'plugins/new.ts']) {
      expect(await decide(cwd, 'write_file', { path, content: 'x' })).toEqual({ outcome: 'ask-human', reasonCode: 'sensitive_target' });
    }
    expect(await decide(cwd, 'write_file', { path: 'node_modules/zod/package.json', content: 'x' })).toEqual({ outcome: 'ask-human', reasonCode: 'aliased_target' });
  });

  it('已配置的插件入口即使位于普通目录也仍受读写保护', async () => {
    const policy = createDeterministicPolicy({ cwd, mode: 'auto', rules: { allow: [], ask: [], deny: [] }, pluginEntries: ['plugins/vite-plugin.ts'] });
    for (const [tool, input] of [[read, { path: 'plugins/vite-plugin.ts' }], [write, { path: 'plugins/vite-plugin.ts', content: 'x' }]] as const) {
      expect(await policy.decide({ tool, input, cwd, configRevision: 'c', policyRevision: 'p' }, signal())).toMatchObject({ kind: 'ask', reasonCode: 'sensitive_target' });
    }
  });

  it.skipIf(isRoot)('枚举遇到不可读目录时跳过，分析与执行一致：全项目 glob/grep 直接放行', async () => {
    expect(await decide(locked, 'glob', { pattern: '**/*.ts' })).toEqual({ outcome: 'allow', reasonCode: 'safe_read' });
    expect(await decide(locked, 'grep', { pattern: 'needle' })).toEqual({ outcome: 'allow', reasonCode: 'safe_read' });
    const registry = new ToolRegistry(); registry.register(glob);
    const policy = createDeterministicPolicy({ cwd: locked, mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
    let asks = 0;
    const executor = new ToolExecutor({ tools: registry, policy, events: new EventBus(), hooks: new HookRunner(), cwd: locked, approvalResponder: async () => { asks++; return { allow: false }; } });
    const result = await executor.invokeTool('glob', { pattern: '**/*.ts' }, { signal: signal(), runId: 'locked', userRequest: 'find', messages: [] });
    expect(asks).toBe(0); expect(result.isError).toBeFalsy(); expect(result.content).toBe('src/a.ts');
  });

  it('外部密钥硬链接进 node_modules 仍需审批，拒绝后不返回内容', async () => {
    const registry = new ToolRegistry(); registry.register(read);
    const policy = createDeterministicPolicy({ cwd, mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
    let asks = 0;
    const executor = new ToolExecutor({ tools: registry, policy, events: new EventBus(), hooks: new HookRunner(), cwd, approvalResponder: async () => { asks++; return { allow: false }; } });
    const result = await executor.invokeTool('read_file', { path: 'node_modules/pkg/index2.js' }, { signal: signal(), runId: 'hardlink', userRequest: 'read', messages: [] });
    expect(asks).toBe(1); expect(result.content).not.toContain('PRIVATE-KEY-FIXTURE');
  });

  it('绝对 glob 转相对时保留字面语义：开头的 ! / # 不转换，执行不会变成取反匹配', async () => {
    expect(projectRelativePattern(join(cwd, '!private.txt'), [cwd])).toBe(join(cwd, '!private.txt'));
    expect(projectRelativePattern(join(cwd, '#notes.md'), [cwd])).toBe(join(cwd, '#notes.md'));
    expect(projectRelativePattern(join(cwd, 'src/!x.ts'), [cwd])).toBe('src/!x.ts');
    expect(projectRelativePattern(join(cwd, 'src/**/*.ts'), [cwd])).toBe('src/**/*.ts');
    const registry = new ToolRegistry(); registry.register(glob);
    const policy = createDeterministicPolicy({ cwd, mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
    let asks = 0;
    const executor = new ToolExecutor({ tools: registry, policy, events: new EventBus(), hooks: new HookRunner(), cwd, approvalResponder: async () => { asks++; return { allow: true }; } });
    const result = await executor.invokeTool('glob', { pattern: join(cwd, '!private.txt') }, { signal: signal(), runId: 'bang', userRequest: 'find', messages: [] });
    expect(asks).toBe(1);
    expect(result.content).not.toContain('src/a.ts'); expect(result.content).not.toContain('README.md');
  });

  it('端到端：auto 下连续 read_file / glob / grep 零审批，且工具结果正确', async () => {
    const registry = new ToolRegistry(); for (const tool of [read, glob, grep]) registry.register(tool);
    const policy = createDeterministicPolicy({ cwd, mode: 'auto', rules: { allow: [], ask: [], deny: [] } });
    const events = new EventBus(); const requests: unknown[] = [];
    events.on('permission_request', (event) => { requests.push(event); event.resolve({ allow: false }); });
    const executor = new ToolExecutor({ tools: registry, policy, events, hooks: new HookRunner(), cwd });
    const run = (name: string, input: Record<string, unknown>) => executor.invokeTool(name, input, { signal: signal(), runId: 'e2e', userRequest: 'explore', messages: [] });
    expect((await run('read_file', { path: 'AGENTS.md' })).content).toContain('# agents');
    expect((await run('read_file', { path: abs('src/a.ts') })).content).toContain('needle');
    const missing = await run('read_file', { path: 'src/missing.ts' }); expect(missing.isError).toBe(true); expect(missing.content).toContain('ENOENT');
    const directory = await run('read_file', { path: 'src' }); expect(directory.isError).toBe(true); expect(directory.content).toContain('EISDIR');
    expect((await run('glob', { pattern: '**/*.ts' })).content).toContain('src/a.ts');
    expect((await run('glob', { pattern: abs('src/**/*.ts') })).content).toContain('a.ts');
    expect((await run('glob', { pattern: 'plugins/*.ts' })).content).toContain('plugins/vite-plugin.ts');
    const grepped = await run('grep', { pattern: 'needle' });
    expect(grepped.content).toContain('src/a.ts'); expect(grepped.content).toContain('plugins/vite-plugin.ts'); expect(grepped.content).not.toContain('TOKEN');
    expect(requests).toHaveLength(0);
  });
});
