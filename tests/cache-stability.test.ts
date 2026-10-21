import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDefaultContext } from '../src/builtin/context-default/implementation.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { toOpenAIParams } from '../src/providers/openai.js';
import { mkdtempProject } from './helpers/project.js';

afterEach(() => vi.useRealTimers());
describe('可复用的静态前缀', () => {
  it('日期和目录变化只影响环境尾部，项目规范及通用规则保持在前', async () => {
    const roots = await Promise.all(
      ['a', 'b'].map((name) => mkdtempProject(join(tmpdir(), `cache-${name}-`))),
    );
    try {
      for (const cwd of roots) await writeFile(join(cwd, 'AGENTS.md'), '同一项目规范：禁止越权。');
      const build = (cwd: string) =>
        buildDefaultContext({ cwd, tools: { list: () => [] }, skills: [], platform: 'linux' });
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
      const a = build(roots[0]);
      vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
      const b = build(roots[1]);
      expect(a.filter((part) => part.stability === 'stable').map((part) => part.text)).toEqual(
        b.filter((part) => part.stability === 'stable').map((part) => part.text),
      );
      expect(a.at(-1)?.text).toContain('2026-10-21');
      expect(b.at(-1)?.text).toContain('2026-10-22');
      expect(a.at(-1)?.stability).toBe('session');
      expect(a.slice(0, -1).some((part) => part.text.includes('同一项目规范'))).toBe(true);
    } finally {
      await Promise.all(roots.map((cwd) => rm(cwd, { recursive: true, force: true })));
    }
  });

  it('不同注册和 schema 对象键顺序得到相同请求，数组与实际参数顺序不改写', () => {
    const tool = (name: string, reverse: boolean): Tool => ({
      name,
      description: 'same',
      risk: 'read',
      inputSchema: {
        type: 'object',
        properties: reverse
          ? { b: { type: 'number' }, a: { type: 'string' } }
          : { a: { type: 'string' }, b: { type: 'number' } },
        required: ['b', 'a'],
      },
      execute: async () => ({ content: 'unused' }),
    });
    const a = new ToolRegistry(),
      b = new ToolRegistry();
    for (const name of ['beta', 'alpha']) a.register(tool(name, false));
    for (const name of ['alpha', 'beta']) b.register(tool(name, true));
    const body = (tools: ToolRegistry) =>
      toOpenAIParams({
        model: 'fixture',
        system: 'stable',
        messages: [],
        tools: tools.definitions(),
      });
    expect(JSON.stringify(body(a))).toBe(JSON.stringify(body(b)));
    expect(a.definitions()[0].inputSchema.required).toEqual(['b', 'a']);
    expect(Object.keys(a.get('alpha')!.inputSchema.properties as object)).toEqual(['a', 'b']);
  });
});
