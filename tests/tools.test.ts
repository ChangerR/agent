/**
 * 内置工具测试。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashTool } from '../src/tools/bash.js';
import { editFileTool } from '../src/tools/edit.js';
import { globTool } from '../src/tools/glob.js';
import { buildRgArgs, grepTool } from '../src/tools/grep.js';
import { readFileTool } from '../src/tools/read.js';

let tmp: string;
const ctx = () => ({ cwd: tmp, signal: new AbortController().signal });

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agentlab-tools-'));
  await writeFile(join(tmp, 'a.txt'), 'hello\nworld\nhello again');
  await writeFile(join(tmp, 'b.ts'), 'const x = 1;');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('read_file', () => {
  it('返回带行号的内容', async () => {
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx());
    expect(r.content).toContain('1\thello');
    expect(r.content).toContain('3\thello again');
  });

  it('offset/limit 分页', async () => {
    const r = await readFileTool.execute({ path: 'a.txt', offset: 2, limit: 1 }, ctx());
    expect(r.content).toBe('2\tworld');
  });
});

describe('edit_file', () => {
  it('精确替换', async () => {
    const r = await editFileTool.execute({ path: 'a.txt', old_string: 'world', new_string: 'WORLD' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(await readFile(join(tmp, 'a.txt'), 'utf-8')).toContain('WORLD');
  });

  it('多处匹配且无 replace_all 时报错', async () => {
    const r = await editFileTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'hi' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('2 times');
  });

  it('replace_all 替换全部', async () => {
    await editFileTool.execute({ path: 'a.txt', old_string: 'hello', new_string: 'hi', replace_all: true }, ctx());
    expect(await readFile(join(tmp, 'a.txt'), 'utf-8')).toBe('hi\nworld\nhi again');
  });

  it('找不到 old_string 时报错', async () => {
    const r = await editFileTool.execute({ path: 'a.txt', old_string: 'nope', new_string: 'x' }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe('glob', () => {
  it('按模式找文件', async () => {
    const r = await globTool.execute({ pattern: '*.txt' }, ctx());
    expect(r.content).toContain('a.txt');
    expect(r.content).not.toContain('b.ts');
  });
});

describe('grep', () => {
  it('返回匹配行与行号', async () => {
    const r = await grepTool.execute({ pattern: 'hello' }, ctx());
    expect(r.content).toContain('a.txt:1:');
    expect(r.content).toContain('a.txt:3:');
    expect(r.content).not.toContain('a.txt:2:');
  });

  it('glob 过滤', async () => {
    const r = await grepTool.execute({ pattern: 'const', glob: '*.txt' }, ctx());
    expect(r.content).toBe('(no matches)');
  });

  it('跳过 node_modules', async () => {
    await mkdir(join(tmp, 'node_modules'), { recursive: true });
    await writeFile(join(tmp, 'node_modules', 'secret.txt'), 'hello from modules');
    const r = await grepTool.execute({ pattern: 'hello from modules' }, ctx());
    expect(r.content).toBe('(no matches)');
  });

  it('非法正则返回错误', async () => {
    const r = await grepTool.execute({ pattern: '(' }, ctx());
    expect(r.isError).toBe(true);
  });

  it('组装 rg 参数', () => {
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts', caseInsensitive: true })).toContain('--regexp');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts', caseInsensitive: true })).toContain('hello');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts', caseInsensitive: true })).toContain('--ignore-case');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts' })).toContain('!**/node_modules/**');
  });
});

describe('bash', () => {
  const command = process.platform === 'win32' ? "Write-Output 'agentlab-ok'" : "echo agentlab-ok";
  const failing = process.platform === 'win32' ? "Get-Item 'agentlab-missing-path'" : 'false';

  it('用当前操作系统的 shell 执行并带回输出', async () => {
    const r = await bashTool.execute({ command }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('agentlab-ok');
    expect(r.content).not.toContain('\u0000');
  }, 20_000);

  it('命令失败时标记 isError', async () => {
    const r = await bashTool.execute({ command: failing }, ctx());
    expect(r.isError).toBe(true);
  }, 20_000);
});
