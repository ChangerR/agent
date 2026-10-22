/** 首次结果限额与项目内按需检索；已进入历史的预览始终不可变。 */
import { z } from 'zod';
import type { Tool, ToolContext } from '../core/registry.js';
import type { ToolResult } from '../core/protocol/types.js';
import { resolveAgentPaths } from '../core/paths.js';
import { ResultFiles, RESULT_ID, type MaintenanceResult } from './result-files.js';
import { estimateTextTokens } from '../core/context/tokens.js';

import { McpResultConfig, type McpResultOptions } from './result-config.js';
export { McpResultConfig, type McpResultOptions } from './result-config.js';
export class McpResultStore {
  readonly maxInlineChars: number;
  private readonly config: z.output<typeof McpResultConfig>;
  private files = new Map<string, ResultFiles>();
  private maintenance = new Map<string, MaintenanceResult>();
  constructor(options?: number | McpResultOptions) {
    this.config = McpResultConfig.parse(
      typeof options === 'number' ? { maxInlineChars: options } : (options ?? {}),
    );
    this.maxInlineChars = this.config.maxInlineChars;
  }
  private store(cwd: string) {
    const key = resolveAgentPaths(cwd).projectStateDir;
    if (!this.files.has(key)) this.files.set(key, new ResultFiles(cwd));
    return this.files.get(key)!;
  }
  private inlineLimit(ctx: ToolContext): number {
    return Math.min(
      this.maxInlineChars,
      ctx.resultBudgetTokens === undefined
        ? this.maxInlineChars
        : Math.max(256, Math.floor(ctx.resultBudgetTokens / 2)),
    );
  }
  async retain(result: ToolResult, ctx: ToolContext): Promise<ToolResult> {
    const cap = this.inlineLimit(ctx);
    if (result.content.length <= cap) return result;
    const points = Array.from(result.content);
    if (points.length <= cap) return result;
    ctx.signal.throwIfAborted();
    let id: string;
    try {
      id = await this.store(ctx.cwd).save(result.content, ctx.signal, this.config.deduplicate);
      await this.cleanup(ctx.cwd, ctx.signal).catch(() => undefined);
    } catch (error) {
      ctx.signal.throwIfAborted();
      return {
        content: `mcp_result_store_error: MCP 操作已经结束，但完整结果保存失败；不要自动重复该操作。错误码: ${(error as NodeJS.ErrnoException).code ?? 'storage_unavailable'}`,
        isError: true,
      };
    }
    const marker = `\n[MCP result: ${points.length} characters. Full result_id=${id}; use mcp_read_result with offset=0 and limit, or mcp_search_result to find relevant text. Preview omits the middle.]\n`;
    const tokenCharacters =
      ctx.resultBudgetTokens === undefined
        ? Infinity
        : Math.floor(Math.max(0, ctx.resultBudgetTokens - estimateTextTokens(marker)) / 2);
    const available = Math.max(0, Math.min(cap - Array.from(marker).length, tokenCharacters));
    const head = Math.ceil(available * 0.6);
    const tail = available - head;
    return {
      ...result,
      content: points.slice(0, head).join('') + marker + (tail ? points.slice(-tail).join('') : ''),
    };
  }
  async cleanup(cwd: string, signal: AbortSignal, now?: number): Promise<MaintenanceResult> {
    const value = await this.store(cwd)
      .cleanup(this.config, signal, now)
      .catch((error) => {
        signal.throwIfAborted();
        return { removed: 0, blocked: 'metadata_scan_incomplete' } as MaintenanceResult;
      });
    this.maintenance.set(resolveAgentPaths(cwd).projectStateDir, value);
    return value;
  }
  status() {
    return [...this.maintenance.values()].map((value) => ({ ...value }));
  }
  hasResults(cwd: string) {
    return this.store(cwd).hasResults();
  }
  async close() {
    await Promise.all([...this.files.values()].map((file) => file.close()));
    this.files.clear();
  }
  reader(): Tool {
    return {
      name: 'mcp_read_result',
      description:
        'Read a stored MCP result in this project by result_id. offset and limit count Unicode characters. Follow continuation offset; use mcp_search_result to find relevant fragments.',
      risk: 'read',
      isConcurrencySafe: true,
      inputSchema: {
        type: 'object',
        properties: {
          result_id: { type: 'string', pattern: RESULT_ID.source },
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
        const requested = input.limit ?? this.maxInlineChars - 256;
        if (
          typeof id !== 'string' ||
          !RESULT_ID.test(id) ||
          !Number.isSafeInteger(offset) ||
          Number(offset) < 0 ||
          !Number.isSafeInteger(requested) ||
          Number(requested) < 1 ||
          Number(requested) > this.maxInlineChars - 256
        )
          throw new Error('invalid_mcp_result_page');
        const tokenCharacters =
          ctx.resultBudgetTokens === undefined
            ? Infinity
            : Math.floor(Math.max(0, ctx.resultBudgetTokens - 80) / 2);
        const limit = Math.max(
          1,
          Math.min(Number(requested), this.inlineLimit(ctx) - 192, tokenCharacters),
        );
        const file = await this.store(ctx.cwd).open(id, ctx.signal);
        try {
          const content = await file.page(Number(offset), limit, ctx.signal);
          const end = Number(offset) + Array.from(content).length;
          return {
            content: `${content}\n[MCP result ${id}: ${offset}-${end} of ${file.index.characters}; ${end < file.index.characters ? `continue with offset=${end}` : 'end of result'}]`,
          };
        } finally {
          await file.close();
        }
      },
    };
  }
  searcher(): Tool {
    return {
      name: 'mcp_search_result',
      description:
        'Search literal, case-sensitive text in a stored MCP result in this project. Returns bounded matching fragments with character offsets. Continue from next_offset; does not repeat the remote MCP operation.',
      risk: 'read',
      isConcurrencySafe: true,
      inputSchema: {
        type: 'object',
        properties: {
          result_id: { type: 'string', pattern: RESULT_ID.source },
          query: { type: 'string', minLength: 1, maxLength: 512 },
          offset: { type: 'integer', minimum: 0 },
          max_matches: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['result_id', 'query'],
        additionalProperties: false,
      },
      analyzeInput: (input) => ({
        patternTarget: JSON.stringify(input),
        summary: `mcp_search_result(${String(input.result_id)})`,
      }),
      execute: async (input, ctx) => {
        const id = input.result_id;
        const query = input.query;
        const offset = input.offset ?? 0;
        const matches = input.max_matches ?? 5;
        if (
          typeof id !== 'string' ||
          !RESULT_ID.test(id) ||
          typeof query !== 'string' ||
          !query.length ||
          query.length > 512 ||
          !Number.isSafeInteger(offset) ||
          Number(offset) < 0 ||
          !Number.isSafeInteger(matches) ||
          Number(matches) < 1 ||
          Number(matches) > 20
        )
          throw new Error('invalid_mcp_result_search');
        const file = await this.store(ctx.cwd).open(id, ctx.signal);
        try {
          if (Number(offset) > file.index.characters)
            throw new Error('mcp_result_offset_out_of_range');
          const found: Array<{ offset: number; text: string }> = [];
          const stop = Math.min(file.index.characters, Number(offset) + this.config.maxSearchChars);
          const queryLength = Array.from(query).length;
          const cap = this.inlineLimit(ctx);
          let position = Number(offset);
          while (position < stop && found.length < Number(matches)) {
            ctx.signal.throwIfAborted();
            const span = Math.min(8192, stop - position);
            const text = await file.page(
              position,
              Math.min(span + queryLength + 80, file.index.characters - position),
              ctx.signal,
            );
            let start = 0;
            let exhausted = true;
            while (true) {
              const at = text.indexOf(query, start);
              if (at < 0) break;
              const point = Array.from(text.slice(0, at)).length;
              if (point >= span) break;
              const points = Array.from(text);
              let snippet = points
                .slice(Math.max(0, point - 60), point + queryLength + 80)
                .join('');
              const fits = (value: string) => {
                const json = JSON.stringify({
                  matches: [...found, { offset: position + point, text: value }],
                  next_offset: file.index.characters,
                  scanned_to: file.index.characters,
                  total_characters: file.index.characters,
                });
                return (
                  Array.from(json).length <= cap &&
                  (ctx.resultBudgetTokens === undefined ||
                    estimateTextTokens(json) <= ctx.resultBudgetTokens)
                );
              };
              if (!fits(snippet)) {
                if (found.length) {
                  position += point;
                  exhausted = false;
                  break;
                }
                let remaining = points.slice(point, point + queryLength + 80);
                while (remaining.length && !fits(remaining.join('')))
                  remaining = remaining.slice(0, Math.floor(remaining.length / 2));
                snippet = remaining.join('');
              }
              found.push({ offset: position + point, text: snippet });
              start = at + query.length;
              if (found.length >= Number(matches)) {
                position += point + queryLength;
                exhausted = false;
                break;
              }
            }
            if (!exhausted) break;
            position += span;
          }
          return {
            content: JSON.stringify({
              matches: found,
              next_offset: position < file.index.characters ? position : null,
              scanned_to: position,
              total_characters: file.index.characters,
            }),
          };
        } finally {
          await file.close();
        }
      },
    };
  }
}
