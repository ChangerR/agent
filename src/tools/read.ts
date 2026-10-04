import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../core/registry.js';

const MAX_CHARS = 100_000;

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a text file. Returns numbered lines. Use offset/limit to page large files.',
  risk: 'read',
  isConcurrencySafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
      offset: { type: 'number', description: '1-based start line' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['path'],
  },
  analyzeInput(input) {
    const path = String(input.path ?? '');
    return { patternTarget: path, summary: `read_file: ${path}` };
  },
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const text = await readFile(path, 'utf-8');
    const lines = text.split('\n');
    const offset = Number(input.offset ?? 1);
    const limit = Number(input.limit ?? lines.length);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    let out = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
    if (out.length > MAX_CHARS) out = `${out.slice(0, MAX_CHARS)}\n[truncated]`;
    return { content: out || '(empty file)' };
  },
};
