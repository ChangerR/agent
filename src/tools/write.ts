import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Tool } from '../core/registry.js';
import { fromLf, matchPath, textStyle, type Newline } from './text.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write a file (complete overwrite). Creates parent directories automatically. An existing file keeps its BOM and newline style; a new file keeps the newlines in content, defaulting to LF.',
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
    return { patternTarget: matchPath(path), summary: `write_file: ${path} (${String(input.content ?? '').length} chars)` };
  },
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const incoming = textStyle(String(input.content));
    const existing = await existingStyle(path);
    const newline: Newline = existing?.newline ?? incoming.newline;
    const bom = existing?.bom ?? incoming.bom;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bom + fromLf(incoming.body, newline), 'utf-8');
    return { content: `Wrote ${path}` };
  },
};

async function existingStyle(path: string): Promise<{ bom: string; newline: Newline } | undefined> {
  try {
    const style = textStyle(await readFile(path, 'utf-8'));
    return { bom: style.bom, newline: style.newline };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
