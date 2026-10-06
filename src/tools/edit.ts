import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Tool } from '../core/registry.js';
import { fromLf, matchPath, textStyle } from './text.js';

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Exact string replacement in a file. old_string must match exactly once (or use replace_all) and must not include read_file line numbers. LF and CRLF count as the same newline; the file keeps its original newline style and BOM. Read the file first.',
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
    return { patternTarget: matchPath(path), summary: `edit_file: ${path}` };
  },
  async execute(input, ctx) {
    const path = resolve(ctx.cwd, String(input.path));
    const oldString = textStyle(String(input.old_string)).body;
    const newString = textStyle(String(input.new_string)).body;
    if (oldString.length === 0) return { content: 'old_string is empty', isError: true };

    const style = textStyle(await readFile(path, 'utf-8'));
    const occurrences = countOccurrences(style.body, oldString);
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
      ? style.body.split(oldString).join(newString)
      : replaceOnce(style.body, oldString, newString);
    await writeFile(path, style.bom + fromLf(updated, style.newline), 'utf-8');
    return { content: `Edited ${path} (${occurrences} replacement${occurrences > 1 ? 's' : ''})` };
  },
};

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

/** 不用 String.replace，避免 new_string 里的 $& 被当成替换模式。 */
function replaceOnce(text: string, oldString: string, newString: string): string {
  const index = text.indexOf(oldString);
  return text.slice(0, index) + newString + text.slice(index + oldString.length);
}
