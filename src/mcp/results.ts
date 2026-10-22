/** MCP 结果在首次入历史前限额；完整文本保存在项目运行状态中，按不透明 ID 分页读取。 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalPath, resolveAgentPaths } from '../core/paths.js';
import type { Tool, ToolContext } from '../core/registry.js';
import type { ToolResult } from '../core/protocol/types.js';

export const McpResultConfig = z.object({
  maxInlineChars: z.number().int().min(1024).max(1_000_000).default(24_000),
});
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(a) === normalize(b);
}

function resultDirectory(cwd: string): string {
  const paths = resolveAgentPaths(cwd);
  return join(canonicalPath(paths.agentHome), 'state', 'projects', paths.projectId, 'mcp-results');
}

/** 不沿状态目录下的符号链接创建文件；结果文件另外用独占写入和 no-follow 读取。 */
async function ensureDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_result_directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await ensureDirectory(dirname(path));
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const actual = await realpath(path);
  if (!samePath(actual, path)) throw new Error('unsafe_result_directory');
}

export class McpResultStore {
  readonly maxInlineChars: number;

  constructor(maxInlineChars?: number) {
    this.maxInlineChars = McpResultConfig.parse({ maxInlineChars }).maxInlineChars;
  }

  async retain(result: ToolResult, ctx: ToolContext): Promise<ToolResult> {
    // UTF-16 长度是码点数的上界，小结果无需分配完整码点数组。
    if (result.content.length <= this.maxInlineChars) return result;
    const points = Array.from(result.content);
    if (points.length <= this.maxInlineChars) return result;
    ctx.signal.throwIfAborted();
    const id = randomUUID();
    try {
      const directory = resultDirectory(ctx.cwd);
      await ensureDirectory(directory);
      ctx.signal.throwIfAborted();
      await writeFile(join(directory, `${id}.txt`), result.content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
        signal: ctx.signal,
      });
    } catch (error) {
      ctx.signal.throwIfAborted();
      return {
        content: `mcp_result_store_error: MCP 操作已经结束，但完整结果保存失败；不要自动重复该操作。错误码: ${(error as NodeJS.ErrnoException).code ?? 'storage_unavailable'}`,
        isError: true,
      };
    }
    const marker = `\n[MCP result: ${points.length} characters. Full result_id=${id}; use mcp_read_result with offset=0 and limit to read it. Preview omits the middle.]\n`;
    const available = this.maxInlineChars - Array.from(marker).length;
    const head = Math.ceil(available * 0.6);
    return {
      ...result,
      content: points.slice(0, head).join('') + marker + points.slice(-(available - head)).join(''),
    };
  }

  reader(): Tool {
    return {
      name: 'mcp_read_result',
      description:
        'Read a stored MCP result by its result_id. Uses 0-based character offset and a bounded page; follow the returned continuation offset. Result IDs belong to the current project.',
      risk: 'read',
      isConcurrencySafe: true,
      inputSchema: {
        type: 'object',
        properties: {
          result_id: { type: 'string', pattern: ID.source },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: this.maxInlineChars - 256 },
        },
        required: ['result_id'],
        additionalProperties: false,
      },
      analyzeInput: (input) => ({
        patternTarget: JSON.stringify(input),
        summary: `mcp_read_result(${String(input.result_id)})`,
      }),
      execute: async (input, ctx) => {
        const id = input.result_id;
        const offset = input.offset ?? 0;
        const limit = input.limit ?? this.maxInlineChars - 256;
        if (
          typeof id !== 'string' ||
          !ID.test(id) ||
          !Number.isSafeInteger(offset) ||
          Number(offset) < 0 ||
          !Number.isSafeInteger(limit) ||
          Number(limit) < 1 ||
          Number(limit) > this.maxInlineChars - 256
        )
          throw new Error('invalid_mcp_result_page');
        ctx.signal.throwIfAborted();
        const directory = resultDirectory(ctx.cwd);
        // 续读只接受已经存在的状态目录，不在任意 ID 读取时创建目录。
        if (!samePath(await realpath(directory), directory))
          throw new Error('unsafe_result_directory');
        const file = await open(
          join(directory, `${id}.txt`),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_result_file');
          const points = Array.from(await file.readFile({ encoding: 'utf8', signal: ctx.signal }));
          if (Number(offset) > points.length) throw new Error('mcp_result_offset_out_of_range');
          const end = Math.min(points.length, Number(offset) + Number(limit));
          const content = points.slice(Number(offset), end).join('');
          const footer = end < points.length ? `continue with offset=${end}` : 'end of result';
          return {
            content: `${content}\n[MCP result ${id}: ${Number(offset)}-${end} of ${points.length}; ${footer}]`,
          };
        } finally {
          await file.close();
        }
      },
    };
  }
}
