import { resolve } from 'node:path';
import { authorizedSearchFiles, authorizedSearchTarget, collectSearchFiles, searchPluginEntries } from './search-scope.js';
import type { Tool } from '../core/registry.js';
import { matchPath } from './text.js';

export function createGlobTool(pluginEntries: readonly string[] = []): Tool { return {
  name: 'glob',
  description: 'Find ordinary project files by glob pattern, newest first. Excludes hidden/sensitive files, configured plugin entries, symlinks, node_modules and dist. Respects project and nested .gitignore, including for explicit patterns. The pattern only filters files within the project.',
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
    const protectedEntries = await searchPluginEntries(ctx.cwd, pluginEntries);
    const entries = authorizedSearchFiles(await collectSearchFiles(ctx.cwd, cwd, pattern, protectedEntries, ctx.signal, false, (file) => authorizedSearchTarget(file.absolute, ctx.analysis)), ctx.analysis);
    const sorted = entries
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 200)
      .map((e) => e.path);
    return { content: sorted.length > 0 ? sorted.join('\n') : '(no matches)' };
  },
}; }

export const globTool = createGlobTool();
