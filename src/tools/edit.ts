import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../core/registry.js';

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Exact string replacement in a file. old_string must match exactly once (or use replace_all). Read the file first.',
  risk: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  analyzeInput(input) {
    const path = String(input.path ?? '');
    return { patternTarget: path, summary: `edit_file: ${path}` };
  },
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const oldString = String(input.old_string);
    const newString = String(input.new_string);
    const text = await readFile(path, 'utf-8');

    const occurrences = text.split(oldString).length - 1;
    if (occurrences === 0) {
      return { content: 'old_string not found in file', isError: true };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        content: `old_string matches ${occurrences} times; provide more context or set replace_all`,
        isError: true,
      };
    }
    const updated = input.replace_all
      ? text.split(oldString).join(newString)
      : text.replace(oldString, newString);
    await writeFile(path, updated, 'utf-8');
    return { content: `Edited ${path} (${occurrences} replacement${occurrences > 1 ? 's' : ''})` };
  },
};
