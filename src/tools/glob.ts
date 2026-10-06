import { resolve } from 'node:path';
import fg from 'fast-glob';
import type { Tool } from '../core/registry.js';
import { fsCaseSensitive, matchPath } from './text.js';

export const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern, sorted by modification time (newest first). Respects .gitignore.',
  risk: 'read',
  isConcurrencySafe: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      path: { type: 'string', description: 'Directory to search, default cwd' },
    },
    required: ['pattern'],
  },
  analyzeInput(input) {
    const pattern = matchPath(String(input.pattern ?? ''));
    return { patternTarget: pattern, summary: `glob: ${pattern}` };
  },
  async execute(input, ctx) {
    const pattern = matchPath(String(input.pattern));
    const cwd = input.path ? resolve(ctx.cwd, String(input.path)) : ctx.cwd;
    const entries = await fg(pattern, {
      cwd,
      dot: false,
      onlyFiles: true,
      caseSensitiveMatch: fsCaseSensitive(),
      stats: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    });
    const sorted = entries
      .sort((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0))
      .slice(0, 200)
      .map((e) => e.path);
    return { content: sorted.length > 0 ? sorted.join('\n') : '(no matches)' };
  },
};
