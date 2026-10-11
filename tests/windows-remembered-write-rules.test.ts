/**
 * 原生 Windows 写入：用户亲自配置或记住的精确、无通配符规则直接放行 write_file/edit_file；
 * 未命中精确规则的项目内普通写入在 auto/yolo 交给模型审批；敏感/写保护、项目外、硬链接、歧义路径与 ask 模式仍人工。
 * 未验收的 Windows Shell 在 auto 交给 reviewer，精确规则不能直接放行。
 * 通过 platform 注入覆盖 Windows 分支，在所有宿主上运行，不按宿主平台跳过。
 */
import { realpathSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionMode } from '../src/core/config.js';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import {
  createModelReviewer,
  STRICT_REVIEWER_SYSTEM,
} from '../src/builtin/reviewer-model/index.js';
import { EventBus, type PermissionRequest } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import type { SessionRules } from '../src/core/permission/contracts.js';
import type { ChatRequest } from '../src/core/provider.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { FakeProvider, textResponse } from '../src/providers/fake.js';
import type { PolicyInput, ReviewResult } from '../src/sdk/capabilities.js';
import { bashTool } from '../src/tools/bash.js';
import { editFileTool } from '../src/tools/edit.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';

const trusted = (tool: Tool): Tool => ({
  ...tool,
  ownerPlugin: 'agentlab.local-tools',
  version: '1.0.0',
});
const tools = {
  read_file: trusted(readFileTool),
  write_file: trusted(writeFileTool),
  edit_file: trusted(editFileTool),
  bash: trusted(bashTool),
} as const;
const signal = () => new AbortController().signal;
const NOTE = 'Windows 平台未做文件系统校验';
const noRules: SessionRules = { allow: [], ask: [], deny: [] };
let root: string;
let cwd: string;
let outside: string;

beforeAll(async () => {
  // realpath.native 展开 Windows 8.3 短名，避免临时目录本身被判为歧义路径。
  root = await mkdtemp(join(realpathSync.native(tmpdir()), 'win-write-rules-'));
  cwd = join(root, 'project');
  outside = join(root, 'outside');
  const files: Record<string, string> = {
    'src/a.ts': 'export const needle = 1;\n',
    'AGENTS.md': '# agents\n',
    'CLAUDE.md': '# claude\n',
    'agent.config.json': '{}\n',
    'mcp.json': '{}\n',
    '.env': 'TOKEN=fixture\n',
    'plugins/p.ts': 'export {};\n',
    '.git/config': '[core]\n',
    'custom/entry.ts': 'export {};\n',
    'src/hard.ts': 'h\n',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  }
  await mkdir(outside);
  await writeFile(join(outside, 'o.txt'), 'outside\n');
  await writeFile(join(outside, 'victim.txt'), 'victim\n');
  await mkdir(join(cwd, 'docs'));
  await link(join(cwd, 'src/hard.ts'), join(cwd, 'docs/hard-copy.ts'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const rules = (patch: Partial<SessionRules> = {}): SessionRules => ({
  allow: [],
  ask: [],
  deny: [],
  ...patch,
});
const fill = (input: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? value.replaceAll('{cwd}', cwd).replaceAll('{outside}', outside)
        : value,
    ]),
  );
async function decide(
  mode: PermissionMode,
  name: keyof typeof tools,
  raw: Record<string, unknown>,
  ruleSet: SessionRules = noRules,
  extra: { platform?: NodeJS.Platform; writeRoots?: string[]; session?: string[] } = {},
) {
  const policy = createDeterministicPolicy({
    cwd,
    mode,
    rules: ruleSet,
    platform: extra.platform ?? 'win32',
    pluginEntries: ['custom/entry.ts'],
    ...(extra.writeRoots ? { writeRoots: extra.writeRoots } : {}),
  });
  for (const rule of extra.session ?? []) policy.controller!.addSessionRule('allow', rule);
  const operation: PolicyInput = {
    tool: tools[name],
    input: fill(raw),
    cwd,
    configRevision: 'c',
    policyRevision: 'p',
  };
  const analysis = await policy.analyzer!.analyze(operation, signal());
  const decision = await policy.decide({ ...operation, analysis }, signal());
  return {
    kind: decision.kind,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    source: decision.source,
    analysis,
  };
}
const write = (path: string) => ({ path, content: 'x' });

describe('原生 Windows 写入：精确规则直接放行', () => {
  it.each([
    ['auto', 'write_file', write('src/new.ts'), { allow: ['write_file(src/new.ts)'] }],
    ['auto', 'write_file', write('src/new.ts'), { allow: ['write_file(="src/new.ts")'] }],
    ['auto', 'write_file', write('{cwd}/src/new.ts'), { allow: ['write_file(src/new.ts)'] }],
    ['auto', 'write_file', write('src/a.ts'), { allow: ['write_file(src/a.ts)'] }],
    [
      'auto',
      'edit_file',
      { path: 'src/a.ts', old_string: 'needle', new_string: 'pin' },
      { allow: ['edit_file(src/a.ts)'] },
    ],
    ['yolo', 'write_file', write('src/new.ts'), { allow: ['write_file(src/new.ts)'] }],
    ['ask', 'write_file', write('src/new.ts'), { allow: ['write_file(src/new.ts)'] }],
  ] as const)('%s %s %j + %j → allow', async (mode, name, input, patch) => {
    const result = await decide(mode, name, input, rules({ allow: [...patch.allow] }));
    expect(result).toMatchObject({ kind: 'allow', reasonCode: 'exact_allow', source: 'config' });
    expect(result.analysis).toMatchObject({
      completeness: 'complete',
      reasonCode: 'native_windows_write_unverified',
    });
  });

  it('会话中“记住”的精确规则（ToolExecutor 生成的 =JSON 形式）同样放行', async () => {
    expect(
      await decide('ask', 'write_file', write('src/new.ts'), noRules, {
        session: ['write_file(="src/new.ts")'],
      }),
    ).toMatchObject({ kind: 'allow', reasonCode: 'exact_allow', source: 'session' });
    expect(
      await decide('auto', 'write_file', write('src/other.ts'), noRules, {
        session: ['write_file(="src/new.ts")'],
      }),
    ).toMatchObject({ kind: 'review', reasonCode: 'platform_write_review' });
  });
});

describe('原生 Windows 写入：未命中精确规则', () => {
  it.each([
    ['auto', write('src/new.ts'), noRules],
    ['yolo', write('src/new.ts'), noRules],
    ['auto', write('src/a.ts'), noRules],
    ['auto', write('src/deep/new.ts'), noRules],
    // 通配符/工具级规则不能直接放行 Windows 写入，只能交给模型
    ['auto', write('src/new.ts'), rules({ allow: ['write_file'] })],
    ['auto', write('src/new.ts'), rules({ allow: ['write_file(src/*)'] })],
    ['yolo', write('src/new.ts'), rules({ allow: ['write_file(**)'] })],
    ['auto', write('src/new.ts'), rules({ allow: ['write_file(src/new.*)'] })],
  ] as const)('%s %j %j → review（ask-model）', async (mode, input, ruleSet) => {
    const result = await decide(mode, 'write_file', input, ruleSet);
    expect(result).toMatchObject({ kind: 'review', reasonCode: 'platform_write_review' });
    expect(result.reason).toContain(NOTE);
    expect(result.analysis).toMatchObject({
      completeness: 'complete',
      reasonCode: 'native_windows_write_unverified',
    });
    expect(result.analysis.evidence?.[0]).toMatchObject({ source: 'platform-support' });
    expect(result.analysis.evidence?.[0]?.detail).toContain(NOTE);
    // 执行前重验绑定目标路径指纹
    expect(
      Object.keys(result.analysis.environment ?? {}).some(
        (key) => key.startsWith('path:') && (key.endsWith('new.ts') || key.endsWith('a.ts')),
      ),
    ).toBe(true);
  });

  it('ask 模式：无规则或只有通配符规则仍人工', async () => {
    expect(await decide('ask', 'write_file', write('src/new.ts'))).toMatchObject({
      kind: 'ask',
      reasonCode: 'ask_mode',
      source: 'mode',
    });
    expect(
      await decide(
        'ask',
        'write_file',
        write('src/new.ts'),
        rules({ allow: ['write_file(src/*)'] }),
      ),
    ).toMatchObject({ kind: 'ask', reasonCode: 'ask_mode' });
  });

  it('writeRoots 目录授权不是精确规则：Windows 交给模型，Linux 保持确定性放行', async () => {
    expect(
      await decide('auto', 'write_file', write('src/new.ts'), noRules, { writeRoots: ['src'] }),
    ).toMatchObject({ kind: 'review', reasonCode: 'platform_write_review' });
    expect(
      await decide('auto', 'write_file', write('src/new.ts'), noRules, {
        writeRoots: ['src'],
        platform: 'linux',
      }),
    ).toMatchObject({ kind: 'allow', reasonCode: 'scoped_write' });
  });
});

describe('原生 Windows 写入：仍人工的边界（精确规则也不能越过）', () => {
  const exactFor = (path: string, name = 'write_file') =>
    rules({ allow: [`${name}(${path})`, `${name}(="${path}")`] });
  it.each([
    ['.env', 'sensitive_target'],
    ['mcp.json', 'sensitive_target'],
    ['AGENTS.md', 'sensitive_target'],
    ['CLAUDE.md', 'sensitive_target'],
    ['agent.config.json', 'sensitive_target'],
    ['plugins/p.ts', 'sensitive_target'],
    ['plugins/new.ts', 'sensitive_target'],
    ['.git/config', 'sensitive_target'],
    ['custom/entry.ts', 'sensitive_target'],
    ['src/id_rsa', 'sensitive_target'],
    ['src/server.key', 'sensitive_target'],
    ['{outside}/o.txt', 'external_target'],
    ['../outside/new.txt', 'external_target'],
    ['src/hard.ts', 'aliased_target'],
    ['src/a.ts:stream', 'platform_unverified'],
    ['NUL', 'platform_unverified'],
    ['src/A~1.TS', 'platform_unverified'],
    ['src/new.ts.', 'platform_unverified'],
    ['src/new.ts ', 'platform_unverified'],
    ['//server/share/x.ts', 'platform_unverified'],
    ['\\\\?\\C:\\x.ts', 'platform_unverified'],
  ] as const)('%s → 人工 ask（%s）', async (path, reasonCode) => {
    for (const mode of ['auto', 'yolo'] as const) {
      expect(
        await decide(mode, 'write_file', write(path), exactFor(fill({ path }).path as string)),
      ).toMatchObject({ kind: 'ask', reasonCode });
    }
    expect(
      await decide(
        'auto',
        'edit_file',
        { path, old_string: 'a', new_string: 'b' },
        exactFor(fill({ path }).path as string, 'edit_file'),
      ),
    ).toMatchObject({ kind: 'ask', reasonCode });
  });

  it('未验收的 Windows Shell：auto 交给 reviewer，ask/yolo 仍人工，精确规则不直接放行', async () => {
    const allowed = rules({ allow: ['bash(echo one)', 'bash(="echo one")'] });
    expect(await decide('auto', 'bash', { command: 'echo one' }, allowed)).toMatchObject({
      kind: 'review',
      reasonCode: 'review_uncertain',
    });
    expect(await decide('yolo', 'bash', { command: 'echo one' }, allowed)).toMatchObject({
      kind: 'ask',
      reasonCode: 'unknown_ask',
    });
    expect(await decide('ask', 'bash', { command: 'echo one' }, allowed)).toMatchObject({
      kind: 'ask',
      reasonCode: 'ask_mode',
    });
  });

  it('读文件类 PowerShell 直接拒绝，精确 allow 也不能改成执行或人工确认', async () => {
    for (const mode of ['auto', 'yolo', 'ask'] as const) {
      expect(
        await decide(
          mode,
          'bash',
          { command: 'Get-Content package.json -Raw' },
          rules({ allow: ['bash(Get-Content package.json -Raw)'] }),
        ),
      ).toMatchObject({ kind: 'deny', reasonCode: 'use_dedicated_tool' });
    }
  });

  it('用户规则优先：deny 拒绝，ask 人工，即使同时有精确 allow', async () => {
    expect(
      await decide(
        'auto',
        'write_file',
        write('src/new.ts'),
        rules({ allow: ['write_file(src/new.ts)'], deny: ['write_file(src/new.ts)'] }),
      ),
    ).toMatchObject({ kind: 'deny', reasonCode: 'deny_rule' });
    expect(
      await decide(
        'yolo',
        'write_file',
        write('src/new.ts'),
        rules({ allow: ['write_file(src/new.ts)'], deny: ['write_file(src/*)'] }),
      ),
    ).toMatchObject({ kind: 'deny', reasonCode: 'deny_rule' });
    expect(
      await decide(
        'auto',
        'write_file',
        write('src/new.ts'),
        rules({ allow: ['write_file(src/new.ts)'], ask: ['write_file(src/new.ts)'] }),
      ),
    ).toMatchObject({ kind: 'ask', reasonCode: 'explicit_ask' });
  });
});

describe('非 Windows 平台写入行为不变', () => {
  it.each([
    ['auto', noRules, { kind: 'review', reasonCode: 'review_uncertain' }],
    [
      'auto',
      rules({ allow: ['write_file(src/new.ts)'] }),
      { kind: 'allow', reasonCode: 'exact_allow' },
    ],
    [
      'auto',
      rules({ allow: ['write_file(src/*)'] }),
      { kind: 'review', reasonCode: 'review_uncertain' },
    ],
    ['yolo', noRules, { kind: 'allow', reasonCode: 'yolo_complete' }],
    ['ask', noRules, { kind: 'ask', reasonCode: 'ask_mode' }],
  ] as const)('linux %s %j → %j', async (mode, ruleSet, expected) => {
    const result = await decide(mode, 'write_file', write('src/new.ts'), ruleSet, {
      platform: 'linux',
    });
    expect(result).toMatchObject(expected);
    expect(result.analysis.reasonCode).not.toBe('native_windows_write_unverified');
  });
  it('linux 敏感写入与 bash 语义不变', async () => {
    expect(
      await decide(
        'yolo',
        'write_file',
        write('AGENTS.md'),
        rules({ allow: ['write_file(AGENTS.md)'] }),
        { platform: 'linux' },
      ),
    ).toMatchObject({ kind: 'ask', reasonCode: 'sensitive_target' });
    // bash 只读放行依赖宿主上的真实 POSIX 解释器/命令解析，Windows 宿主上注入 linux 不能证明该项（同 deterministic-policy 的宿主相关用例）
    if (process.platform !== 'win32')
      expect(
        await decide('auto', 'bash', { command: 'pwd' }, noRules, { platform: 'linux' }),
      ).toMatchObject({ kind: 'allow' });
  });
});

describe('原生 Windows 写入：真实审查合约（非 stub）', () => {
  const allowText = JSON.stringify({
    decision: 'allow',
    reasonCode: 'task_scoped_write',
    reason: '项目内普通文件写入符合当前要求',
  });
  const knowledge = () => ({ contextWindow: 128_000, maxOutputTokens: 8192 });
  const body = (request: ChatRequest) => JSON.parse(request.messages[0]!.content as string);

  it('交给真实 reviewer 的写入分析为 complete，不触发提示词中的不完整规则，合约接受 allow', async () => {
    expect(STRICT_REVIEWER_SYSTEM).toContain('分析不完整或证据不足时返回 ask 或 unknown');
    const policy = createDeterministicPolicy({
      cwd,
      mode: 'auto',
      rules: noRules,
      platform: 'win32',
    });
    const operation: PolicyInput = {
      tool: tools.write_file,
      input: write('src/reviewed.ts'),
      cwd,
      configRevision: 'c',
      policyRevision: 'p',
    };
    const analysis = await policy.analyzer!.analyze(operation, signal());
    const decision = await policy.decide({ ...operation, analysis }, signal());
    const provider = new FakeProvider([textResponse(allowText)]);
    const result = await createModelReviewer({
      provider,
      model: 'reviewer',
      modelInfo: knowledge,
    }).review(
      { ...operation, analysis, decision, userRequest: '在 src/reviewed.ts 写入 x' },
      signal(),
    );
    expect(result).toMatchObject({ decision: 'allow', reasonCode: 'task_scoped_write' });
    const sent = body(provider.requests[0]!);
    expect(provider.requests[0]!.system).toBe(STRICT_REVIEWER_SYSTEM);
    expect(sent.analysis).toMatchObject({
      completeness: 'complete',
      reasonCode: 'native_windows_write_unverified',
    });
    expect(
      sent.analysis.effects.every(
        (effect: { kind: string; scope: string }) =>
          effect.kind === 'write' && effect.scope === 'project',
      ),
    ).toBe(true);
    expect(JSON.stringify(sent.analysis.evidence)).toContain(NOTE);
    expect(sent.policy.decision).toMatchObject({
      kind: 'review',
      reasonCode: 'platform_write_review',
    });
  });
});

describe('原生 Windows 写入端到端（ToolExecutor）', () => {
  function setup(
    mode: PermissionMode,
    reviewer?: { review: (...args: never[]) => Promise<ReviewResult> },
    responder?: (request: PermissionRequest) => { allow: boolean; remember?: 'session' },
  ) {
    const registry = new ToolRegistry();
    for (const tool of Object.values(tools)) registry.register(tool);
    const policy = createDeterministicPolicy({ cwd, mode, rules: noRules, platform: 'win32' });
    const events = new EventBus();
    const requests: PermissionRequest[] = [];
    events.on('permission_request', (event) => {
      requests.push(event.request);
      event.resolve(responder ? responder(event.request) : { allow: false });
    });
    const executor = new ToolExecutor({
      tools: registry,
      policy,
      events,
      hooks: new HookRunner(),
      cwd,
      ...(reviewer ? { reviewer: reviewer as never } : {}),
    });
    const run = (name: string, input: Record<string, unknown>) =>
      executor.invokeTool(name, input, {
        signal: signal(),
        runId: 'win-write',
        userRequest: '修改项目文件',
        messages: [],
      });
    return { run, requests, policy };
  }

  it('真实模型 reviewer allow：未命中规则的写入零人工执行', async () => {
    const provider = new FakeProvider([
      textResponse(
        JSON.stringify({ decision: 'allow', reasonCode: 'task_scoped_write', reason: '符合要求' }),
      ),
    ]);
    const { run, requests } = setup(
      'auto',
      createModelReviewer({
        provider,
        model: 'reviewer',
        modelInfo: () => ({ contextWindow: 128_000, maxOutputTokens: 8192 }),
      }),
    );
    expect((await run('write_file', write('src/e2e.ts'))).isError).toBeFalsy();
    expect(await readFile(join(cwd, 'src/e2e.ts'), 'utf8')).toBe('x');
    expect(requests).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it('reviewer ask：回落人工；拒绝后不写入', async () => {
    const { run, requests } = setup('auto', {
      review: async () => ({ decision: 'ask', reasonCode: 'model_ask', reason: 'fixture' }),
    });
    await run('write_file', write('src/refused.ts'));
    expect(requests).toHaveLength(1);
    await expect(readFile(join(cwd, 'src/refused.ts'), 'utf8')).rejects.toThrow();
  });

  it('ask 模式“允许并记住”：同一目标第二次写入不再询问', async () => {
    const { run, requests, policy } = setup('ask', undefined, () => ({
      allow: true,
      remember: 'session',
    }));
    await run('write_file', { path: 'src/remember.ts', content: '1' });
    await run('write_file', { path: 'src/remember.ts', content: '2' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ decisionSource: 'mode', reasonCode: 'ask_mode' });
    expect(policy.controller!.getSessionRules().allow).toEqual(['write_file(="src/remember.ts")']);
    expect(await readFile(join(cwd, 'src/remember.ts'), 'utf8')).toBe('2');
  });

  it('auto 下未验收 Shell 先交给 reviewer；没有 reviewer 才回到人工', async () => {
    const { run, requests } = setup('auto', undefined, () => ({ allow: false }));
    await run('bash', { command: 'echo one' });
    await run('bash', { command: 'echo one' });
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.reasonCode === 'reviewer_unavailable')).toBe(true);
    expect(
      requests.every((request) => request.policyReasonCode === 'review_uncertain'),
    ).toBe(true);
    expect(
      requests.every((request) => request.analysisReasonCode === 'native_windows_shell_unverified'),
    ).toBe(true);
  });

  it('reviewer 允许未验收 Shell 后直接执行，不再改成人工', async () => {
    const { run, requests } = setup('auto', {
      review: async () => ({ decision: 'allow', reasonCode: 'task_scoped', reason: 'fixture' }),
    });
    const result = await run('bash', { command: 'echo one' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('one');
    expect(requests).toEqual([]);
  });

  it('执行前重验仍绑定：模型批准后目标被替换为指向项目外的硬链接，不会写穿到外部文件', async () => {
    const target = join(cwd, 'src/bound.ts');
    const reviewer = {
      review: async () => {
        await link(join(outside, 'victim.txt'), target);
        return { decision: 'allow' as const, reasonCode: 'model_allow', reason: 'fixture' };
      },
    };
    const { run, requests } = setup('auto', reviewer);
    const result = await run('write_file', { path: 'src/bound.ts', content: 'OVERWRITTEN' });
    expect(result.isError).toBe(true);
    // 重验发现目标变成多硬链接别名，重新评估为不可降级的人工确认（测试 responder 拒绝）
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reasonCode: 'aliased_target' });
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('victim\n');
  });
});
