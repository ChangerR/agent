/** 真实策略 → 模型 reviewer → ToolExecutor 事件 → CLI 选项，全部使用离线 FakeProvider。 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { createModelReviewer } from '../src/builtin/reviewer-model/index.js';
import { canRememberPermission } from '../src/cli/app.js';
import type { PermissionMode } from '../src/core/config.js';
import { EventBus, type PermissionRequest, type UserDecision } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import type { StreamEvent } from '../src/core/protocol/types.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { FakeProvider, textResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { editFileTool } from '../src/tools/edit.js';
import { createGlobTool } from '../src/tools/glob.js';
import { createGrepTool } from '../src/tools/grep.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(realpathSync.native(tmpdir()), 'win-approval-ui-'));
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/read.ts'), 'export const needle = 1;\n');
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const jsonResponse = (decision: 'allow' | 'ask' | 'deny' | 'unknown') =>
  textResponse(
    JSON.stringify({ decision, reasonCode: `model_${decision}`, reason: '离线测试判决' }),
  );
const readCases = [
  ['read_file', { path: 'src/read.ts' }],
  ['glob', { pattern: 'src/*.ts' }],
  ['grep', { pattern: 'needle', path: 'src', glob: '*.ts' }],
] as const;
const fallbacks: Array<[string, ScriptedResponse | undefined]> = [
  ['model_ask', jsonResponse('ask')],
  ['model_unknown', jsonResponse('unknown')],
  ['invalid_response', textResponse('{"decision":"allow"}')],
  [
    'incomplete_response',
    jsonResponse('allow').map((event) =>
      event.type === 'message_stop' ? { ...event, stopReason: 'max_tokens' as const } : event,
    ),
  ],
  [
    'provider_error',
    () => {
      throw new Error('离线 provider 故障');
    },
  ],
  ['reviewer_unavailable', undefined],
];
function setup(
  mode: PermissionMode,
  script: ScriptedResponse | undefined,
  platform: NodeJS.Platform = 'win32',
  respond: (request: PermissionRequest) => UserDecision = () => ({ allow: false }),
  timeout = false,
) {
  const tools = new ToolRegistry();
  for (const tool of [
    readFileTool,
    createGlobTool(),
    createGrepTool(),
    writeFileTool,
    editFileTool,
  ]) {
    tools.register({ ...tool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' } as Tool);
  }
  const policy = createDeterministicPolicy({
    cwd,
    mode,
    rules: { allow: [], ask: [], deny: [] },
    platform,
  });
  const provider = script === undefined ? undefined : new FakeProvider([script]);
  if (timeout && provider) {
    // 延迟流直到真实 reviewer 发出取消，不使用联网 provider 或替换 reviewer 判决。
    provider.stream = async function* (request, abort): AsyncIterable<StreamEvent> {
      this.requests.push(structuredClone(request));
      await new Promise<void>((resolve) => {
        if (abort.aborted) resolve();
        else abort.addEventListener('abort', () => resolve(), { once: true });
      });
    };
  }
  const reviewer = provider
    ? createModelReviewer({
        provider,
        model: 'offline-reviewer',
        modelInfo: () => ({ contextWindow: 128_000, maxOutputTokens: 8192 }),
        timeoutMs: timeout ? 5 : 30_000,
      })
    : undefined;
  const events = new EventBus();
  const requests: PermissionRequest[] = [];
  const rememberChoices: boolean[] = [];
  events.on('permission_request', (event) => {
    requests.push(event.request);
    rememberChoices.push(canRememberPermission(event.request));
    event.resolve(respond(event.request));
  });
  const executor = new ToolExecutor({
    tools,
    policy,
    reviewer,
    cwd,
    events,
    hooks: new HookRunner(),
  });
  const run = (name: string, input: Record<string, unknown>) =>
    executor.invokeTool(name, input, {
      signal: signal(),
      runId: 'windows-approval',
      userRequest: '读取并按要求修改 src 中普通文件',
      messages: [],
    });
  return { run, requests, rememberChoices, provider, policy };
}

describe.each(['auto', 'yolo'] as const)('Windows %s 项目内只读直接放行', (mode) => {
  it.each(readCases)('%s 不调用 reviewer，也不询问', async (name, input) => {
    const h = setup(mode, jsonResponse('ask'));
    expect((await h.run(name, input)).isError).toBeFalsy();
    expect(h.requests).toEqual([]);
    expect(h.provider!.requests).toHaveLength(0);
  });

  it.each(fallbacks)('写入 / %s 回退保留有效的记住选项', async (reasonCode, script) => {
    const h = setup(mode, script);
    expect(
      (await h.run('write_file', { path: 'src/not-written.ts', content: 'fixture' })).isError,
    ).toBe(true);
    expect(h.requests[0]).toMatchObject({
      reasonCode,
      policyReasonCode: 'platform_write_review',
      analysisReasonCode: 'native_windows_write_unverified',
    });
    expect(h.rememberChoices).toEqual([true]);
  });

  it.each(['write_file', 'edit_file'] as const)(
    '%s 回退仍可记住精确写入规则，下一次无需审核',
    async (name) => {
      const path = `src/${mode}-${name}.ts`;
      await writeFile(join(cwd, path), 'before');
      const h = setup(mode, jsonResponse('ask'), 'win32', (request) => ({
        allow: true,
        ...(canRememberPermission(request) ? { remember: 'session' as const } : {}),
      }));
      const args =
        name === 'write_file'
          ? { path, content: 'first' }
          : { path, old_string: 'before', new_string: 'first' };
      expect((await h.run(name, args)).isError).toBeFalsy();
      expect(h.requests[0]).toMatchObject({
        reasonCode: 'model_ask',
        policyReasonCode: 'platform_write_review',
        analysisReasonCode: 'native_windows_write_unverified',
      });
      expect(h.rememberChoices).toEqual([true]);
      expect(h.policy.controller!.getSessionRules().allow).toEqual([
        `${name}(=${JSON.stringify(path)})`,
      ]);
      const next =
        name === 'write_file'
          ? { path, content: 'second' }
          : { path, old_string: 'first', new_string: 'second' };
      expect((await h.run(name, next)).isError).toBeFalsy();
      expect(await readFile(join(cwd, path), 'utf8')).toBe('second');
      expect(h.requests).toHaveLength(1);
      expect(h.provider!.requests).toHaveLength(1);
    },
  );
});

describe('人工模式和非 Windows 不被 reviewer 原因码误判', () => {
  it.each(readCases)('Windows ask %s 与其他平台一样提供记住选项', async (name, input) => {
    const h = setup('ask', jsonResponse('allow'));
    await h.run(name, input);
    expect(h.requests[0]).toMatchObject({
      reasonCode: 'ask_mode',
      policyReasonCode: 'ask_mode',
    });
    expect(h.requests[0]?.analysisReasonCode).not.toBe('native_windows_read_unverified');
    expect(h.rememberChoices).toEqual([true]);
    expect(h.provider!.requests).toHaveLength(0);
  });

  it('Linux ask 的普通只读仍提供记住选项', async () => {
    const h = setup('ask', undefined, 'linux');
    await h.run('read_file', { path: 'src/read.ts' });
    expect(h.requests[0].reasonCode).toBe('ask_mode');
    expect(h.rememberChoices).toEqual([true]);
  });

  it.each(['model_ask', 'reviewer_unavailable', 'invalid_response', 'timeout'])(
    '单凭通用 reviewer 原因码 %s 不移除其他策略的记住选项',
    (reasonCode) => {
      expect(canRememberPermission({ reasonCode })).toBe(true);
    },
  );

  it('reviewer 自定义原因码不能冒充原策略的平台限制，写入能力以原策略为准', async () => {
    const script = textResponse(
      JSON.stringify({
        decision: 'ask',
        reasonCode: 'platform_read_review',
        reason: '离线测试原因',
      }),
    );
    const h = setup('auto', script);
    await h.run('write_file', { path: 'src/another.ts', content: 'fixture' });
    expect(h.requests[0]).toMatchObject({
      reasonCode: 'platform_read_review',
      policyReasonCode: 'platform_write_review',
    });
    expect(h.rememberChoices).toEqual([true]);
  });
});
