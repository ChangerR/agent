/** 执行时不扩大已通过审批的 shell 计划。 */
import { mkdtemp, mkdir, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createDeterministicAnalyzer } from '../src/builtin/policy/analyzer.js';
import { bashTool } from '../src/tools/bash.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function bound() {
  const root = await mkdtemp(join(tmpdir(), 'shell-bound-')); roots.push(root);
  const cwd = join(root, 'repo'); await mkdir(cwd); await writeFile(join(cwd, 'data.txt'), 'ordinary\n');
  const signal = new AbortController().signal;
  const analysis = await createDeterministicAnalyzer().analyze({ tool: { ...bashTool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' }, input: { command: 'cat data.txt' }, cwd }, signal);
  expect(analysis.completeness).toBe('complete');
  return { root, cwd, signal, analysis };
}
it.skipIf(process.platform === 'win32')('实际执行前文件身份改变不能复用受控 shell 授权', async () => {
  const state = await bound(); await writeFile(join(state.root, 'outside.txt'), 'external sentinel');
  await unlink(join(state.cwd, 'data.txt')); await symlink(join(state.root, 'outside.txt'), join(state.cwd, 'data.txt'));
  await expect(bashTool.execute({ command: 'cat data.txt' }, state)).rejects.toThrow('approval_stale');
});
it.skipIf(process.platform === 'win32')('已绑定只读计划不能被换成未经授权命令', async () => {
  const state = await bound();
  await expect(bashTool.execute({ command: 'echo changed > data.txt' }, state)).rejects.toThrow('approval_stale');
});
