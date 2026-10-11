/** Linux 可运行的 Windows 分支回归：真实分析/策略/ModelReviewer/Executor，Shell 仅用无副作用执行替身。 */
import { realpathSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import {
  createModelReviewer,
  STRICT_REVIEWER_SYSTEM,
} from '../src/builtin/reviewer-model/index.js';
import { canRememberPermission } from '../src/cli/app.js';
import type { PermissionMode } from '../src/core/config.js';
import { EventBus, type PermissionRequest, type UserDecision } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import type { SessionRules } from '../src/core/permission/contracts.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { FakeProvider, textResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { bashTool } from '../src/tools/bash.js';
import { createGlobTool } from '../src/tools/glob.js';
import { createGrepTool } from '../src/tools/grep.js';
import { parsePowerShell } from '../src/tools/powershell.js';
import { readFileTool } from '../src/tools/read.js';

let root: string;
let cwd: string;
let outside: string;
const signal = () => new AbortController().signal;
const trusted = (tool: Tool): Tool => ({
  ...tool,
  ownerPlugin: 'agentlab.local-tools',
  version: '1.0.0',
});
beforeAll(async () => {
  root = await mkdtemp(join(realpathSync.native(tmpdir()), 'ps-chain-'));
  cwd = join(root, 'project');
  outside = join(root, 'outside');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(outside);
  for (const [name, content] of [
    ['src/input.txt', 'needle'],
    ['src/custom.ts', 'fixture'],
    ['.env', 'fixture-secret'],
    ['AGENTS.md', '# fixture'],
    ['mcp.json', '{}'],
  ])
    await writeFile(join(cwd, name!), content!);
  await writeFile(join(outside, 'sentinel.txt'), 'outside-sentinel');
  await symlink(join(outside, 'sentinel.txt'), join(cwd, 'src/external-link.txt'));
  await link(join(cwd, 'src/input.txt'), join(cwd, 'src/hardlink.txt'));
  await writeFile(join(cwd, 'src/ordinary.txt'), 'ordinary');
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const response = (decision: 'allow' | 'ask' | 'unknown' | 'deny'): ScriptedResponse =>
  textResponse(
    JSON.stringify({
      decision,
      reasonCode: `model_${decision}`,
      reason: '受控 provider 的协议判决',
    }),
  );
// 检查真正送入内置严格 reviewer 的完整证据；不以不看请求的 reviewer allow stub 证明可用性。
const verifiedAllow: ScriptedResponse = (request) => {
  expect(request.system).toBe(STRICT_REVIEWER_SYSTEM);
  expect(request.tools).toEqual([]);
  const data = JSON.parse(request.messages[0]!.content as string);
  expect(data.analysis.completeness).toBe('complete');
  expect(data.analysis.effects.length).toBeGreaterThan(0);
  expect(
    data.analysis.effects.every((effect: { scope: string }) => effect.scope === 'project'),
  ).toBe(true);
  expect(data.analysis.evidence[0].source).toBe('powershell-ast');
  expect(data.analysis.environment.$powershellCommand).toMatch(
    /Microsoft\.PowerShell\.(Management|Utility)\\/,
  );
  expect(data.policy.decision.kind).toBe('review');
  expect(data.currentUserRequest.text).toBe(
    '按明确要求读取项目普通文件并修改 src/ordinary.txt；不修改凭据或项目外文件',
  );
  return response('allow') as ReturnType<typeof textResponse>;
};
function setup(
  options: {
    mode?: PermissionMode;
    script?: ScriptedResponse;
    unavailable?: boolean;
    timeout?: boolean;
    rules?: Partial<SessionRules>;
    respond?: (request: PermissionRequest) => UserDecision | Promise<UserDecision>;
    beforeResponse?: () => Promise<void>;
  } = {},
) {
  const execute = vi.fn(async () => ({ content: 'SAFE_EXECUTION_DOUBLE' }));
  const shell = trusted({ ...bashTool, execute });
  const tools = new ToolRegistry();
  for (const tool of [
    shell,
    trusted(readFileTool),
    trusted(createGlobTool()),
    trusted(createGrepTool()),
  ])
    tools.register(tool);
  const policy = createDeterministicPolicy({
    cwd,
    platform: 'win32',
    mode: options.mode ?? 'auto',
    rules: { allow: [], ask: [], deny: [], ...options.rules },
    pluginEntries: ['src/custom.ts'],
  });
  const provider = new FakeProvider([options.script ?? verifiedAllow]);
  if (options.beforeResponse) {
    const stream = provider.stream.bind(provider);
    provider.stream = async function* (request, abort) {
      await options.beforeResponse!();
      yield* stream(request, abort);
    };
  }
  if (options.timeout)
    provider.stream = async function* (request, abort) {
      this.requests.push(structuredClone(request));
      await new Promise<void>((resolve) => {
        if (abort.aborted) resolve();
        else abort.addEventListener('abort', () => resolve(), { once: true });
      });
    };
  const reviewer = options.unavailable
    ? undefined
    : createModelReviewer({
        provider,
        model: 'controlled-protocol',
        timeoutMs: options.timeout ? 5 : 30_000,
        modelInfo: () => ({ contextWindow: 128_000, maxOutputTokens: 8192 }),
      });
  const requests: PermissionRequest[] = [];
  const events = new EventBus();
  events.on('permission_request', async (event) => {
    requests.push(event.request);
    event.resolve(await (options.respond?.(event.request) ?? { allow: false }));
  });
  const executor = new ToolExecutor({
    cwd,
    tools,
    policy,
    reviewer,
    events,
    hooks: new HookRunner(),
  });
  const runTool = (name: string, input: Record<string, unknown>) =>
    executor.invokeTool(name, input, {
      signal: signal(),
      runId: 'powershell-chain',
      userRequest: '按明确要求读取项目普通文件并修改 src/ordinary.txt；不修改凭据或项目外文件',
      messages: [],
    });
  const analyze = async (command: string) => {
    const operation = { cwd, tool: shell, input: { command } };
    const analysis = await policy.analyzer!.analyze(operation, signal());
    return { analysis, decision: await policy.decide({ ...operation, analysis }, signal()) };
  };
  return {
    run: (command: string) => runTool('bash', { command }),
    runTool,
    analyze,
    requests,
    execute,
    provider,
    policy,
  };
}

describe('PowerShell 的实际目标与别名不能被模型 allow 降级', () => {
  const sensitive = [
    'Set-Content .env secret',
    'sc -Value secret -PSPath .env',
    'Add-Content -Force -Path .env -Value secret',
    'clc -Path .env',
    'ri -Force .env',
    'echo secret > .env',
    'Write-Output secret | of .env',
    'Get-Content .env; echo done',
    'cp .env src/ordinary.txt',
    'mi src/ordinary.txt .env',
    'ni -Path .env -ItemType File -Value secret',
    'Set-Content AGENTS.md injected',
    'sc src/custom.ts injected',
    'echo ok; Set-Content mcp.json injected',
    'Test-Path .env',
  ];
  it.each(sensitive)('%s 分类为 sensitive；provider 永远不被调用', async (command) => {
    const h = setup({ script: response('allow') });
    const { analysis, decision } = await h.analyze(command);
    expect(analysis.effects.some((effect) => effect.scope === 'sensitive')).toBe(true);
    expect(decision).toMatchObject({ kind: 'ask', reasonCode: 'sensitive_target' });
    expect((await h.run(command)).isError).toBe(true);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.summary).toBe(`PowerShell: ${command}`);
  });
  it.each([
    'sc -Value x -Path ../outside/sentinel.txt',
    'Remove-Item C:\\Users\\other\\file',
    'Copy-Item src/ordinary.txt ../outside/sentinel.txt',
    'Move-Item ../outside/sentinel.txt src/ordinary.txt',
    'echo x >> ../outside/sentinel.txt',
    'Set-Content src/external-link.txt x',
  ])('%s 分类为 external', async (command) => {
    const h = setup({ script: response('allow') });
    expect(
      (await h.analyze(command)).analysis.effects.some((effect) => effect.scope === 'external'),
    ).toBe(true);
    expect((await h.run(command)).isError).toBe(true);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requests[0]).toMatchObject({ reasonCode: 'external_target' });
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside-sentinel');
  });
  it.each([
    'rm -Recurse C:\\',
    'rd C:\\ -r',
    'Remove-Item C:\\ -Recurse',
    'DEL -Path:C:\\ -Recurse:$true -Confirm:$false',
    'Microsoft.PowerShell.Management\\Remove-Item -Recurse -Path C:/',
    'rmdir -Fo -Rec C:\\',
  ])('%s 通过语义识别根删除', async (command) => {
    for (const mode of ['auto', 'yolo'] as const) {
      const h = setup({
        mode,
        script: response('allow'),
        rules: { allow: [`bash(=${JSON.stringify(command)})`] },
      });
      const { analysis, decision } = await h.analyze(command);
      expect(analysis.reasonCode).toBe('shell_dangerous');
      expect(decision.kind).toBe('ask');
      expect((await h.run(command)).isError).toBe(true);
      expect(h.provider.requests).toHaveLength(0);
      expect(h.execute).not.toHaveBeenCalled();
    }
  });
  it('canonical deny/ask 保持 Windows 路径大小写限制，并压过精确 allow', async () => {
    for (const kind of ['deny', 'ask'] as const) {
      const command = 'sc -Value ok -Path src/ordinary.txt';
      const h = setup({
        rules: { [kind]: ['bash(SRC/ORDINARY.TXT)'], allow: [`bash(=${JSON.stringify(command)})`] },
      });
      expect((await h.analyze(command)).decision).toMatchObject({
        kind,
        reasonCode: kind === 'deny' ? 'deny_rule' : 'explicit_ask',
      });
      await h.run(command);
      expect(h.provider.requests).toHaveLength(0);
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.requests).toHaveLength(kind === 'deny' ? 0 : 1);
    }
  });
});

describe('真正未知语义直接人工，精确 allow/yolo/provider 都不能补成完整分析', () => {
  it.each([
    'Set-Content $path x',
    'Set-Content "$env:USERPROFILE/x" y',
    'Set-Content $(Get-Location) x',
    'Set-Content @args',
    'Set-Content a,b x',
    'Set-Content src/a` b.txt x',
    "Set-Content src/a'b'.txt x",
    'Set-Content “.env” secret',
    "sc '`.env' secret",
    '& "Remove-Item" C:\\ -r',
    'Set-Alias rm Get-Content; rm src/ordinary.txt',
    'function Get-Content { echo x }; Get-Content src/ordinary.txt',
    'Get-ChildItem | Where-Object { $_.Name -eq "a" }',
    'git status',
    'git log --oneline',
    'npm test',
    'sc -Path src/ordinary.txt -Value x -Stream secret',
    'sc -Path src/ordinary.txt -Value x -f',
    'sc -Path src/ordinary.txt -Path .env -Value x',
    'Remove-Item -r src',
    'Test-Path Env:PATH',
    'sc ~/ordinary.txt x',
    'sc C:ordinary.txt x',
    'sc "src/*.txt" x',
    'Write-Output .env | Remove-Item',
    'Get-Item src/ordinary.txt | Select-Object -ExpandProperty Directory | Select-Object -ExpandProperty Parent | Out-File src/ordinary.txt',
    'pwd | Select-Object -ExpandProperty Drive | Select-Object Used | Out-File src/ordinary.txt',
    'ni -ItemType File -Path src/new.txt | Select-Object Directory | Out-File src/ordinary.txt',
    'sc -LiteralPath NUL -Value x',
    'sc -Path "src/a.txt:secret" -Value x',
    'sc -Path "src/ordinary.txt." -Value x',
    'ni -Path src/new -ItemType SymbolicLink -Value .env',
    'echo "unterminated',
    'Test-Path –IsValid',
    'echo ok && echo done',
  ])('%s 无副作用', async (command) => {
    const h = setup({
      mode: 'yolo',
      script: response('allow'),
      rules: { allow: [`bash(=${JSON.stringify(command)})`] },
    });
    const { analysis, decision } = await h.analyze(command);
    expect(analysis.completeness).not.toBe('complete');
    expect(decision.kind).toBe('ask');
    expect((await h.run(command)).isError).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.requests[0]!.summary).toBe(`PowerShell: ${command}`);
  });
  it('硬链接不交给 reviewer', async () => {
    const h = setup();
    await h.run('sc src/hardlink.txt x');
    expect(h.requests[0]).toMatchObject({ reasonCode: 'aliased_target' });
    expect(h.provider.requests).toHaveLength(0);
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('PR #36 的精确记住与审批复用不降低 PowerShell 约束', () => {
  it.each(['echo PS_REMEMBERED', 'sc src/ordinary.txt remembered'])(
    '%s 完整调用可以记住，下一次相同命令不再询问，其他命令仍需审批',
    async (command) => {
      const h = setup({ mode: 'ask', respond: () => ({ allow: true, remember: 'session' }) });
      expect((await h.run(command)).isError).toBeFalsy();
      expect(h.requests).toHaveLength(1);
      expect(canRememberPermission(h.requests[0]!)).toBe(true);
      expect((await h.run(command)).isError).toBeFalsy();
      expect(h.requests).toHaveLength(1);
      expect((await h.analyze(command)).decision.reasonCode).toBe('exact_call_allow');
      await h.run('echo DIFFERENT_CALL');
      expect(h.requests).toHaveLength(2);
      expect(h.provider.requests).toHaveLength(0);
      expect(h.execute).toHaveBeenCalledTimes(3);
    },
  );
  it('完整写入的 ModelReviewer ask 后可记住精确命令，不能扩大到其他目标', async () => {
    const command = 'sc src/ordinary.txt remembered';
    const h = setup({
      script: response('ask'),
      respond: () => ({ allow: true, remember: 'session' }),
    });
    expect((await h.run(command)).isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect(canRememberPermission(h.requests[0]!)).toBe(true);
    expect((await h.run(command)).isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect(h.provider.requests).toHaveLength(1);
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect((await h.analyze('sc .env remembered')).decision.reasonCode).toBe('sensitive_target');
  });
  it.each([
    ['sc .env x', 'sensitive_target'],
    ['sc ../outside/sentinel.txt x', 'external_target'],
    ['sc src/ordinary.txt. x', 'platform_unverified'],
    ['sc src/hardlink.txt x', 'aliased_target'],
    ['Set-Content $path x', 'powershell_unknown'],
    ['git status', 'powershell_unknown'],
  ])('精确记住规则不能放行 %s', async (command, reasonCode) => {
    for (const mode of ['ask', 'auto', 'yolo'] as const) {
      const h = setup({ mode, rules: { allow: [`bash(=${JSON.stringify(command)})`] } });
      expect((await h.run(command)).isError).toBe(true);
      expect(h.requests[0]).toMatchObject({ reasonCode });
      expect(canRememberPermission(h.requests[0]!)).toBe(false);
      expect(h.provider.requests).toHaveLength(0);
      expect(h.execute).not.toHaveBeenCalled();
    }
  });
  it('其他记住规则只改变 policyRevision 时，本次批准复用且不跨调用复用', async () => {
    const h = setup({
      mode: 'ask',
      respond: () => {
        h.policy.controller!.addSessionRule('allow', 'bash(="echo OTHER_CALL")');
        return { allow: true };
      },
    });
    expect((await h.run('sc src/ordinary.txt ok')).isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect(h.execute).toHaveBeenCalledOnce();
    expect((await h.run('sc src/ordinary.txt ok')).isError).toBeFalsy();
    expect(h.requests).toHaveLength(2);
    expect(h.provider.requests).toHaveLength(0);
  });
  it('人工批准时目标换成外部链接，审批复用不能掩盖分析变化', async () => {
    const path = join(cwd, 'src/human-rebind.txt');
    await writeFile(path, 'before');
    let answers = 0;
    const h = setup({
      mode: 'ask',
      respond: async () => {
        if (answers++ > 0) return { allow: false };
        await unlink(path);
        await symlink(join(outside, 'sentinel.txt'), path);
        return { allow: true };
      },
    });
    expect((await h.run('sc src/human-rebind.txt x')).isError).toBe(true);
    expect(h.requests.map((request) => request.reasonCode)).toEqual([
      'ask_mode',
      'external_target',
    ]);
    expect(h.provider.requests).toHaveLength(0);
    expect(h.execute).not.toHaveBeenCalled();
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside-sentinel');
  });
});

describe('完整分析可以真正使用内置 ModelReviewer，协议结果仍由 Executor 控制', () => {
  it.each([
    'Set-Content src/ordinary.txt ok',
    'sc -Value ok -LiteralPath src/ordinary.txt -Encoding UTF8',
    'sc -Force:$false -Path:src/ordinary.txt -Value:ok',
    'echo ok',
    'echo "Stop-Computer"',
    'echo 123 | Select-Object Length',
    'sc -Value:$false -Path src/ordinary.txt',
    "sc src/ordinary.txt 'git push origin HEAD --force'",
    'Write-Output ok | Out-File src/ordinary.txt',
    "sc -LiteralPath 'src/o''k.txt' -Value 'value;# literal'",
    'echo ok > src/ordinary.txt',
    'Test-Path src/ordinary.txt; sc src/ordinary.txt ok',
  ])('%s 完整证据允许一次替身执行', async (command) => {
    const h = setup();
    const { analysis, decision } = await h.analyze(command);
    expect(analysis.completeness).toBe('complete');
    expect(decision.kind).toBe('review');
    expect((await h.run(command)).content).toBe('SAFE_EXECUTION_DOUBLE');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.requests).toEqual([]);
  });
  it.each(['ask', 'unknown', 'deny'] as const)(
    '%s 保持严格语义，deny 不询问，即使人工替身愿意允许',
    async (decision) => {
      const h = setup({
        script: response(decision),
        respond: () => ({ allow: decision === 'deny' }),
      });
      expect((await h.run('sc src/ordinary.txt ok')).isError).toBe(true);
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.provider.requests).toHaveLength(1);
      expect(h.requests).toHaveLength(decision === 'deny' ? 0 : 1);
      if (decision !== 'deny')
        expect(h.requests[0]).toMatchObject({
          reasonCode: `model_${decision}`,
          policyReasonCode: 'powershell_write_review',
          analysisReasonCode: 'powershell_file_operation',
          summary: 'PowerShell: sc src/ordinary.txt ok',
        });
    },
  );
  it.each([
    ['invalid_response', textResponse('{"decision":"allow"}')],
    [
      'incomplete_response',
      (response('allow') as ReturnType<typeof textResponse>).map((event) =>
        event.type === 'message_stop' ? { ...event, stopReason: 'max_tokens' as const } : event,
      ),
    ],
    [
      'provider_error',
      () => {
        throw new Error('controlled failure');
      },
    ],
  ] as Array<[string, ScriptedResponse]>)(
    '%s 回退人工并展示 PowerShell',
    async (reasonCode, script) => {
      const h = setup({ script });
      await h.run('echo ok');
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.requests[0]).toMatchObject({ reasonCode, summary: 'PowerShell: echo ok' });
      expect(canRememberPermission(h.requests[0]!)).toBe(true);
    },
  );
  it('缺少 reviewer 同样回退，ask 模式直接询问', async () => {
    for (const mode of ['ask', 'auto'] as const) {
      const h = setup({ mode, unavailable: true });
      await h.run('echo ok');
      expect(h.requests[0]).toMatchObject({
        reasonCode: mode === 'ask' ? 'ask_mode' : 'reviewer_unavailable',
        summary: 'PowerShell: echo ok',
      });
      expect(h.execute).not.toHaveBeenCalled();
    }
  });
  it('yolo 的完整普通 PowerShell 写入仍经过 ModelReviewer；精确原命令授权可用', async () => {
    const command = 'sc src/ordinary.txt ok';
    const h = setup({ mode: 'yolo' });
    expect((await h.run(command)).content).toBe('SAFE_EXECUTION_DOUBLE');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.requests).toEqual([]);
    const exact = setup({ mode: 'ask', rules: { allow: [`bash(=${JSON.stringify(command)})`] } });
    expect((await exact.run(command)).isError).toBeFalsy();
    expect(exact.provider.requests).toHaveLength(0);
    expect(exact.requests).toEqual([]);
  });
  it('真实 ModelReviewer 超时回到人工，不执行替身', async () => {
    const h = setup({ timeout: true });
    await h.run('sc src/ordinary.txt ok');
    expect(h.requests[0]).toMatchObject({
      reasonCode: 'timeout',
      summary: 'PowerShell: sc src/ordinary.txt ok',
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.provider.requests).toHaveLength(1);
  });
  it('分析绑定的目标在 reviewer 期间换成外部链接，批准失效并改为人工', async () => {
    const path = join(cwd, 'src/rebind.txt');
    await writeFile(path, 'before');
    const h = setup({
      beforeResponse: async () => {
        await unlink(path);
        await symlink(join(outside, 'sentinel.txt'), path);
      },
    });
    await h.run('sc src/rebind.txt ok');
    expect(h.provider.requests).toHaveLength(1);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requests[0]).toMatchObject({ reasonCode: 'external_target' });
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside-sentinel');
  });
  it.each(['ask', 'auto', 'yolo'] as const)(
    '%s 保留 PR #30/#36 的真实 read_file/glob/grep，零 reviewer/人工',
    async (mode) => {
      const h = setup({ mode });
      expect((await h.runTool('read_file', { path: 'src/ordinary.txt' })).content).toContain(
        'ordinary',
      );
      expect((await h.runTool('glob', { pattern: 'src/ordinary.txt' })).content).toContain(
        'src/ordinary.txt',
      );
      expect(
        (await h.runTool('grep', { pattern: 'ordinary', path: 'src', glob: 'ordinary.txt' }))
          .content,
      ).toContain('ordinary.txt:1:ordinary');
      expect(h.provider.requests).toHaveLength(0);
      expect(h.requests).toEqual([]);
    },
  );
  it('Test-Path 和 Get-Location 普通元数据读取可直接放行，纯文件 Shell 仍引导专用工具', async () => {
    const h = setup();
    for (const command of [
      'Test-Path src/ordinary.txt',
      'pwd',
      'Get-Location; Test-Path src/ordinary.txt',
    ])
      expect((await h.run(command)).isError).toBeFalsy();
    expect(h.provider.requests).toHaveLength(0);
    expect(h.requests).toEqual([]);
    expect((await h.run('Get-Content src/ordinary.txt -Raw')).content).toContain('read_file');
    expect(h.execute).toHaveBeenCalledTimes(3);
  });
  it('参数规范化后的执行命令与 AST 契约一致', () => {
    const parsed = parsePowerShell('sc -Value "value; text" -PSPath "src/a b.txt" -Force:$false');
    expect(parsed.complete).toBe(true);
    expect(parsed.command).toBe(
      "Microsoft.PowerShell.Management\\Set-Content -Value 'value; text' -LiteralPath 'src/a b.txt' -Force:$false",
    );
    const rebuilt = parsePowerShell(parsed.command!);
    expect(rebuilt.complete).toBe(true);
    expect(rebuilt.pipelines).toEqual(parsed.pipelines);
  });
  it.skipIf(process.platform !== 'win32')(
    '原生 Windows 才能实测：完整受控 PowerShell 输出与元数据读取',
    async () => {
      const h = setup();
      const tools = new ToolRegistry();
      tools.register(trusted(bashTool));
      const executor = new ToolExecutor({
        cwd,
        tools,
        policy: h.policy,
        reviewer: createModelReviewer({
          provider: h.provider,
          model: 'controlled-protocol',
          modelInfo: () => ({ contextWindow: 128_000, maxOutputTokens: 8192 }),
        }),
        events: new EventBus(),
        hooks: new HookRunner(),
      });
      for (const [command, expected] of [
        ['echo PS_CONTRACT_SENTINEL', 'PS_CONTRACT_SENTINEL'],
        ['Test-Path src/ordinary.txt', 'True'],
      ]) {
        const result = await executor.invokeTool(
          'bash',
          { command },
          {
            signal: signal(),
            runId: 'native-safe-powershell',
            userRequest:
              '按明确要求读取项目普通文件并修改 src/ordinary.txt；不修改凭据或项目外文件',
            messages: [],
          },
        );
        expect(result.isError).toBeFalsy();
        expect(result.content).toContain(expected);
      }
    },
  );
});
