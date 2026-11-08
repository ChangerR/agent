/** 新权限语义的离线执行回归：每个授权都经过真实 Executor 与默认策略。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type PermissionRequest, type UserDecision } from '../src/core/events.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import { HookRunner } from '../src/core/hooks.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { createDeterministicPolicy } from '../src/builtin/policy/index.js';
import { writeFileTool } from '../src/tools/write.js';
import { editFileTool } from '../src/tools/edit.js';
import { readFileTool } from '../src/tools/read.js';
import { bashTool } from '../src/tools/bash.js';
import { createAgent } from '../src/index.js';
import type { PolicyInput, ProcessExecution } from '../src/sdk/capabilities.js';
import { permissionDefinition, permissionHash } from '../src/core/permission/grants.js';
import { RequestPermissionGuard } from '../src/core/permission/request-scope.js';
import { permissionDisplay } from '../src/core/permission/display.js';
import { loadSession, saveSessionVersioned } from '../src/builtin/session-file/implementation.js';
import { migrateSessionPermissions } from '../src/builtin/policy/migration.js';
import { loadConfigWithSources } from '../src/core/config.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(
  mode: 'ask' | 'auto' | 'yolo' = 'ask',
  rules = { allow: [] as string[], ask: [] as string[], deny: [] as string[] },
  execution?: ProcessExecution,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'permission-redesign-'));
  roots.push(cwd);
  await mkdir(join(cwd, '.git'));
  await mkdir(join(cwd, 'src'));
  await mkdir(join(cwd, 'tests'));
  const tools = new ToolRegistry(),
    events = new EventBus();
  for (const tool of [writeFileTool, editFileTool, readFileTool, bashTool])
    tools.register({ ...tool, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' });
  const policy = createDeterministicPolicy({ cwd, mode, rules });
  const reviewer = {
    review: vi.fn(async () => ({
      decision: 'allow' as const,
      reasonCode: 'model_allow',
      reason: '测试判定',
    })),
  };
  const requests: PermissionRequest[] = [];
  let respond: (request: PermissionRequest) => UserDecision = () => ({ allow: true });
  events.on('permission_request', ({ request, resolve }) => {
    requests.push(request);
    resolve(respond(request));
  });
  const executor = new ToolExecutor({
    cwd,
    tools,
    policy,
    events,
    hooks: new HookRunner(),
    reviewer,
    execution,
    sessionId: () => 'session',
  });
  let sequence = 0;
  const run = (name: string, input: Record<string, unknown>, runId = 'task') =>
    executor.execute(
      { type: 'tool_use', id: String(++sequence), name, input },
      {
        signal: new AbortController().signal,
        runId,
        messages: [],
        userRequest: '修改普通项目文件',
      },
    );
  const choose = (
    predicate: (action: NonNullable<PermissionRequest['actions']>[number]) => boolean,
  ) => {
    respond = (request) => ({ actionId: request.actions!.find(predicate)!.id });
  };
  return {
    cwd,
    tools,
    events,
    policy,
    reviewer,
    requests,
    executor,
    run,
    choose,
    respond: (handler: typeof respond) => {
      respond = handler;
    },
  };
}

describe('授权对象、模式与拒绝范围', () => {
  it('手工目录 Grant 不能授权 Shell 或跳过 Windows 写入约束', async () => {
    const f = await fixture();
    f.choose((action) => action.label.startsWith('本任务允许修改'));
    await f.run('write_file', { path: 'src/a.ts', content: 'root' });
    const grant = { ...f.policy.controller!.listGrants!()[0], tools: ['bash'] };
    const policy = createDeterministicPolicy({
      cwd: f.cwd,
      platform: 'win32',
      mode: 'ask',
      rules: { allow: [], ask: [], deny: [] },
      grants: [grant],
    });
    const result = await policy.decide(
      {
        cwd: f.cwd,
        tool: f.tools.get('bash')!,
        input: { command: 'Set-Content src/output.txt literal' },
        sessionId: 'session',
        permissionScope: 'session:task',
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ kind: 'ask', reasonCode: 'platform_write_ask' });
    const input: PolicyInput = {
      cwd: f.cwd,
      tool: f.tools.get('bash')!,
      input: { command: 'Set-Content src/output.txt literal' },
      sessionId: 'session',
      permissionScope: 'session:task',
    };
    policy.controller!.addGrant!({
      ...grant,
      id: '00000000-0000-4000-8000-000000000001',
      selector: {
        kind: 'call',
        inputHash: permissionHash(input.input),
        definitionHash: permissionDefinition(input),
      },
    });
    expect(await policy.decide(input, new AbortController().signal)).toMatchObject({
      kind: 'allow',
      reasonCode: 'grant_allow',
    });
  });

  it('Windows 同资源拒绝不能通过大小写或路径分隔符变化绕过', () => {
    const guard = new RequestPermissionGuard('win32');
    const operation = (target: string, name: string): PolicyInput => ({
      cwd: 'C:\\project',
      tool: { ...writeFileTool, name },
      input: { path: target, content: name },
      analysis: {
        analyzerId: 'test',
        analyzerVersion: '1',
        completeness: 'complete',
        effects: [{ kind: 'write', scope: 'project', target }],
      },
    });
    guard.denyOperation('task', operation('C:\\project\\src\\A.ts', 'write_file'));
    expect(guard.operationDenied('task', operation('c:/project/src/a.ts', 'edit_file'))).toBe(true);
    expect(guard.operationDenied('task', operation('C:\\project\\tests\\b.ts', 'write_file'))).toBe(
      false,
    );
  });

  it('child 初始化和结束不清除共享策略中父任务的授权', async () => {
    const f = await fixture();
    f.choose((action) => action.label.startsWith('本任务允许修改'));
    await f.run('write_file', { path: 'src/a.ts', content: 'root' });
    const child = new ToolExecutor({
      cwd: f.cwd,
      tools: f.tools,
      policy: f.policy,
      events: f.events,
      hooks: new HookRunner(),
      sessionId: () => 'child-session',
    });
    child.clear();
    expect(f.policy.controller!.listGrants!()).toHaveLength(1);
    await child.invokeTool(
      'read_file',
      { path: 'src/a.ts' },
      {
        signal: new AbortController().signal,
        runId: 'child-run',
        userRequest: '读取',
        messages: [],
        origin: {
          sessionId: 'child-session',
          agentId: 'child',
          runId: 'child-run',
          source: 'delegation',
          permissionScope: 'session:task',
          rootPermissionScope: 'session:task',
          userRequest: '读取',
        },
      },
    );
    child.finishRun('child-run');
    expect(f.policy.controller!.listGrants!()).toHaveLength(1);
    await f.run('write_file', { path: 'src/b.ts', content: 'root' });
    expect(f.requests).toHaveLength(1);
    f.executor.finishRun('task');
    expect(f.policy.controller!.listGrants!()).toHaveLength(0);
  });

  it('旧策略迁移先报告，显式应用仅保留历史与限制并收紧到 ask', async () => {
    const f = await fixture();
    const agent = await createAgent(f.cwd, {
      autoSaveSessions: false,
      config: { provider: 'fake', pluginConfig: { 'agentlab.planning': { mode: 'off' } } },
    });
    try {
      await agent.loop.run('保留这段历史');
      await agent.session.save();
      const original = await loadSession(f.cwd, agent.session.id);
      await saveSessionVersioned({
        ...original,
        policy: { ...original.policy, version: '2.0.0' },
        permissionMode: 'yolo',
        sessionRules: { allow: ['write_file'], ask: ['bash'], deny: ['read_file(secret)'] },
      });
      const old = await loadSession(f.cwd, original.id),
        signal = new AbortController().signal;
      expect(await migrateSessionPermissions(f.cwd, old.id, false, signal)).toMatchObject({
        applied: false,
        droppedTemporaryAllows: 1,
      });
      expect((await loadSession(f.cwd, old.id)).revision).toBe(old.revision);
      expect(await migrateSessionPermissions(f.cwd, old.id, true, signal)).toMatchObject({
        applied: true,
      });
      const migrated = await loadSession(f.cwd, old.id);
      expect(migrated.policy.version).toBe('3.0.0');
      expect(migrated.messages).toEqual(old.messages);
      expect(migrated.permissionMode).toBe('ask');
      expect(migrated.sessionRules).toEqual({
        allow: [],
        ask: ['bash'],
        deny: ['read_file(secret)'],
      });
    } finally {
      await agent.dispose();
    }
  });

  it('资源 deny 跨工具生效，且未知进程无法证明避开范围时拒绝', async () => {
    const f = await fixture('yolo');
    await writeFile(join(f.cwd, 'src/private.ts'), 'private');
    const policy = createDeterministicPolicy({
      cwd: f.cwd,
      mode: 'yolo',
      rules: { allow: [], ask: [], deny: [] },
      resourceRules: [
        {
          id: 'private-read',
          action: 'deny',
          effects: ['read'],
          resource: { kind: 'file', glob: 'src/private.ts' },
        },
      ],
    });
    const decide = (name: string, input: Record<string, unknown>) =>
      policy.decide({ cwd: f.cwd, tool: f.tools.get(name)!, input }, new AbortController().signal);
    expect(await decide('read_file', { path: 'src/private.ts' })).toMatchObject({
      kind: 'deny',
      reasonCode: 'resource_deny',
    });
    expect(await decide('bash', { command: 'cat src/private.ts' })).toMatchObject({
      kind: 'deny',
      reasonCode: 'resource_deny',
    });
    expect(await decide('bash', { command: 'node check.js' })).toMatchObject({
      kind: 'deny',
      reasonCode: 'resource_deny',
    });
    expect(await decide('read_file', { path: 'src/other.ts' })).toMatchObject({ kind: 'allow' });
    expect(await decide('write_file', { path: 'src/private.ts', content: 'new' })).toMatchObject({
      kind: 'allow',
    });
  });
  it('资源 allow 需要覆盖全部效果，ask/deny 优先于范围授权', async () => {
    const f = await fixture();
    const policy = createDeterministicPolicy({
      cwd: f.cwd,
      mode: 'ask',
      rules: { allow: [], ask: [], deny: [] },
      resourceRules: [
        {
          id: 'source-write',
          action: 'allow',
          effects: ['write'],
          resource: { kind: 'file', glob: 'src/**' },
        },
        {
          id: 'source-review',
          action: 'ask',
          effects: ['write'],
          resource: { kind: 'file', glob: 'src/review.ts' },
        },
      ],
    });
    const decide = (path: string) =>
      policy.decide(
        { cwd: f.cwd, tool: f.tools.get('write_file')!, input: { path, content: 'code' } },
        new AbortController().signal,
      );
    expect(await decide('src/a.ts')).toMatchObject({ kind: 'allow', reasonCode: 'resource_allow' });
    expect(await decide('src/review.ts')).toMatchObject({
      kind: 'ask',
      reasonCode: 'explicit_ask',
    });
    expect(await decide('tests/a.ts')).toMatchObject({ kind: 'ask' });
  });

  it('只有通过宿主边界的未知程序才可委托 reviewer，实际执行走同一 adapter', async () => {
    const execute = vi.fn<ProcessExecution['execute']>(async () => ({ content: 'sandbox-result' }));
    const execution: ProcessExecution = {
      supports: () => true,
      status: () => ({
        id: 'test-sandbox',
        revision: 'v1',
        available: true,
        description: '测试执行边界',
      }),
      execute,
    };
    const f = await fixture('auto', undefined, execution);
    const result = await f.run('bash', { command: 'node check.js' });
    expect(result.content).toBe('sandbox-result');
    expect(f.requests).toHaveLength(0);
    expect(f.reviewer.review).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toMatchObject({ cwd: f.cwd, args: ['-c', 'node check.js'] });
  });
  it('所选隔离不可用时零审批零执行，返回结构化终态', async () => {
    const execute = vi.fn();
    const execution: ProcessExecution = {
      supports: () => true,
      status: () => ({
        id: 'test-sandbox',
        revision: 'v1',
        available: false,
        description: '不可用',
      }),
      execute,
    };
    const f = await fixture('auto', undefined, execution);
    const result = await f.run('bash', { command: 'node check.js' });
    expect(result.permission).toMatchObject({
      status: 'boundary_unavailable',
      reasonCode: 'sandbox_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
    expect(f.reviewer.review).not.toHaveBeenCalled();
  });
  it('审批期间执行边界变化后旧批准不能复用', async () => {
    let revision = 'v1';
    const execute = vi.fn(async () => ({ content: 'should-not-run' }));
    const execution: ProcessExecution = {
      supports: () => true,
      status: () => ({
        id: 'test-sandbox',
        revision,
        available: true,
        description: '测试执行边界',
      }),
      execute,
    };
    const f = await fixture('ask', undefined, execution);
    f.respond(() => {
      if (revision === 'v1') {
        revision = 'v2';
        return { allow: true };
      }
      return { allow: false };
    });
    expect((await f.run('bash', { command: 'node check.js' })).isError).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });
  it('审批展示脱敏但执行原始参数保持不变，敏感参数不交模型', async () => {
    const f = await fixture('auto');
    const execute = vi.fn<Tool['execute']>(async () => ({ content: 'done' }));
    f.tools.register({
      name: 'credential_call',
      ownerPlugin: 'test.credentials',
      version: '1',
      description: '测试参数',
      risk: 'execute',
      inputSchema: {},
      analyzeInput: (input) => ({
        patternTarget: JSON.stringify(input),
        summary: JSON.stringify(input),
      }),
      execute,
    });
    const input = {
      token: 'fixed-fake-private-token',
      client_secret: 'fixed-fake-client-secret',
      endpoint:
        'https://user:fixed-fake-private-token@example.invalid/?token=fixed-fake-private-token',
    };
    const displayedCalls: unknown[] = [];
    f.events.on('tool_call', (event) => displayedCalls.push(event));
    expect((await f.run('credential_call', input)).isError).toBeFalsy();
    expect(JSON.stringify(f.requests)).not.toContain('fixed-fake-private-token');
    expect(JSON.stringify(f.requests)).not.toContain('fixed-fake-client-secret');
    expect(JSON.stringify(displayedCalls)).not.toContain('fixed-fake-private-token');
    expect(f.requests[0].actions!.some((action) => action.kind === 'grant')).toBe(false);
    expect(execute.mock.calls[0][0]).toEqual(input);
    expect(f.reviewer.review).not.toHaveBeenCalled();
    expect(
      JSON.stringify(permissionDisplay(['--token', 'fixed-fake-private-token'])),
    ).not.toContain('fixed-fake-private-token');
  });

  it.each(['client_secret', 'private_key', 'api_token', 'x-api-key', 'credentials'])(
    '审批展示隐藏常见敏感字段 %s',
    (key) => {
      expect(JSON.stringify(permissionDisplay({ [key]: 'fixed-fake-private' }))).not.toContain(
        'fixed-fake-private',
      );
    },
  );
  it('普通 JSON 文本和凭据引用不被误判为敏感参数', () => {
    const input = {
      content: '{\n  "enabled": true\n}',
      apiKeyEnv: 'TEST_API_KEY',
      apiKeyRef: 'ref',
    };
    expect(permissionDisplay(input)).toEqual(input);
  });

  it('ask 不调用 reviewer，auto 的完整普通写入可委托', async () => {
    const ask = await fixture();
    expect((await ask.run('write_file', { path: 'src/a.ts', content: 'a' })).isError).toBeFalsy();
    expect(ask.requests).toHaveLength(1);
    expect(ask.reviewer.review).not.toHaveBeenCalled();
    const auto = await fixture('auto');
    expect((await auto.run('write_file', { path: 'src/a.ts', content: 'a' })).isError).toBeFalsy();
    expect(auto.requests).toHaveLength(0);
    expect(auto.reviewer.review).toHaveBeenCalledOnce();
  });
  it.each(['ask', 'auto', 'yolo'] as const)('%s 未知 Shell 无隔离时必须人工', async (mode) => {
    const f = await fixture(mode);
    f.respond(() => ({ allow: false }));
    expect((await f.run('bash', { command: 'node -e "process.exit(0)"' })).isError).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.reviewer.review).not.toHaveBeenCalled();
  });
  it('任务目录授权跨 write/edit 生效，结束任务后撤销', async () => {
    const f = await fixture();
    f.choose((action) => action.label.startsWith('本任务允许修改'));
    await f.run('write_file', { path: 'src/a.ts', content: 'a' });
    await f.run('write_file', { path: 'src/b.ts', content: 'b' });
    await f.run('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'changed' });
    expect(f.requests).toHaveLength(1);
    expect(await readFile(join(f.cwd, 'src/a.ts'), 'utf8')).toBe('changed');
    f.executor.finishRun('task');
    await f.run('write_file', { path: 'src/c.ts', content: 'c' }, 'next-task');
    expect(f.requests).toHaveLength(2);
  });
  it('完整调用记忆绑定所有参数，修改同一路径内容仍重新询问', async () => {
    const f = await fixture();
    f.choose((action) => action.scope === 'session');
    const input = { path: 'src/a.ts', content: 'a' };
    await f.run('write_file', input);
    await f.run('write_file', input);
    expect(f.requests).toHaveLength(1);
    await f.run('write_file', { ...input, content: 'b' });
    expect(f.requests).toHaveLength(2);
    expect(f.policy.controller!.getSessionRules().allow).toEqual([]);
    f.executor.clear();
    expect(f.policy.controller!.listGrants!()).toEqual([]);
  });
  it('明确 ask、敏感文件和危险操作不提供记忆动作', async () => {
    const f = await fixture('yolo', {
      allow: ['write_file'],
      ask: ['write_file(src/a.ts)'],
      deny: [],
    });
    f.respond((request) => {
      expect(request.actions!.some((action) => action.kind === 'grant')).toBe(false);
      return { allow: false };
    });
    await f.run('write_file', { path: 'src/a.ts', content: 'a' });
    await f.run('write_file', { path: '.env', content: 'fixed-test-secret' }, 'sensitive');
    await f.run('bash', { command: 'sudo echo denied' }, 'danger');
    expect(f.requests).toHaveLength(3);
    expect(f.reviewer.review).not.toHaveBeenCalled();
  });
  it('普通拒绝不锁整个任务，同资源不能换工具绕过', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'src/a.ts'), 'a');
    f.respond(() => ({ allow: false }));
    await f.run('write_file', { path: 'src/a.ts', content: 'b' });
    const alias = await f.run('edit_file', { path: 'src/a.ts', old_string: 'a', new_string: 'c' });
    expect(alias.content).toContain('operation_previously_denied');
    expect((await f.run('read_file', { path: 'src/a.ts' })).content).toContain('a');
    f.respond(() => ({ allow: true }));
    expect((await f.run('write_file', { path: 'tests/b.ts', content: 'b' })).isError).toBeFalsy();
    expect(f.requests).toHaveLength(2);
  });
  it('停止任务使当前任务的后续调用失效，新任务重新判定', async () => {
    const f = await fixture();
    f.choose((action) => action.kind === 'stop');
    await f.run('write_file', { path: 'src/a.ts', content: 'a' });
    expect((await f.run('read_file', { path: 'src/a.ts' })).content).toContain(
      'request_permission_denied',
    );
    f.respond(() => ({ allow: true }));
    expect(
      (await f.run('write_file', { path: 'src/b.ts', content: 'b' }, 'new-task')).isError,
    ).toBeFalsy();
  });
  it('伪造 actionId 不能执行或新增授权', async () => {
    const f = await fixture();
    f.respond(() => ({ actionId: 'fabricated' }));
    expect((await f.run('write_file', { path: 'src/a.ts', content: 'a' })).content).toContain(
      'invalid_approval_action',
    );
    expect(f.policy.controller!.listGrants!()).toEqual([]);
    await expect(readFile(join(f.cwd, 'src/a.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('目录 allow 真正生效且 deny/ask 仍优先', async () => {
    const f = await fixture('ask', {
      allow: ['write_file(src/**)'],
      ask: ['write_file(src/ask.ts)'],
      deny: ['write_file(src/deny.ts)'],
    });
    await f.run('write_file', { path: 'src/a.ts', content: 'a' });
    expect(f.requests).toHaveLength(0);
    f.respond(() => ({ allow: false }));
    await f.run('write_file', { path: 'src/ask.ts', content: 'a' });
    expect(f.requests).toHaveLength(1);
    expect((await f.run('write_file', { path: 'src/deny.ts', content: 'a' })).isError).toBe(true);
    expect((await f.run('read_file', { path: 'src/a.ts' })).isError).toBeFalsy();
  });
  it('撤销 session 授权后重新询问', async () => {
    const f = await fixture();
    f.choose((action) => action.scope === 'session');
    const input = { path: 'src/a.ts', content: 'a' };
    await f.run('write_file', input);
    f.policy.controller!.revokeGrant!(f.policy.controller!.listGrants!()[0].id);
    await f.run('write_file', input);
    expect(f.requests).toHaveLength(2);
  });
  it('SDK 会话空规则不能抹掉项目 deny/ask', async () => {
    const f = await fixture();
    await writeFile(
      join(f.cwd, 'agent.config.json'),
      JSON.stringify({ permissions: { deny: ['write_file(secret)'], ask: ['bash'] } }),
    );
    const config = loadConfigWithSources(f.cwd, {
      permissions: { allow: [], ask: [], deny: [] },
    }).config;
    expect(config.permissions.deny).toContain('write_file(secret)');
    expect(config.permissions.ask).toContain('bash');
  });
  it('项目授权实际保存、重启复用及撤销持久化', async () => {
    const f = await fixture();
    await writeFile(join(f.cwd, 'agent.config.json'), JSON.stringify({ future: { keep: true } }));
    const options = {
      autoSaveSessions: false,
      config: {
        provider: 'fake',
        model: 'fake',
        permissionMode: 'ask' as const,
        pluginConfig: { 'agentlab.planning': { mode: 'off' } },
      },
    };
    const first = await createAgent(f.cwd, options);
    first.events.on('permission_request', ({ request, resolve }) =>
      resolve({ actionId: request.actions!.find((action) => action.scope === 'project')!.id }),
    );
    const input = { path: 'src/project.ts', content: 'project' };
    expect((await first.loop.invokeTool('write_file', input)).isError).toBeFalsy();
    await first.dispose();
    const raw = JSON.parse(await readFile(join(f.cwd, 'agent.config.json'), 'utf8'));
    expect(raw.future).toEqual({ keep: true });
    expect(raw.pluginConfig['agentlab.policy'].grants).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toContain('"content":"project"');
    const second = await createAgent(f.cwd, options);
    const prompt = vi.fn();
    second.events.on('permission_request', prompt);
    expect((await second.loop.invokeTool('write_file', input)).isError).toBeFalsy();
    expect(prompt).not.toHaveBeenCalled();
    const id = second.permission.listGrants!()[0].id;
    await second.dispatchCommand(`/permissions revoke ${id}`);
    await second.dispose();
    const saved = JSON.parse(await readFile(join(f.cwd, 'agent.config.json'), 'utf8'));
    expect(saved.pluginConfig['agentlab.policy'].grants).toEqual([]);
    // 原授权被撤销后，将旧配置重新放回也必须重新取得启动信任。
    await writeFile(join(f.cwd, 'agent.config.json'), JSON.stringify(raw));
    await expect(createAgent(f.cwd, options)).rejects.toMatchObject({
      code: 'startup_trust_required',
    });
  });
});
