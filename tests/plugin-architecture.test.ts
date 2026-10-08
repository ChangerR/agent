import { promises as fs } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
const root = resolve('.');
/** 仅旧导入兼容入口可连接默认实现。实际 runtime 不得通过这些门面。 */
export const LEGACY_CORE_FACADES = new Set([
  'src/core/context/manager.ts',
  'src/core/context/system-prompt.ts',
  'src/core/debug-log.ts',
  'src/core/plugin.ts',
  'src/core/permission/engine.ts',
  'src/core/permission/judge.ts',
  'src/core/permission/review-context.ts',
  'src/core/permission-config.ts',
  'src/core/session/manager.ts',
  'src/core/session/store.ts',
]);
async function files(directory: string): Promise<string[]> {
  const found = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(found.map(entry => entry.isDirectory() ? files(resolve(directory, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [resolve(directory, entry.name)] : [])))).flat();
}
async function runtimeImports(file: string): Promise<string[]> {
  const source = ts.createSourceFile(file, await fs.readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (!clause?.name && named && ts.isNamedImports(named) && named.elements.every(item => item.isTypeOnly));
      if (!onlyTypes) found.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(item => item.isTypeOnly));
      if (!onlyTypes) found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source); return found;
}
const local = (file: string, specifier: string): string | undefined => specifier.startsWith('.') ? resolve(dirname(file), specifier.replace(/\.js$/, '.ts')) : undefined;
const short = (file: string): string => relative(root, file).replaceAll('\\', '/');
const forbidden = (name: string): boolean => /(?:^|\/)(?:builtin|providers|tools|cli|mcp|skills)\//.test(name) || name === 'openai' || name.startsWith('@anthropic-ai/') || name.includes('pi-tui');
describe('插件分层与 headless 入口架构守卫', () => {
  it('真正的 core 实现不连接默认实现、兼容门面、厂商 SDK 或终端', async () => {
    const violations: string[] = [];
    for (const file of await files(resolve('src/core'))) {
      if (LEGACY_CORE_FACADES.has(short(file))) continue;
      for (const specifier of await runtimeImports(file)) {
        const target = local(file, specifier);
        if (forbidden(target ? short(target) : specifier) || (target && LEGACY_CORE_FACADES.has(short(target))) || (target && short(target).startsWith('src/compat/'))) violations.push(`${short(file)} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
  it('生产 runtime 的可执行依赖图不经过默认 preset 或 legacy core 门面', async () => {
    const seen = new Set<string>(); const violations: string[] = [];
    async function walk(file: string): Promise<void> {
      if (seen.has(file)) return; seen.add(file);
      for (const specifier of await runtimeImports(file)) {
        const target = local(file, specifier);
        if (forbidden(target ? short(target) : specifier) || (target && LEGACY_CORE_FACADES.has(short(target)))) { violations.push(`${short(file)} -> ${specifier}`); continue; }
        if (target) await walk(target);
      }
    }
    await walk(resolve('src/runtime/create-agent.ts'));
    expect(violations).toEqual([]);
    expect(seen.has(resolve('src/core/context/coordinator.ts'))).toBe(true);
    expect(seen.has(resolve('src/core/session/coordinator.ts'))).toBe(true);
  });
  it('独立 Node 进程导入公共 headless 入口时绝不解析 pi-tui', async () => {
    const guard = `export async function resolve(specifier, context, nextResolve) { if (specifier.includes('pi-tui')) throw new Error('headless attempted TUI import: ' + specifier); return nextResolve(specifier, context); }`;
    const code = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(guard)}`)}, import.meta.url); const entry = await import(${JSON.stringify(pathToFileURL(resolve('src/index.ts')).href)}); if (typeof entry.createAgent !== 'function') throw new Error('missing headless entry'); process.stdout.write('headless-ok');`;
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', code], { cwd: root, timeout: 20000 });
    expect(result.stdout).toBe('headless-ok');
  }, 25000);
});
