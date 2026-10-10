/** 两个真实搜索后端必须使用同一个已约束文件范围。 */
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as platform from '../src/core/platform.js';
import { createGrepTool } from '../src/tools/grep.js';
import { createGlobTool } from '../src/tools/glob.js';
import { collectSearchFiles } from '../src/tools/search-scope.js';

const rg = platform.findRg();
let root: string; let cwd: string;
const signal = () => new AbortController().signal;
const ctx = () => ({ cwd, signal: signal() });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'search-tools-')); cwd = join(root, 'repo');
  await mkdir(join(cwd, 'src/deep'), { recursive: true });
  await mkdir(join(root, 'outside'));
  await writeFile(join(cwd, 'top.ts'), 'needle top\n');
  await writeFile(join(cwd, 'src/a.ts'), 'needle source\n');
  await writeFile(join(cwd, 'src/deep/b.ts'), 'needle deep\n');
  await writeFile(join(root, 'outside/private.ts'), 'needle PRIVATE_EXTERNAL\n');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

for (const backend of ['rg', 'builtin'] as const) describe(`${backend} 搜索契约`, () => {
  beforeEach(() => { vi.spyOn(platform, 'findRg').mockReturnValue(backend === 'rg' ? rg : null); });
  it.skipIf(backend === 'rg' && !rg)('普通搜索保留文件名、行号、子目录glob和大小写选项', async () => {
    const tool = createGrepTool();
    const result = await tool.execute({ pattern: 'NEEDLE', glob: '*.ts', case_insensitive: true }, ctx());
    expect(result.isError).toBeUndefined();
    for (const name of ['top.ts:1:', 'src/a.ts:1:', 'src/deep/b.ts:1:']) expect(result.content).toContain(name);
    expect(result.content).not.toContain(cwd);
    const nested = await tool.execute({ pattern: 'needle', path: 'src', glob: '**/*.ts' }, ctx());
    expect(nested.content).toContain('a.ts:1:'); expect(nested.content).not.toContain('top.ts');
    const glob = await createGlobTool().execute({ pattern: '*.ts' }, ctx());
    expect(glob.content).toBe('top.ts');
  });
  it.skipIf(backend === 'rg' && !rg)('混合项目默认搜索排除敏感、插件、symlink和hardlink但返回正常结果', async () => {
    for (const name of ['.env', 'credentials/token.ts', 'secrets/password.ts', '.hidden/data.ts', 'mcp.json', 'id_rsa', 'private.key', 'node_modules/pkg/file.ts', 'dist/output.ts', 'custom-entry.ts']) {
      await mkdir(join(cwd, name, '..'), { recursive: true }); await writeFile(join(cwd, name), 'needle PRIVATE_SECRET');
    }
    // 只写保护的说明/配置/plugins 目录可被搜索读取。
    for (const name of ['plugins/main.ts', 'agent.config.json', 'AGENTS.md']) {
      await mkdir(join(cwd, name, '..'), { recursive: true }); await writeFile(join(cwd, name), 'needle READABLE');
    }
    await symlink(join(root, 'outside'), join(cwd, 'linked-dir'));
    await symlink(join(root, 'outside/private.ts'), join(cwd, 'linked-file.ts'));
    await symlink('custom-entry.ts', join(cwd, 'plugin-alias.ts'));
    await link(join(cwd, '.env'), join(cwd, 'hardlink.ts'));
    for (const tool of [createGrepTool(['custom-entry.ts']), createGlobTool(['custom-entry.ts'])]) {
      const result = await tool.execute({ pattern: tool.name === 'grep' ? 'needle' : '**/*' }, ctx());
      expect(result.isError).toBeUndefined(); expect(result.content).toContain('src/a.ts');
      expect(result.content).not.toMatch(/PRIVATE|credentials|secrets|custom-entry|plugin-alias|linked-|hardlink|private\.key|mcp\.json/);
      for (const name of ['plugins/main.ts', 'agent.config.json', 'AGENTS.md']) expect(result.content).toContain(name);
    }
  });
  it.skipIf(backend === 'rg' && !rg)('空候选不退回目录扫描，括号/父目录pattern不使枚举越界', async () => {
    const tool = createGrepTool();
    for (const glob of ['missing/**/*.ts', '../outside/**', '{../outside,missing}/**', join(root, 'outside/**')]) {
      expect((await tool.execute({ pattern: 'needle', glob }, ctx())).content).not.toContain('PRIVATE_EXTERNAL');
    }
    expect((await tool.execute({ pattern: 'needle', glob: 'missing/**' }, ctx())).content).toBe('(no matches)');
    expect((await tool.execute({ pattern: 'needle', path: '../outside' }, ctx())).content).toBe('(no matches)');
  });
  it.skipIf(backend === 'rg' && !rg)('参数开头为减号也不是CLI选项，取消不吞掉', async () => {
    await writeFile(join(cwd, '-flags.txt'), '--needle\n');
    expect((await createGrepTool().execute({ pattern: '--needle', glob: '-flags.txt' }, ctx())).content).toContain('-flags.txt:1:');
    const controller = new AbortController(); controller.abort();
    await expect(createGrepTool().execute({ pattern: 'needle' }, { cwd, signal: controller.signal })).rejects.toThrow();
  });
});

it.skipIf(!rg)('真实rg忽略危险RIPGREP_CONFIG_PATH，不运行预处理器或扩大范围', async () => {
  const marker = join(root, 'pre-executed'); const pre = join(root, 'pre.sh');
  await writeFile(pre, `#!/bin/sh\nprintf bad > '${marker}'\ncat "$1"\n`); await chmod(pre, 0o755);
  const config = join(root, 'rg.conf'); await writeFile(config, `--hidden\n--follow\n--pre=${pre}\n`);
  await writeFile(join(cwd, '.env'), 'needle PRIVATE_CONFIG');
  vi.stubEnv('RIPGREP_CONFIG_PATH', config);
  vi.spyOn(platform, 'findRg').mockReturnValue(rg);
  const result = await createGrepTool().execute({ pattern: 'needle' }, ctx());
  expect(result.content).toContain('top.ts:1:'); expect(result.content).not.toContain('PRIVATE');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('共享枚举重新读取文件集，而非缓存首次授权', async () => {
  const before = await collectSearchFiles(cwd, cwd, '**/*', [], signal());
  await writeFile(join(cwd, 'added.ts'), 'new');
  const after = await collectSearchFiles(cwd, cwd, '**/*', [], signal());
  expect(before.some(file => file.path === 'added.ts')).toBe(false);
  expect(after.some(file => file.path === 'added.ts')).toBe(true);
});

it('相对点前缀、项目内目录别名保持结果路径，ignore配置的外部symlink不会被读取', async () => {
  await symlink('src', join(cwd, 'source-alias'));
  await writeFile(join(root, 'outside/ignore'), '*.ts\n');
  await symlink(join(root, 'outside/ignore'), join(cwd, '.gitignore'));
  expect((await createGlobTool().execute({ pattern: './src/**/*.ts' }, ctx())).content).toContain('src/a.ts');
  const result = await createGrepTool().execute({ pattern: 'needle', path: 'source-alias' }, ctx());
  expect(result.content).toContain('a.ts:1:'); expect(result.content).not.toContain(cwd);
});

it.skipIf(!rg)('rg分批超过argv批次时仍返回后续匹配并统一截断', async () => {
  vi.spyOn(platform, 'findRg').mockReturnValue(rg);
  for (let index = 0; index < 140; index++) await writeFile(join(cwd, `batch-${String(index).padStart(3, '0')}.txt`), index === 139 ? 'late-needle' : 'none');
  const late = await createGrepTool().execute({ pattern: 'late-needle', glob: 'batch-*.txt' }, ctx());
  expect(late.content).toContain('batch-139.txt:1:');
  const many = await createGrepTool().execute({ pattern: 'none', glob: 'batch-*.txt' }, ctx());
  expect(many.content.split('\n')).toHaveLength(101); expect(many.content).toContain('[truncated]');
});
