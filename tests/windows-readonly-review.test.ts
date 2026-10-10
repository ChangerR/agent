/**
 * 原生 Windows（nativeFilesystemAnalysisSupported 为 false）下 auto/yolo 的内置只读工具交给模型审批。
 * 通过 platform 注入覆盖 Windows 分支，因此在 Linux/macOS CI 上同样运行，不按宿主平台跳过。
 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionMode } from '../src/core/config.js';
import { createDeterministicPolicy, windowsAmbiguousPath } from '../src/builtin/policy/index.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { bashTool } from '../src/tools/bash.js';
import { editFileTool } from '../src/tools/edit.js';
import { createGlobTool } from '../src/tools/glob.js';
import { createGrepTool } from '../src/tools/grep.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';
import type { SessionRules } from '../src/core/permission/contracts.js';
import type { PolicyInput, ReviewInput, ReviewResult } from '../src/sdk/capabilities.js';

const trusted = (tool: Tool): Tool => ({ ...tool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
const tools = { read_file: trusted(readFileTool), write_file: trusted(writeFileTool), edit_file: trusted(editFileTool), glob: trusted(createGlobTool()),
  grep: trusted(createGrepTool()), bash: trusted(bashTool) } as const;
const signal = () => new AbortController().signal;
const NOTE = 'Windows 平台未做文件系统校验';
let root: string; let cwd: string; let outside: string;

beforeAll(async () => {
  // realpath.native 展开 Windows 8.3 短名（如 RUNNER~1），避免临时目录本身被判为歧义路径。
  root = await mkdtemp(join(realpathSync.native(tmpdir()), 'win-readonly-')); cwd = join(root, 'project'); outside = join(root, 'outside');
  const files: Record<string, string> = { 'src/a.ts': 'export const needle = 1;\n', 'AGENTS.md': '# agents\n', '.env': 'TOKEN=fixture\n', 'mcp.json': '{}\n',
    'src/i18n.key': 'k\n', 'plugins/p.ts': 'export const needle = 2;\n' };
  for (const [name, content] of Object.entries(files)) { await mkdir(dirname(join(cwd, name)), { recursive: true }); await writeFile(join(cwd, name), content); }
  await mkdir(outside); await writeFile(join(outside, 'o.txt'), 'outside\n');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const noRules: SessionRules = { allow: [], ask: [], deny: [] };
async function decide(mode: PermissionMode, name: keyof typeof tools, input: Record<string, unknown>, platform: NodeJS.Platform = 'win32', rules = noRules) {
  const policy = createDeterministicPolicy({ cwd, mode, rules, platform });
  const operation: PolicyInput = { tool: tools[name], input, cwd, configRevision: 'c', policyRevision: 'p' };
  const analysis = await policy.analyzer!.analyze(operation, signal());
  const decision = await policy.decide({ ...operation, analysis }, signal());
  return { kind: decision.kind, reasonCode: decision.reasonCode, reason: decision.reason, analysis };
}
// 逐值替换占位符：Windows 路径含反斜杠，不能拼进 JSON 字符串再解析。
const fill = (input: Record<string, unknown>) => Object.fromEntries(Object.entries(input)
  .map(([key, value]) => [key, typeof value === 'string' ? value.replaceAll('{cwd}', cwd).replaceAll('{outside}', outside) : value]));

describe('原生 Windows：auto/yolo 只读工具走模型审批', () => {
  const reviewCases: Array<[keyof typeof tools, Record<string, unknown>]> = [
    ['read_file', { path: 'src/a.ts' }], ['read_file', { path: '{cwd}/src/a.ts' }], ['read_file', { path: 'AGENTS.md' }],
    ['read_file', { path: 'src/missing.ts' }], ['read_file', { path: 'src' }], ['glob', { pattern: '**/*.ts' }], ['glob', { pattern: '{cwd}/src/*.ts' }],
    ['grep', { pattern: 'needle' }], ['grep', { pattern: 'needle', path: 'src', glob: '*.ts' }],
  ];
  it.each(reviewCases.flatMap(([name, input]) => (['auto', 'yolo'] as const).map((mode) => [mode, name, input] as const)))('%s %s %j → review（ask-model）', async (mode, name, input) => {
    const result = await decide(mode, name, fill(input));
    expect(result).toMatchObject({ kind: 'review', reasonCode: 'platform_read_review' });
    expect(result.reason).toContain(NOTE);
    expect(result.analysis).toMatchObject({ completeness: 'partial', reasonCode: 'native_windows_read_unverified' });
    expect(result.analysis.evidence?.[0]).toMatchObject({ source: 'platform-support' });
    expect(result.analysis.evidence?.[0]?.detail).toContain(NOTE);
  });

  const humanCases: Array<[PermissionMode, keyof typeof tools, Record<string, unknown>, string]> = [
    // 写入、Shell：仍然整体未验证，人工确认
    ['auto', 'write_file', { path: 'src/new.ts', content: 'x' }, 'platform_unverified'],
    ['auto', 'edit_file', { path: 'src/a.ts', old_string: 'needle', new_string: 'pin' }, 'platform_unverified'],
    ['auto', 'bash', { command: 'ls' }, 'platform_unverified'],
    ['auto', 'bash', { command: 'cat src/a.ts' }, 'platform_unverified'],
    ['yolo', 'write_file', { path: 'src/new.ts', content: 'x' }, 'platform_unverified'],
    ['yolo', 'bash', { command: 'ls' }, 'platform_unverified'],
    // ask 模式默认询问
    ['ask', 'read_file', { path: 'src/a.ts' }, 'ask_mode'],
    ['ask', 'glob', { pattern: '**/*.ts' }, 'ask_mode'],
    ['ask', 'grep', { pattern: 'needle' }, 'ask_mode'],
    // 能静态判定的敏感 / 项目外目标
    ['auto', 'read_file', { path: '.env' }, 'sensitive_target'],
    ['auto', 'read_file', { path: 'mcp.json' }, 'sensitive_target'],
    ['auto', 'read_file', { path: 'src/i18n.key' }, 'sensitive_target'],
    ['auto', 'glob', { pattern: '**/*.key' }, 'sensitive_target'],
    ['auto', 'grep', { pattern: 'TOKEN', glob: '.env' }, 'sensitive_target'],
    ['auto', 'read_file', { path: '{outside}/o.txt' }, 'external_target'],
    ['auto', 'read_file', { path: '../outside/o.txt' }, 'external_target'],
    ['auto', 'glob', { pattern: '*', path: '{outside}' }, 'external_target'],
    ['auto', 'grep', { pattern: 'x', path: '..' }, 'external_target'],
    ['yolo', 'read_file', { path: '.env' }, 'sensitive_target'],
    // Windows 特有的歧义路径形态（ADS、8.3 短名、尾随点/空格、设备名、UNC）不交给模型
    ['auto', 'read_file', { path: 'src/a.ts:secret' }, 'platform_unverified'],
    ['auto', 'read_file', { path: 'src/A~1.TS' }, 'platform_unverified'],
    ['auto', 'read_file', { path: 'src/a.ts.' }, 'platform_unverified'],
    ['auto', 'read_file', { path: 'src/a.ts ' }, 'platform_unverified'],
    ['auto', 'read_file', { path: 'NUL' }, 'platform_unverified'],
    ['auto', 'read_file', { path: '//server/share/a.ts' }, 'platform_unverified'],
    ['auto', 'glob', { pattern: 'src/*:*' }, 'platform_unverified'],
  ];
  it.each(humanCases)('%s %s %j → 人工 ask（%s）', async (mode, name, input, reasonCode) => {
    expect(await decide(mode, name, fill(input))).toMatchObject({ kind: 'ask', reasonCode });
  });

  it('用户规则优先：deny 拒绝、ask 人工，均不交给模型', async () => {
    expect(await decide('auto', 'read_file', { path: 'src/a.ts' }, 'win32', { allow: [], ask: [], deny: ['read_file(src/a.ts)'] })).toMatchObject({ kind: 'deny', reasonCode: 'deny_rule' });
    expect(await decide('auto', 'read_file', { path: 'src/a.ts' }, 'win32', { allow: [], ask: ['read_file(src/a.ts)'], deny: [] })).toMatchObject({ kind: 'ask', reasonCode: 'explicit_ask' });
    expect(await decide('auto', 'glob', { pattern: '**/*.ts' }, 'win32', { allow: [], ask: ['glob(**/*.ts)'], deny: [] })).toMatchObject({ kind: 'ask', reasonCode: 'explicit_ask' });
    // 精确 allow 不能把未经文件系统校验的 Windows 读取变成确定性放行
    expect(await decide('auto', 'read_file', { path: 'src/a.ts' }, 'win32', { allow: ['read_file(src/a.ts)'], ask: [], deny: [] })).toMatchObject({ kind: 'review' });
  });

  it('非 Windows 平台行为不变：项目内读取确定性放行', async () => {
    expect(await decide('auto', 'read_file', { path: 'src/a.ts' }, 'linux')).toMatchObject({ kind: 'allow', reasonCode: 'safe_read' });
    expect(await decide('auto', 'write_file', { path: 'src/new.ts', content: 'x' }, 'linux')).toMatchObject({ kind: 'review' });
  });

  it('windowsAmbiguousPath 只拦截歧义形态，不误伤普通盘符绝对路径', () => {
    for (const path of ['C:\\Users\\dingj\\Desktop\\projects\\agent\\src\\a.ts', 'src/a.ts', '../x', '.\\src', '**/*.{ts,tsx}', 'node_modules/.pnpm/zod@1.0.0/x.js']) expect(windowsAmbiguousPath(path)).toBe(false);
    for (const path of ['C:\\x\\.env:stream', 'C:\\PROGRA~1\\x', 'a.', 'a ', 'con', 'COM1.txt', 'lpt9', '\\\\?\\C:\\x', '\\\\server\\share']) expect(windowsAmbiguousPath(path)).toBe(true);
  });
});

describe('原生 Windows 端到端：ToolExecutor 把只读调用交给 reviewer', () => {
  function executor(reviewerDecision: ReviewResult['decision']) {
    const registry = new ToolRegistry(); for (const tool of [tools.read_file, tools.glob, tools.grep, tools.write_file]) registry.register(tool);
    const policy = createDeterministicPolicy({ cwd, mode: 'auto', rules: noRules, platform: 'win32' });
    const events = new EventBus(); const humanRequests: string[] = []; const reviews: ReviewInput[] = [];
    events.on('permission_request', (event) => { humanRequests.push(event.request.toolName); event.resolve({ allow: false }); });
    const reviewer = { review: async (input: ReviewInput): Promise<ReviewResult> => { reviews.push(input); return { decision: reviewerDecision, reasonCode: `model_${reviewerDecision}`, reason: 'fixture' }; } };
    const instance = new ToolExecutor({ tools: registry, policy, reviewer, events, hooks: new HookRunner(), cwd });
    const run = (name: string, input: Record<string, unknown>) => instance.invokeTool(name, input, { signal: signal(), runId: 'win', userRequest: 'explore', messages: [] });
    return { run, humanRequests, reviews };
  }

  it('reviewer allow：read_file/glob/grep 正常执行且零人工审批，reviewer 上下文注明平台未校验', async () => {
    const { run, humanRequests, reviews } = executor('allow');
    expect((await run('read_file', { path: 'src/a.ts' })).content).toContain('needle');
    expect((await run('glob', { pattern: '**/*.ts' })).content).toContain('src/a.ts');
    const grepped = await run('grep', { pattern: 'needle' });
    expect(grepped.content).toContain('src/a.ts'); expect(grepped.content).not.toContain('TOKEN');
    expect(humanRequests).toEqual([]);
    expect(reviews).toHaveLength(3);
    for (const review of reviews) {
      expect(review.decision).toMatchObject({ kind: 'review', reasonCode: 'platform_read_review' });
      expect(review.decision.reason).toContain(NOTE);
      expect(review.analysis?.evidence?.[0]?.detail).toContain(NOTE);
    }
  });

  it('reviewer ask/unknown：回落人工确认；敏感读取与写入不经过 reviewer 直接人工', async () => {
    for (const decision of ['ask', 'unknown'] as const) {
      const { run, humanRequests, reviews } = executor(decision);
      expect((await run('read_file', { path: 'src/a.ts' })).content).not.toContain('needle');
      expect(reviews).toHaveLength(1); expect(humanRequests).toHaveLength(1);
    }
    const { run, humanRequests, reviews } = executor('allow');
    expect((await run('read_file', { path: '.env' })).content).not.toContain('TOKEN');
    await run('write_file', { path: 'src/new.ts', content: 'x' });
    expect(reviews).toHaveLength(0); expect(humanRequests).toHaveLength(2);
  });
});
