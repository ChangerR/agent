import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tool } from '../core/registry.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write a file (complete overwrite). Creates parent directories automatically.',
  risk: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  analyzeInput(input) {
    const path = String(input.path ?? '');
    return { patternTarget: path, summary: `write_file: ${path} (${String(input.content ?? '').length} chars)` };
  },
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, String(input.content), 'utf-8');
    return { content: `Wrote ${path}` };
  },
};
