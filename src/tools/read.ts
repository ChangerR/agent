import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../core/registry.js';
import { matchPath, textStyle } from './text.js';

const MAX_CHARS = 100_000;
const DEFAULT_LIMIT = 200;

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file, default 200 lines. Returns numbered LF-separated lines and a continuation offset when more remain. Search with grep first, then use offset/limit for relevant sections. Do not include line-number prefixes in edits.',
  risk: 'read',
  isConcurrencySafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
      offset: { type: 'integer', minimum: 1, description: '1-based start line' },
      limit: { type: 'integer', minimum: 1, description: 'Number of lines to read (default 200)' },
    },
    required: ['path'],
  },
  analyzeInput(input) {
    const path = String(input.path ?? '');
    return { patternTarget: matchPath(path), summary: `read_file: ${path}` };
  },
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const { body } = textStyle(await readFile(path, 'utf-8'));
    const lines = body.split('\n');
    const offset = Number(input.offset ?? 1);
    const limit = Number(input.limit ?? DEFAULT_LIMIT);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
    if (out.length > MAX_CHARS)
      out = `${out.slice(0, MAX_CHARS)}\n[truncated at character limit; use a smaller limit to inspect this range]`;
    else if (slice.length && offset - 1 + slice.length < lines.length)
      out += `\n[Showing lines ${offset}-${offset + slice.length - 1} of ${lines.length}; continue with offset=${offset + slice.length}]`;
    return { content: out || '(empty file)' };
  },
};
