/**
 * 默认 createAgent 装配的离线集成回归：只增加 FakeProvider，保留真实策略、审批员和工具。
 * 仅在构造 runtime 时注入 process.platform；实际执行使用宿主文件系统，不代表原生 Windows 验收。
 */
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Agent } from '../src/index.js';
import { createExecutionAgent as createAgent } from './helpers/execution-agent.js';
import { STRICT_REVIEWER_SYSTEM } from '../src/builtin/reviewer-model/index.js';
import type { PermissionMode } from '../src/core/config.js';
import type { AgentEvent, PermissionRequest, UserDecision } from '../src/core/events.js';
import { FakeProvider, textResponse, toolUseResponse } from '../src/providers/fake.js';
import { definePlugin } from '../src/sdk/index.js';

const hostPlatform = process.platform;
const providerName = 'test-windows-default-runtime';
const agents = new Set<Agent>();
let fixture: string;
let cwd: string;
let projectConfig: string;

beforeEach(async () => {
  // 展开 Windows 临时目录可能出现的 8.3 短名，避免测试根自身触发歧义路径保护。
  fixture = await mkdtemp(join(realpathSync.native(tmpdir()), 'agent-windows-default-'));
  cwd = join(fixture, 'project');
  const home = join(fixture, 'home');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await mkdir(join(cwd, 'src'));
  await mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  projectConfig = join(cwd, 'agent.config.json');
  await writeFile(projectConfig, '{}\n');
});

afterEach(async () => {
  await Promise.all([...agents].map((agent) => agent.dispose()));
  agents.clear();
  vi.unstubAllEnvs();
  await rm(fixture, { recursive: true, force: true });
});

async function runtime(
  options: {
    review?: 'allow' | 'ask';
    mode?: PermissionMode;
    respond?: (request: PermissionRequest, index: number) => UserDecision;
  } = {},
) {
  let pendingWrite: { path: string; content: string } | undefined;
  let callId = 0;
  const provider = new FakeProvider([
    (request) => {
      if (request.tools.length === 0)
        return textResponse(
          JSON.stringify({
            decision: options.review ?? 'allow',
            reasonCode: 'offline_write_review',
            reason: '离线测试审批结果',
          }),
        );
      if (!pendingWrite) return textResponse('done');
      const input = pendingWrite;
      pendingWrite = undefined;
      return toolUseResponse([{ id: `write-${++callId}`, name: 'write_file', input }]);
    },
  ]);
  const plugin = definePlugin({
    manifest: { id: 'test.windows-default-provider', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.provider(providerName, {
        name: providerName,
        capabilities: provider.capabilities,
        stream: provider.stream.bind(provider),
      });
    },
  });

  // 策略与分析器在构造时捕获平台；不替换默认 preset、策略插件或模型审批员。
  // finally 恢复原始属性描述符，工具执行和后续测试不受平台替身影响。
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: () => hostPlatform,
  });
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  let agent: Agent;
  try {
    agent = await createAgent(cwd, {
      autoSaveSessions: false,
      plugins: [plugin],
      config: {
        provider: providerName,
        model: 'offline-windows-model',
        permissionMode: options.mode ?? 'auto',
      },
    });
  } finally {
    platform.mockRestore();
    Object.defineProperty(process, 'platform', descriptor);
  }
  agents.add(agent);
  expect(process.platform).toBe(hostPlatform);
  expect(agent.plugins.selected('policy')?.id).toBe('deterministic');
  expect(agent.plugins.selected('reviewer')?.id).toBe('model');
  expect(agent.tools.get('write_file')).toMatchObject({
    ownerPlugin: 'agentlab.local-tools',
    version: '1.0.0',
  });

  const events: AgentEvent[] = [];
  const humanRequests: PermissionRequest[] = [];
  agent.events.onAll((event) => events.push(event));
  agent.events.on('permission_request', (event) => {
    humanRequests.push(event.request);
    event.resolve(options.respond?.(event.request, humanRequests.length) ?? { allow: false });
  });
  return {
    agent,
    events,
    humanRequests,
    provider,
    reviews: () => provider.requests.filter((request) => request.tools.length === 0),
    async write(path: string, content: string) {
      const offset = events.length;
      pendingWrite = { path, content };
      expect(
        (await agent.loop.run(`请把 ${path} 的内容写为 ${JSON.stringify(content)}`)).reason,
      ).toBe('completed');
      const results = events.slice(offset).filter((event) => event.type === 'tool_result');
      expect(results).toHaveLength(1);
      return results[0]!.result;
    },
    async dispose() {
      await agent.dispose();
      agents.delete(agent);
    },
  };
}

function exactRule(path: string) {
  return `write_file(=${JSON.stringify(path)})`;
}

describe('默认 runtime：注入 Windows 策略分支，使用真实宿主文件系统', () => {
  it('Bash 专用工具路由拒绝不锁定 Plan，后续专用读取仍正常审查', async () => {
    const h = await runtime();
    await writeFile(join(cwd, 'note.txt'), 'ordinary content');
    const result = await h.agent.invokeTool('bash', { command: 'cat note.txt' });
    expect(result.isError).toBe(true);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'permission_decision',
        denialScope: 'invocation',
        decision: expect.objectContaining({ reasonCode: 'use_dedicated_tool' }),
      }),
    );
    expect(h.agent.loop.plan.denialReason).toBeUndefined();
    const read = await h.agent.invokeTool('read_file', { path: 'note.txt' });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('ordinary content');
  });
  it.each(['auto', 'yolo'] as const)(
    '%s 普通未授权写入经过真实 JSON reviewer，批准后实际写入',
    async (mode) => {
      const h = await runtime({ mode });
      expect((await h.write('src/reviewed.txt', 'reviewed content')).isError).toBeFalsy();
      expect(await readFile(join(cwd, 'src/reviewed.txt'), 'utf8')).toBe('reviewed content');
      expect(h.humanRequests).toEqual([]);
      expect(h.reviews()).toHaveLength(1);
      const request = h.reviews()[0]!;
      expect(request.system).toBe(STRICT_REVIEWER_SYSTEM);
      expect(request.model).toBe('offline-windows-model');
      expect(request.tools).toEqual([]);
      const body = JSON.parse(request.messages[0]!.content as string);
      expect(body.analysis).toMatchObject({
        completeness: 'complete',
        reasonCode: 'native_windows_write_unverified',
      });
      expect(JSON.stringify(body.analysis.evidence)).toContain('Windows 平台未做文件系统校验');
      expect(body.policy.decision).toMatchObject({
        kind: 'review',
        reasonCode: 'platform_write_review',
      });
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: 'permission_decision',
          phase: 'judge',
          decision: expect.objectContaining({ kind: 'allow', source: 'judge' }),
        }),
      );
      expect(
        h.events.filter((event) => event.type === 'model_request' && event.purpose === 'judge'),
      ).toHaveLength(1);
    },
  );

  it.each(['session', 'project'] as const)(
    'reviewer ask 回落人工，remember=%s 只记住当前会话的精确目标',
    async (remember) => {
      const before = await readFile(projectConfig, 'utf8');
      const h = await runtime({
        review: 'ask',
        respond: (_request, index) => (index === 1 ? { allow: true, remember } : { allow: false }),
      });
      expect((await h.write('src/remembered.txt', 'first')).isError).toBeFalsy();
      expect(h.humanRequests).toHaveLength(1);
      expect(h.humanRequests[0]).toMatchObject({ decisionSource: 'judge', toolName: 'write_file' });
      expect(h.reviews()).toHaveLength(1);
      const remembered = exactRule('src/remembered.txt');
      expect(h.agent.permission.getSessionRules().allow).toEqual([remembered]);

      expect((await h.write('src/remembered.txt', 'second')).isError).toBeFalsy();
      expect(await readFile(join(cwd, 'src/remembered.txt'), 'utf8')).toBe('second');
      expect(h.humanRequests).toHaveLength(1);
      expect(h.reviews()).toHaveLength(1);
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: 'permission_decision',
          phase: 'pipeline',
          decision: expect.objectContaining({
            kind: 'allow',
            reasonCode: 'exact_allow',
            source: 'session',
            matchedRule: remembered,
          }),
        }),
      );

      expect((await h.write('src/other.txt', 'must not be written')).isError).toBe(true);
      expect(h.humanRequests).toHaveLength(2);
      expect(h.reviews()).toHaveLength(2);
      await expect(readFile(join(cwd, 'src/other.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(projectConfig, 'utf8')).toBe(before);
      const persistenceNotices = h.events.filter(
        (event) => event.type === 'notice' && event.text.includes('permissions.allow'),
      );
      expect(persistenceNotices).toHaveLength(remember === 'project' ? 1 : 0);
      if (remember === 'project')
        expect(persistenceNotices[0]).toMatchObject({
          text: expect.stringContaining('要持久化到项目'),
        });
      await h.dispose();

      // 新建 runtime 不恢复旧会话；“项目记住”目前只提示手动持久化，不自动改配置。
      const restarted = await runtime({ review: 'ask' });
      expect(restarted.agent.permission.getSessionRules().allow).toEqual([]);
      expect((await restarted.write('src/remembered.txt', 'must not replace second')).isError).toBe(
        true,
      );
      expect(restarted.reviews()).toHaveLength(1);
      expect(restarted.humanRequests).toHaveLength(1);
      expect(await readFile(join(cwd, 'src/remembered.txt'), 'utf8')).toBe('second');
      expect(await readFile(projectConfig, 'utf8')).toBe(before);
    },
  );

  it('显式持久化 permissions.allow 精确规则后，重建 runtime 可放行且不扩大到另一目标', async () => {
    const first = await runtime({ review: 'ask' });
    expect((await first.write('src/persisted.txt', 'before authorization')).isError).toBe(true);
    expect(first.reviews()).toHaveLength(1);
    expect(first.humanRequests).toHaveLength(1);
    await first.dispose();

    const rule = exactRule('src/persisted.txt');
    await writeFile(projectConfig, JSON.stringify({ permissions: { allow: [rule] } }));
    const restarted = await runtime({ review: 'ask' });
    expect(restarted.agent.config.permissions.allow).toEqual([rule]);
    expect(restarted.agent.configSources.permissions.scope).toBe('project');
    expect(restarted.agent.permission.getSessionRules().allow).toEqual([]);
    expect(
      (await restarted.write('src/persisted.txt', 'persisted authorization')).isError,
    ).toBeFalsy();
    expect(await readFile(join(cwd, 'src/persisted.txt'), 'utf8')).toBe('persisted authorization');
    expect(restarted.reviews()).toHaveLength(0);
    expect(restarted.humanRequests).toHaveLength(0);
    expect(restarted.events).toContainEqual(
      expect.objectContaining({
        type: 'permission_decision',
        phase: 'pipeline',
        decision: expect.objectContaining({
          kind: 'allow',
          reasonCode: 'exact_allow',
          source: 'config',
          matchedRule: rule,
        }),
      }),
    );

    expect((await restarted.write('src/unlisted.txt', 'not authorized')).isError).toBe(true);
    expect(restarted.reviews()).toHaveLength(1);
    expect(restarted.humanRequests).toHaveLength(1);
    await expect(readFile(join(cwd, 'src/unlisted.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('Windows 分支的大小写变体 deny 优先于精确 allow，不询问 reviewer 且不写入', async () => {
    const target = 'src/Blocked.txt';
    await writeFile(join(cwd, target), 'protected content');
    await writeFile(
      projectConfig,
      JSON.stringify({
        permissions: {
          allow: [exactRule(target)],
          deny: ['write_file(src/blocked.txt)'],
        },
      }),
    );
    const h = await runtime();
    expect((await h.write(target, 'must not overwrite')).isError).toBe(true);
    expect(await readFile(join(cwd, target), 'utf8')).toBe('protected content');
    expect(h.reviews()).toHaveLength(0);
    expect(h.humanRequests).toHaveLength(0);
    expect(h.events.filter((event) => event.type === 'tool_call')).toHaveLength(0);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: 'permission_decision',
        phase: 'pipeline',
        decision: expect.objectContaining({
          kind: 'deny',
          reasonCode: 'deny_rule',
          source: 'config',
        }),
      }),
    );
  });
});
