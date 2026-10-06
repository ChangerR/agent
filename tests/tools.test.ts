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
import { fsCaseSensitive, matchPath, normalizeGrepLine } from '../src/tools/text.js';
import { writeFileTool } from '../src/tools/write.js';

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

  it('CRLF 和 BOM 不出现在行内容里', async () => {
    await writeFile(join(tmp, 'crlf.txt'), '\uFEFFhello\r\nworld');
    const r = await readFileTool.execute({ path: 'crlf.txt' }, ctx());
    expect(r.content).toBe('1\thello\n2\tworld');
    expect(r.content).not.toContain('\r');
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

  it('用 LF 替换 CRLF 文件，并保留 BOM 与换行', async () => {
    await writeFile(join(tmp, 'crlf.txt'), '\uFEFFhello\r\nworld\r\n');
    const r = await editFileTool.execute(
      { path: 'crlf.txt', old_string: 'hello\nworld', new_string: 'hello\nthere' },
      ctx(),
    );
    expect(r.isError).toBeFalsy();
    expect(await readFile(join(tmp, 'crlf.txt'), 'utf-8')).toBe('\uFEFFhello\r\nthere\r\n');
  });

  it('new_string 里的 $& 按字面写入', async () => {
    await editFileTool.execute({ path: 'a.txt', old_string: 'world', new_string: '$&' }, ctx());
    expect(await readFile(join(tmp, 'a.txt'), 'utf-8')).toBe('hello\n$&\nhello again');
  });

  it('Windows 路径的规则靶子使用正斜杠', () => {
    expect(editFileTool.analyzeInput?.({ path: 'src\\a.ts' })?.patternTarget).toBe(
      process.platform === 'win32' ? 'src/a.ts' : 'src\\a.ts',
    );
    expect(matchPath('src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(matchPath('src\\a.ts', 'linux')).toBe('src\\a.ts');
    expect(normalizeGrepLine('src\\a.ts:3: keep\\this', 'win32')).toBe('src/a.ts:3: keep\\this');
    expect(fsCaseSensitive('linux')).toBe(true);
    expect(fsCaseSensitive('win32')).toBe(false);
    expect(fsCaseSensitive('darwin')).toBe(false);
  });
});

describe('write_file', () => {
  it('覆盖时保留原来的 CRLF 和 BOM', async () => {
    await writeFile(join(tmp, 'crlf.txt'), '\uFEFFkeep\r\nme\r\n');
    const r = await writeFileTool.execute({ path: 'crlf.txt', content: 'keep\nthis\n' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(await readFile(join(tmp, 'crlf.txt'), 'utf-8')).toBe('\uFEFFkeep\r\nthis\r\n');
  });

  it('新建文件保留内容里的 CRLF', async () => {
    await writeFileTool.execute({ path: 'new.txt', content: 'a\r\nb\r\n' }, ctx());
    expect(await readFile(join(tmp, 'new.txt'), 'utf-8')).toBe('a\r\nb\r\n');
  });
});

describe('glob', () => {
  it('按模式找文件', async () => {
    const r = await globTool.execute({ pattern: '*.txt' }, ctx());
    expect(r.content).toContain('a.txt');
    expect(r.content).not.toContain('b.ts');
  });

  it('path 相对工作目录', async () => {
    await mkdir(join(tmp, 'sub'));
    await writeFile(join(tmp, 'sub', 'c.txt'), 'x');
    const r = await globTool.execute({ pattern: '*.txt', path: 'sub' }, ctx());
    expect(r.content).toContain('c.txt');
    expect(r.content).not.toContain('a.txt');
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

  it('CRLF 行能用行尾锚点匹配', async () => {
    await writeFile(join(tmp, 'crlf.txt'), 'hello\r\nworld\r\n');
    const r = await grepTool.execute({ pattern: 'hello$', glob: 'crlf.txt' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('crlf.txt:1:');
    expect(r.content).not.toContain('\r');
  });

  it('组装 rg 参数', () => {
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts', caseInsensitive: true })).toContain('--regexp');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts', caseInsensitive: true })).toContain('hello');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts', caseInsensitive: true })).toContain('--ignore-case');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts' })).toContain('!**/node_modules/**');
    expect(buildRgArgs({ pattern: 'hello', glob: '*.ts' })).toContain('--crlf');
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

  it('Windows 上不喷 ProgressPreference，中文输出保持原样', async () => {
    if (process.platform !== 'win32') return;
    const r = await bashTool.execute({ command: "Write-Output '中文测试 OK'" }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('中文测试 OK');
    expect(r.content).not.toContain('ProgressPreference');
  }, 20_000);
});
