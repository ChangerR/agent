import { link, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeterministicAnalyzer, createDeterministicPolicy, parseLiteralShell, previewRuleConflicts, validateWriteRoots, nativeFilesystemAnalysisSupported } from '../src/builtin/policy-deterministic-v2/index.js';
import { createLegacyPolicy, PermissionEngine } from '../src/builtin/policy-legacy/index.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import type { PermissionMode } from '../src/core/config.js';
import type { SessionRules } from '../src/core/permission/contracts.js';
import type { Policy, PolicyInput, Reviewer } from '../src/sdk/index.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';
import { bashTool } from '../src/tools/bash.js';
import { globTool } from '../src/tools/glob.js';
import { grepTool } from '../src/tools/grep.js';

let root: string; let cwd: string; let outside: string;
const rules = (value: Partial<SessionRules> = {}): SessionRules => ({ allow: [], ask: [], deny: [], ...value });
const signal = () => new AbortController().signal;
const trusted = (tool: Tool): Tool => ({ ...tool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
const read = trusted(readFileTool); const write = trusted(writeFileTool); const bash = trusted(bashTool); const glob = trusted(globTool); const grep = trusted(grepTool);
const policy = (mode: PermissionMode = 'auto', configured: Partial<SessionRules> = {}, pluginEntries?: readonly string[]) => createDeterministicPolicy({ cwd, mode, rules: rules(configured), pluginEntries });
const operation = (tool: Tool = read, input: Record<string, unknown> = { path: 'src/code.ts' }): PolicyInput => ({ tool, input, cwd, configRevision: 'c1', policyRevision: 'p1' });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'policy-v2-')); cwd = join(root, 'repo'); outside = join(root, 'outside');
  await mkdir(join(cwd, 'src'), { recursive: true }); await mkdir(outside);
  await writeFile(join(cwd, 'src/code.ts'), 'export const value = 1;'); await writeFile(join(outside, 'data.txt'), 'outside');
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('optional deterministic policy v2', () => {
  it('完整的项目内普通文件 read 在 auto 中确定性放行，ask 模式仍询问', async () => {
    expect(await policy().decide(operation(), signal())).toMatchObject({ kind: 'allow', reasonCode: 'v2_safe_read' });
    expect(await policy('ask').decide(operation(), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_ask_mode' });
  });

  it('默认 legacy 顺序不变，v2 ask 优先并提供只读冲突预览', async () => {
    const configured = rules({ allow: ['read_file'], ask: ['read_file(src/**)'] });
    const legacy = createLegacyPolicy(new PermissionEngine({ mode: 'auto', rules: configured }));
    expect((await legacy.decide(operation(), signal())).kind).toBe('allow');
    expect(await policy('auto', configured).decide(operation(), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_explicit_ask' });
    const before = structuredClone(configured);
    expect(previewRuleConflicts(configured)).toEqual([{ tool: 'read_file', allowRule: 'read_file', askRule: 'read_file(src/**)', certainty: 'definite', legacyWinner: 'allow', v2Winner: 'ask' }]);
    expect(configured).toEqual(before);
  });

  it('deny 先于敏感路径、ask 与任何 allow，且无需工具回调或文件分析', async () => {
    const value = policy('yolo', { deny: ['read_file'], allow: ['read_file'], ask: ['read_file'] });
    const analyze = vi.spyOn(value.analyzer!, 'analyze'); const callback = vi.fn(() => { throw new Error('broken tool callback'); });
    const tool = { ...read, analyzeInput: callback, execute: vi.fn(async () => ({ content: 'must not run' })) };
    const tools = new ToolRegistry(); tools.register(tool);
    const responder = vi.fn(async () => ({ allow: true } as const));
    const executor = new ToolExecutor({ tools, policy: value, events: new EventBus(), hooks: new HookRunner(), cwd, approvalResponder: responder });
    expect((await executor.invokeTool('read_file', { path: '.env' }, { signal: signal(), runId: 'deny', userRequest: 'read', messages: [] })).content).toContain('Permission denied');
    expect(callback).not.toHaveBeenCalled(); expect(analyze).toHaveBeenCalledTimes(1); // 执行门独立采集环境，policy 不再读取它。
    expect(responder).not.toHaveBeenCalled(); expect(tool.execute).not.toHaveBeenCalled();
  });

  it('会话规则只在同 action 类别内优先；会话 allow 不盖过配置 ask/deny', async () => {
    const value = policy('auto', { ask: ['read_file'], deny: ['write_file'] });
    value.controller!.addSessionRule('allow', 'read_file(="src/code.ts")');
    value.controller!.addSessionRule('allow', 'write_file(="src/new.ts")');
    expect((await value.decide(operation(), signal())).kind).toBe('ask');
    expect((await value.decide(operation(write, { path: 'src/new.ts', content: 'x' }), signal())).kind).toBe('deny');
  });

  it('等价路径拼写和符号链接不能绕过精确 deny/ask', async () => {
    await symlink('src/code.ts', join(cwd, 'alias.ts'));
    for (const path of ['./src/code.ts', 'src/../src/code.ts', join(cwd, 'src/code.ts'), 'alias.ts']) {
      expect((await policy('auto', { deny: ['read_file(src/code.ts)'] }).decide(operation(read, { path }), signal())).kind).toBe('deny');
      expect((await policy('auto', { ask: ['read_file(src/code.ts)'] }).decide(operation(read, { path }), signal())).kind).toBe('ask');
    }
  });

  it('精确普通文件目标授权可放行，宽 allow 不能放行不确定写入', async () => {
    const input = operation(write, { path: 'src/new.ts', content: 'x' });
    expect(await policy('auto', { allow: ['write_file(="src/new.ts")'] }).decide(input, signal())).toMatchObject({ kind: 'allow', reasonCode: 'v2_exact_allow' });
    expect((await policy('auto', { allow: ['write_file'] }).decide(input, signal())).kind).toBe('review');
    expect((await policy('ask', { allow: ['write_file(src/new.ts)'] }).decide(input, signal())).kind).toBe('allow');
  });

  describe.each(['ask', 'auto'] as const)('%s 模式的精确 allow 搜索', (mode) => {
    it.each([
      { broadSource: 'config', literalSource: 'config' },
      { broadSource: 'session', literalSource: 'session' },
      { broadSource: 'session', literalSource: 'config' },
      { broadSource: 'config', literalSource: 'session' },
    ] as const)('跳过 $broadSource 宽规则，找到 $literalSource 字面量授权', async ({ broadSource, literalSource }) => {
      for (const broad of ['write_file', 'write_file(src/**)']) for (const literal of ['write_file(="src/new.ts")', 'write_file(src/new.ts)']) {
        const grants: Record<'config' | 'session', string[]> = { config: [], session: [] };
        grants[broadSource].push(broad);
        grants[literalSource].push('write_file(="src/other.ts")', literal);
        const value = policy(mode, { allow: grants.config });
        for (const rule of grants.session) value.controller!.addSessionRule('allow', rule);
        expect(await value.decide(operation(write, { path: 'src/new.ts', content: 'x' }), signal())).toMatchObject({
          kind: 'allow', reasonCode: 'v2_exact_allow', source: literalSource, matchedRule: literal,
        });
      }
    });

    it.each(['config', 'session'] as const)('只有 %s 宽规则时仍不能确定性放行写入', async (source) => {
      const broad = ['write_file', 'write_file(src/**)'];
      const value = policy(mode, { allow: source === 'config' ? broad : [] });
      if (source === 'session') for (const rule of broad) value.controller!.addSessionRule('allow', rule);
      expect(await value.decide(operation(write, { path: 'src/new.ts', content: 'x' }), signal())).toMatchObject({
        kind: mode === 'ask' ? 'ask' : 'review', reasonCode: mode === 'ask' ? 'v2_ask_mode' : 'v2_review_uncertain',
      });
    });

    it.each(['config', 'session'] as const)('%s deny/ask 仍优先于两种来源的宽规则与精确授权', async (source) => {
      const allow = ['write_file', 'write_file(="src/new.ts")'];
      for (const kind of ['deny', 'ask'] as const) {
        const restriction = 'write_file(src/**)';
        const value = policy(mode, { allow, ...(source === 'config' ? { [kind]: [restriction] } : {}) });
        for (const rule of allow) value.controller!.addSessionRule('allow', rule);
        if (source === 'session') value.controller!.addSessionRule(kind, restriction);
        if (kind === 'deny') value.controller!.addSessionRule('ask', 'write_file');
        expect(await value.decide(operation(write, { path: 'src/new.ts', content: 'x' }), signal())).toMatchObject({
          kind, reasonCode: kind === 'deny' ? 'v2_deny_rule' : 'v2_explicit_ask', source, matchedRule: restriction,
        });
      }
    });

    it('跳过宽规则后仍不绕过敏感目标与未知分析约束', async () => {
      const value = policy(mode, { allow: ['write_file', 'write_file(=".env")', 'write_file(="src/new.ts")', 'bash', 'bash(="npm test")'] });
      expect(await value.decide(operation(write, { path: '.env', content: 'x' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_sensitive_target' });
      for (const input of [operation(bash, { command: 'npm test' }), operation({ ...write, ownerPlugin: 'third-party' }, { path: 'src/new.ts', content: 'x' })]) {
        expect(await value.decide(input, signal())).toMatchObject({
          kind: mode === 'ask' ? 'ask' : 'review', reasonCode: mode === 'ask' ? 'v2_ask_mode' : 'v2_review_uncertain',
        });
      }
    });
  });

  it.each(['.env', '.env.local', '.ssh/id_ed25519', '.git/hooks/pre-commit', '.git/config', '.agent/settings.json', 'agent.config.json', 'mcp.json', 'plugins/plugin.js', 'AGENTS.md'])('敏感目标 %s 必须询问，精确规则与 yolo 均不能覆盖', async (path) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), 'fixture');
    const value = policy('yolo', { allow: [`write_file(=${JSON.stringify(path)})`, `read_file(=${JSON.stringify(path)})`] });
    expect(await value.decide(operation(write, { path, content: 'changed' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_sensitive_target' });
    expect((await value.decide(operation(read, { path }), signal())).kind).toBe('ask');
  });

  it('自定义插件入口及其符号链接别名也受保护', async () => {
    await mkdir(join(cwd, 'extensions')); await writeFile(join(cwd, 'extensions/custom.ts'), 'plugin');
    await symlink('extensions/custom.ts', join(cwd, 'ordinary.ts'));
    expect(await policy('auto', {}, ['extensions/custom.ts']).decide(operation(read, { path: 'ordinary.ts' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_sensitive_target' });
  });

  it.each(['../outside/data.txt', '/etc/passwd'])('路径逃逸 %s 必须询问', async (path) => {
    expect(await policy('yolo', { allow: ['read_file'] }).decide(operation(read, { path }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_external_target' });
  });

  it('现有与新文件父目录符号链接，以及悬空符号链接都不能逃出项目', async () => {
    await symlink(outside, join(cwd, 'external-dir'));
    await symlink(join(outside, 'not-created.txt'), join(cwd, 'dangling'));
    for (const path of ['external-dir/data.txt', 'external-dir/new/deep.txt', 'dangling']) {
      expect(await policy('yolo').decide(operation(write, { path, content: 'x' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_external_target' });
    }
  });

  it('项目内 .. 规范化不会无条件拒绝，真实目标仍被检查', async () => {
    expect((await policy().decide(operation(read, { path: 'src/../src/code.ts' }), signal())).kind).toBe('allow');
  });

  it('硬链接可能指向敏感别名，不能据表面路径自动放行', async () => {
    await writeFile(join(cwd, '.env'), 'secret fixture'); await link(join(cwd, '.env'), join(cwd, 'ordinary.txt'));
    expect(await policy('yolo').decide(operation(read, { path: 'ordinary.txt' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_aliased_target' });
  });

  it('非普通文件目标不能确定性读写', async () => {
    expect(await policy('yolo').decide(operation(write, { path: 'src', content: 'x' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_special_target' });
  });

  it.each(['C:\\Users\\owner\\file', 'C:relative.txt', '\\\\server\\share\\file', 'src\\file'])('其他平台路径 %s 不被当成安全 POSIX 相对路径', async (path) => {
    if (process.platform === 'win32') return;
    expect(await policy('yolo').decide(operation(read, { path }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_external_target' });
  });

  it('平台能力声明明确禁用原生 Windows 确定性文件授予（不冒充实机测试）', () => {
    expect(nativeFilesystemAnalysisSupported('win32')).toBe(false);
    expect(nativeFilesystemAnalysisSupported('linux')).toBe(true);
  });

  it('未知 MCP 和冒用内置名称/版本的插件不能依赖 risk:read 静默放行', async () => {
    for (const tool of [{ ...read, ownerPlugin: 'third-party' }, { ...read, version: '2.0.0' }, { ...read, name: 'mcp__files__read', ownerPlugin: 'agentlab.mcp' }]) {
      expect((await policy().decide(operation(tool), signal())).kind).toBe('review');
      expect((await policy('yolo').decide(operation(tool), signal())).kind).toBe('ask');
    }
  });

  it('字面量 glob 可验证具体普通文件，递归 glob/grep 保持不完整', async () => {
    expect((await policy().decide(operation(glob, { pattern: 'src/code.ts' }), signal())).kind).toBe('allow');
    expect((await policy().decide(operation(glob, { pattern: 'src/**/*.ts' }), signal())).kind).toBe('review');
    expect((await policy().decide(operation(grep, { pattern: 'value', path: 'src' }), signal())).kind).toBe('review');
    expect((await policy('yolo').decide(operation(glob, { pattern: '../outside/**' }), signal())).kind).toBe('ask');
    expect((await policy().decide(operation(glob, { pattern: '**/.env' }), signal())).kind).toBe('ask');
  });

  it.each(['pwd', 'echo "hello"', "printf '%s\\n' 'hello'"])('字面量 Shell %s 只证明语法，不自动证明解释器安全', async (command) => {
    expect(parseLiteralShell(command).complete).toBe(true);
    expect((await policy().decide(operation(bash, { command }), signal())).kind).toBe('review');
    expect((await policy('yolo', { allow: [`bash(=${JSON.stringify(command)})`] }).decide(operation(bash, { command }), signal())).kind).toBe('ask');
  });

  it.each(['echo x > file', 'echo $(cat .env)', 'pwd && rm x', 'npm test', 'pnpm build', 'git status', 'git -c alias.x=!rm x', 'echo $HOME', 'cat *.txt'])('未知或动态 Shell %s 从不确定性放行', async (command) => {
    expect(parseLiteralShell(command).complete).toBe(false);
    expect((await policy('yolo').decide(operation(bash, { command }), signal())).kind).toBe('ask');
  });

  it('已知危险 Shell 必须询问，auto reviewer 也没有资格覆盖', async () => {
    expect(await policy('auto', { allow: ['bash'] }).decide(operation(bash, { command: 'sudo rm -rf /opt' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_danger_constraint' });
  });

  it('yolo 仅跳过完整普通文件写入；auto 写入仍交给 reviewer', async () => {
    const input = operation(write, { path: 'new/sub/file.ts', content: 'x' });
    expect((await policy('yolo').decide(input, signal())).kind).toBe('allow');
    expect((await policy('auto').decide(input, signal())).kind).toBe('review');
  });

  it('writeRoots 默认空，只有显式授权的普通 src 写入免除模型', async () => {
    const value = createDeterministicPolicy({ cwd, mode: 'auto', rules: rules(), writeRoots: ['src'] });
    expect(await value.decide(operation(write, { path: 'src/generated.ts', content: 'x' }), signal())).toMatchObject({ kind: 'allow', reasonCode: 'v2_scoped_write' });
    expect((await policy().decide(operation(write, { path: 'src/generated.ts', content: 'x' }), signal())).kind).toBe('review');
    expect((await value.decide(operation(write, { path: 'other/generated.ts', content: 'x' }), signal())).kind).toBe('review');
    expect((await value.decide(operation(write, { path: 'src/AGENTS.md', content: 'instructions' }), signal())).kind).toBe('ask');
    expect((await value.decide(operation({ ...write, ownerPlugin: 'third-party' }, { path: 'src/generated.ts', content: 'x' }), signal())).kind).toBe('review');
    const ask = createDeterministicPolicy({ cwd, mode: 'ask', rules: rules(), writeRoots: ['src'] });
    expect(await ask.decide(operation(write, { path: 'src/generated.ts', content: 'x' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_ask_mode' });
  });

  it('其他配置的分析快照不能扩大 writeRoots，本策略不能跨项目借用', async () => {
    const value = createDeterministicPolicy({ cwd, mode: 'auto', rules: rules(), writeRoots: ['src'] });
    const input = operation(write, { path: 'ungranted.ts', content: 'x' });
    const wider = await createDeterministicAnalyzer({ writeRoots: ['.'] }).analyze(input, signal());
    expect((await value.decide({ ...input, analysis: wider }, signal())).kind).toBe('review');
    expect(await value.decide({ ...input, cwd: outside }, signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_context_changed' });
  });

  it('writeRoots 不能覆盖明确 ask/deny 或通过符号链接越界', async () => {
    await symlink(outside, join(cwd, 'src/external'));
    const value = createDeterministicPolicy({ cwd, mode: 'auto', rules: rules({ ask: ['write_file(src/ask.ts)'], deny: ['write_file(src/deny.ts)'] }), writeRoots: ['src'] });
    expect((await value.decide(operation(write, { path: 'src/ask.ts', content: 'x' }), signal())).kind).toBe('ask');
    expect((await value.decide(operation(write, { path: 'src/deny.ts', content: 'x' }), signal())).kind).toBe('deny');
    expect((await value.decide(operation(write, { path: 'src/external/new.ts', content: 'x' }), signal())).kind).toBe('ask');
    expect((await value.decide(operation(write, { path: 'src/missing-content.ts' }), signal())).kind).toBe('ask');
  });

  it('项目外、敏感目录、非目录 writeRoots 不可启用', async () => {
    for (const root of ['../outside', 'plugins', 'src/code.ts', 'src/code.ts/child']) await expect(validateWriteRoots(cwd, [root])).rejects.toThrow();
    await expect(validateWriteRoots(cwd, ['new-src'])).resolves.toEqual([join(cwd, 'new-src')]);
  });

  it('writeRoots 自身符号链接切换也使待执行批准失效', async () => {
    await mkdir(join(cwd, 'allowed')); await symlink('allowed', join(cwd, 'grant'));
    const analyzer = createDeterministicAnalyzer({ writeRoots: ['grant'] });
    const input = operation(write, { path: 'grant/new.ts', content: 'x' }); const first = await analyzer.analyze(input, signal());
    await unlink(join(cwd, 'grant')); await symlink(outside, join(cwd, 'grant'));
    await expect(analyzer.revalidate!(first, input, signal())).rejects.toThrow('writeRoots');
  });

  it('worktree .git 指针不会令普通 Shell 分析失败；真实配置变化仍失效', async () => {
    const gitdir = join(root, 'actual-git'); await mkdir(gitdir);
    await writeFile(join(cwd, '.git'), `gitdir: ${gitdir}\n`); await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/test');
    await writeFile(join(gitdir, 'config'), '[core]');
    const analyzer = createDeterministicAnalyzer(); const input = operation(bash, { command: 'git status' });
    const first = await analyzer.analyze(input, signal()); expect(first.completeness).toBe('unknown');
    await writeFile(join(gitdir, 'config'), '[alias]\nx = !anything'); expect(await analyzer.revalidate!(first, input, signal())).toBe(false);
    expect((await policy().decide(operation(write, { path: '.git/hooks/new', content: 'x' }), signal())).kind).toBe('ask');
  });

  it('worktree .git 指针和 git 元数据不能被整项目目录授权/精确规则/yolo 覆盖', async () => {
    await writeFile(join(cwd, '.git'), 'gitdir: /tmp/fixture-gitdir');
    for (const mode of ['auto', 'yolo'] as const) {
      const value = createDeterministicPolicy({ cwd, mode, rules: rules({ allow: ['write_file(=".git")'] }), writeRoots: ['.'] });
      expect(await value.decide(operation(write, { path: '.git', content: 'gitdir: /other' }), signal())).toMatchObject({ kind: 'ask', reasonCode: 'v2_sensitive_target' });
    }
    const tools = new ToolRegistry(); const execute = vi.fn(async () => ({ content: 'bad' })); tools.register({ ...write, execute });
    const executor = new ToolExecutor({ tools, cwd, hooks: new HookRunner(), events: new EventBus(),
      policy: createDeterministicPolicy({ cwd, mode: 'auto', rules: rules(), writeRoots: ['.'] }) });
    expect((await executor.invokeTool('write_file', { path: '.git', content: 'gitdir: /other' }, { signal: signal(), runId: 'git-pointer', userRequest: 'edit source', messages: [] })).content).toContain('approval_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('纯解析缓存复用语法，不复用文件状态或放行结论', async () => {
    const analyzer = createDeterministicAnalyzer(); const input = operation();
    const first = await analyzer.analyze(input, signal());
    await writeFile(join(cwd, 'src/code.ts'), 'modified');
    expect(await analyzer.revalidate!(first, input, signal())).toBe(false);
    expect(analyzer.cacheStats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
    await analyzer.analyze({ ...input, input: { path: 'src/code.ts', arbitrary: 1 } }, signal());
    await analyzer.analyze({ ...input, configRevision: 'c2' }, signal());
    await analyzer.analyze({ ...input, policyRevision: 'p2' }, signal());
    await analyzer.analyze({ ...input, tool: { ...read, version: 'different' } }, signal());
    expect(analyzer.cacheStats().misses).toBe(5);
  });

  it('脚本、git 配置与 BASH_ENV 内容改变使旧环境快照无效', async () => {
    const analyzer = createDeterministicAnalyzer();
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node task.js' } }));
    await writeFile(join(cwd, 'task.js'), 'old');
    const input = operation(bash, { command: 'npm test' }); const first = await analyzer.analyze(input, signal());
    await writeFile(join(cwd, 'task.js'), 'changed'); expect(await analyzer.revalidate!(first, input, signal())).toBe(false);
    await mkdir(join(cwd, '.git')); await writeFile(join(cwd, '.git/config'), '[alias]');
    const second = await analyzer.analyze(input, signal()); await writeFile(join(cwd, '.git/config'), '[alias]\nx = !anything');
    expect(await analyzer.revalidate!(second, input, signal())).toBe(false);
    await writeFile(join(cwd, 'env.sh'), 'old'); vi.stubEnv('BASH_ENV', join(cwd, 'env.sh'));
    const third = await analyzer.analyze(operation(bash, { command: 'pwd' }), signal()); await writeFile(join(cwd, 'env.sh'), 'new');
    expect(await analyzer.revalidate!(third, operation(bash, { command: 'pwd' }), signal())).toBe(false);
  });

  it('执行门：安全文件读取模型0次，未知调用至多委托一次，明确 ask不委托', async () => {
    const reviewer: Reviewer = { review: vi.fn<Reviewer['review']>(async () => ({ decision: 'unknown', reason: 'needs user', reasonCode: 'unknown' })) };
    const tools = new ToolRegistry(); const execute = vi.fn(async () => ({ content: 'ok' }));
    tools.register({ ...read, execute }); tools.register({ ...bash, execute });
    const executor = new ToolExecutor({ tools, events: new EventBus(), hooks: new HookRunner(), cwd, policy: policy(), reviewer });
    const context = { signal: signal(), runId: 'one', userRequest: 'inspect', messages: [] };
    expect((await executor.invokeTool('read_file', { path: 'src/code.ts' }, context)).isError).toBeUndefined();
    expect(reviewer.review).not.toHaveBeenCalled();
    expect((await executor.invokeTool('bash', { command: 'npm test' }, context)).content).toContain('approval_required');
    expect(reviewer.review).toHaveBeenCalledTimes(1);
    await executor.invokeTool('read_file', { path: '.env' }, context); expect(reviewer.review).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1);
  });
});
