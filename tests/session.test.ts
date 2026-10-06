/**
 * 会话保存 / 恢复。FakeProvider + 临时目录，不碰仓库自己的 .agentlab，不打网络。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_MARKER } from '../src/core/context/manager.js';
import { ContextManager } from '../src/core/context/manager.js';
import { EventBus } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import { AgentLoop } from '../src/core/loop.js';
import { PermissionEngine } from '../src/core/permission/engine.js';
import type { PluginContext } from '../src/core/plugin.js';
import { MODEL_PRESETS } from '../src/core/config.js';
import type { Message } from '../src/core/protocol/types.js';
import type { ChatRequest } from '../src/core/provider.js';
import { ProviderRegistry, ToolRegistry } from '../src/core/registry.js';
import { assertSafeHistory, findOrphanToolResults, makeTitle, trimToSafeTail } from '../src/core/session/history.js';
import { enqueueWrite, flushWrites } from '../src/core/session/atomic.js';
import { SessionManager } from '../src/core/session/manager.js';
import {
  deleteSession,
  latestSessionId,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  sessionPath,
  sessionsDir,
} from '../src/core/session/store.js';
import type { SessionFile } from '../src/core/session/types.js';
import { FakeProvider, textResponse, toolUseResponse, type ScriptedResponse } from '../src/providers/fake.js';
import { builtinTools } from '../src/tools/index.js';
import { bashTool } from '../src/tools/bash.js';
import { globTool } from '../src/tools/glob.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';

let tmp: string;
const detaches: Array<() => void> = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'agentlab-session-'));
});

afterEach(async () => {
  for (const detach of detaches) detach();
  detaches.length = 0;
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

function buildFile(cwd: string, patch: Partial<SessionFile> = {}): SessionFile {
  const messages = patch.messages ?? [{ role: 'user' as const, content: 'hello' }];
  return {
    schemaVersion: 1,
    id: 'sess-test',
    title: 'hello',
    createdAt: '2026-10-05T01:02:03.000Z',
    updatedAt: '2026-10-05T01:02:03.000Z',
    cwd: resolve(cwd),
    model: 'fake',
    provider: 'fake',
    endpointKey: 'default',
    thinking: 'off',
    permissionMode: 'ask',
    sessionRules: { allow: [], ask: [], deny: [] },
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    stats: { messages: messages.length, estimatedTokens: 1, runs: 1 },
    ...patch,
    messages,
  };
}

function makeHarness(opts: {
  script?: ScriptedResponse[];
  mode?: 'ask' | 'auto' | 'yolo';
  rules?: { allow: string[]; ask: string[]; deny: string[] };
  maxTurns?: number;
  compactThreshold?: number;
  model?: string;
  thinking?: 'off' | 'low' | 'medium' | 'high';
  modelInfo?: (model: string) => { contextWindow: number; maxOutputTokens: number } | undefined;
  autoSave?: boolean;
  makeId?: () => string;
  events?: EventBus;
} = {}) {
  const events = opts.events ?? new EventBus();
  const tools = new ToolRegistry();
  const hooks = new HookRunner();
  const ctx: PluginContext = {
    providers: new ProviderRegistry(),
    tools,
    hooks: { register: (point, handler) => hooks.register(point, handler) },
    config: {} as PluginContext['config'],
  };
  builtinTools.register(ctx);
  const permission = new PermissionEngine({
    mode: opts.mode ?? 'auto',
    rules: opts.rules ?? { allow: [], ask: [], deny: [] },
  });
  const provider = new FakeProvider(opts.script ?? []);
  const context = new ContextManager({ compactThreshold: opts.compactThreshold ?? 1_000_000 });
  const loop = new AgentLoop({
    provider,
    model: opts.model ?? 'fake',
    tools,
    permission,
    hooks,
    events,
    context,
    systemPrompt: 'test',
    maxTurns: opts.maxTurns ?? 10,
    cwd: tmp,
    thinking: opts.thinking,
    ...(opts.modelInfo ? { modelInfo: opts.modelInfo } : {}),
  });
  const manager = new SessionManager({
    cwd: tmp,
    loop,
    permission,
    events,
    autoSave: opts.autoSave ?? true,
    makeId: opts.makeId,
  });
  detaches.push(manager.attach());
  return { loop, events, provider, permission, tools, context, manager };
}

const roundTripMessages = [
  { role: 'user', source: 'summary', content: `${SUMMARY_MARKER}\n早期内容保持原样` },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '想', signature: 'sig-✓-中文', extra: 'keep-me' },
      { type: 'redacted_thinking', data: 'opaque-data' },
      { type: 'text', text: '好' },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'a.ts', n: 1, nested: { ok: true } } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'body', isError: false }] },
] as Message[];

describe('会话文件', () => {
  it('往返保留思考签名、打码 data、工具参数和摘要原文', async () => {
    const file = buildFile(tmp, { id: 'roundtrip1', messages: roundTripMessages, title: '摘要后的标题' });
    const path = await saveSession(file);
    const text = await fs.readFile(path, 'utf8');
    expect(text.startsWith('\uFEFF')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    const loaded = await loadSession(tmp, 'roundtrip1');
    expect(JSON.stringify(loaded.messages)).toBe(JSON.stringify(roundTripMessages));
    const thinking = loaded.messages[1].role === 'assistant' ? loaded.messages[1].content[0] : undefined;
    expect(thinking).toMatchObject({ type: 'thinking', signature: 'sig-✓-中文', extra: 'keep-me' });
    expect(loaded.messages[1]).toMatchObject({
      content: expect.arrayContaining([{ type: 'redacted_thinking', data: 'opaque-data' }]),
    });
  });

  it('头部字段按写入原样读回', async () => {
    const file = buildFile(tmp, {
      id: 'header1',
      title: '标题',
      createdAt: '2026-10-05T01:02:03.000Z',
      updatedAt: '2026-10-05T04:05:06.000Z',
      model: 'gpt-4o',
      thinking: 'high',
      permissionMode: 'auto',
      sessionRules: { allow: ['read_file'], ask: ['write_file'], deny: ['bash'] },
      usage: { inputTokens: 9, outputTokens: 8, cacheReadTokens: 7, cacheWriteTokens: 6 },
      stats: { messages: 1, estimatedTokens: 3, runs: 4 },
    });
    await saveSession(file);
    const loaded = await loadSession(tmp, 'header1');
    expect(loaded).toMatchObject({
      schemaVersion: 1,
      id: 'header1',
      title: '标题',
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      cwd: resolve(tmp),
      model: 'gpt-4o',
      thinking: 'high',
      permissionMode: 'auto',
      sessionRules: file.sessionRules,
      usage: file.usage,
      stats: file.stats,
    });
  });

  it('rename 遇到 EPERM 时保留旧文件并清掉临时文件；前两次失败后第三次成功', async () => {
    const original = buildFile(tmp, { id: 'atomic1', messages: [{ role: 'user', content: 'old' }] });
    await saveSession(original);
    const target = sessionPath(tmp, 'atomic1');
    const realRename = fs.rename.bind(fs);

    const fail = vi.spyOn(fs, 'rename').mockImplementation(async () => {
      const error = new Error('locked') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    });
    await expect(saveSession(buildFile(tmp, { id: 'atomic1', revision: 1, messages: [{ role: 'user', content: 'new' }] }))).rejects.toMatchObject({ code: 'io' });
    expect(fail).toHaveBeenCalledTimes(6);
    expect(await fs.readFile(target, 'utf8')).toContain('old');
    expect((await fs.readdir(sessionsDir(tmp))).some((name) => name.includes('.tmp'))).toBe(false);
    fail.mockRestore();

    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      calls += 1;
      if (calls <= 2) {
        const error = new Error('locked') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      }
      return realRename(...args);
    });
    await saveSession(buildFile(tmp, { id: 'atomic1', revision: 1, messages: [{ role: 'user', content: 'third' }] }));
    expect(calls).toBe(3);
    expect(await fs.readFile(target, 'utf8')).toContain('third');
    expect((await fs.readdir(sessionsDir(tmp))).some((name) => name.includes('.tmp'))).toBe(false);
  });

  it('损坏、版本、结构和缺失可以区分，列表里的坏文件不会被删', async () => {
    await fs.mkdir(sessionsDir(tmp), { recursive: true });
    const corruptPath = sessionPath(tmp, 'corrupt1');
    const futurePath = sessionPath(tmp, 'future1');
    const invalidPath = sessionPath(tmp, 'invalid1');
    await fs.writeFile(corruptPath, '{');
    await fs.writeFile(futurePath, `${JSON.stringify({
      schemaVersion: 2,
      id: 'future1',
      title: 'future',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
      cwd: resolve(tmp),
      model: 'fake',
    })}\n`);
    await fs.writeFile(invalidPath, `${JSON.stringify({ schemaVersion: 1, id: 'invalid1' })}\n`);

    await expect(loadSession(tmp, 'corrupt1')).rejects.toMatchObject({ code: 'corrupt' });
    await expect(loadSession(tmp, 'future1')).rejects.toMatchObject({ code: 'unsupported_version' });
    const invalid = await loadSession(tmp, 'invalid1').then(() => undefined, (error: unknown) => error);
    expect(invalid).toMatchObject({ code: 'invalid_schema' });
    expect(String((invalid as Error).message)).toContain('会话文件结构不合法');
    expect(String((invalid as Error).message)).toContain('…还有');
    await expect(loadSession(tmp, 'missing1')).rejects.toMatchObject({ code: 'not_found' });

    const listing = await listSessions(tmp);
    expect(listing.broken.map((item) => item.id).sort()).toEqual(['corrupt1', 'invalid1']);
    expect(listing.broken.every((item) => item.error instanceof Error)).toBe(true);
    await expect(fs.access(corruptPath)).resolves.toBeUndefined();
    await expect(fs.access(invalidPath)).resolves.toBeUndefined();
    expect(await fs.readFile(corruptPath, 'utf8')).toBe('{');
  });
});

describe('恢复边界', () => {
  it('provider / endpoint 不一致拒绝恢复且不改状态，旧 v1 只能显式迁移', async () => {
    const { loop, permission, manager } = makeHarness({ autoSave: false });
    loop.importSession({ messages: [{ role: 'user', content: 'current' }] });
    const before = loop.exportSession();
    let revision = 0;
    for (const patch of [{ provider: 'other' }, { endpointKey: 'different' }]) {
      await saveSession(buildFile(tmp, { id: 'identity', revision: revision++, ...patch }));
      await expect(manager.resume('identity')).rejects.toMatchObject({ code: 'provider_mismatch' });
      expect(loop.exportSession()).toEqual(before);
      expect(permission.getSessionRules()).toEqual({ allow: [], ask: [], deny: [] });
    }
    await saveSession(buildFile(tmp, { id: 'legacy', provider: undefined, endpointKey: undefined }));
    await expect(manager.resume('legacy')).rejects.toMatchObject({ code: 'provider_mismatch' });
    await manager.resume('legacy', { allowLegacyProvider: true });
    await manager.save();
    expect(await loadSession(tmp, 'legacy')).toMatchObject({ provider: 'fake', endpointKey: 'default' });
  });

  it('历史按顺序一对一校验，重复、逆序或跨正文配对均拒绝', async () => {
    const use: Message = { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read_file', input: {} }] };
    const result: Message = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok' }] };
    const invalid: Message[][] = [
      [result, use], [use, result, result], [{ ...use, content: [...use.content, ...use.content] }, result], [use, { ...use, content: [...use.content, ...use.content] }, result],
      [use, { role: 'user', content: 'interrupted' }, result],
      [use, { role: 'assistant', content: [{ type: 'text', text: 'interrupted' }] }, result],
      [use, result, use],
    ];
    for (const messages of invalid) {
      expect(() => assertSafeHistory(messages)).toThrow(/配对/);
      await fs.mkdir(sessionsDir(tmp), { recursive: true });
      await fs.writeFile(sessionPath(tmp, 'invalid-order'), JSON.stringify(buildFile(tmp, { id: 'invalid-order', messages })));
      await expect(loadSession(tmp, 'invalid-order')).rejects.toMatchObject({ code: 'invariant' });
    }
    expect(findOrphanToolResults([result, use])).toEqual([{ index: 0, id: 'x' }]);
    expect(findOrphanToolResults([use, result, result])).toEqual([{ index: 2, id: 'x' }]);
    const multi: Message = { role: 'assistant', content: [
      { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
      { type: 'tool_use', id: 'b', name: 'read_file', input: {} },
    ] };
    expect(() => assertSafeHistory([multi, { role: 'user', content: [
      { type: 'tool_result', toolUseId: 'b', content: 'b' }, { type: 'tool_result', toolUseId: 'a', content: 'a' },
    ] }])).not.toThrow();
  });
  it('cwd 不一致时拒绝，且不改 loop 与会话规则', async () => {
    const { loop, permission, manager } = makeHarness({ autoSave: false });
    loop.importSession({ messages: [{ role: 'user', content: '留在内存里' }] });
    permission.addSessionRule('allow', 'read_file');
    permission.setMode('auto');
    const file = buildFile(tmp, { id: 'mismatch1', cwd: resolve(tmp, 'elsewhere'), messages: [{ role: 'user', content: '别的项目' }] });
    await fs.mkdir(sessionsDir(tmp), { recursive: true });
    await fs.writeFile(sessionPath(tmp, file.id), `${JSON.stringify(file, null, 2)}\n`);

    await expect(manager.resume('mismatch1')).rejects.toMatchObject({ code: 'cwd_mismatch' });
    expect(loop.getMessages()).toEqual([{ role: 'user', content: '留在内存里' }]);
    expect(permission.getSessionRules()).toEqual({ allow: ['read_file'], ask: [], deny: [] });
    expect(permission.mode).toBe('auto');

    const slash = buildFile(tmp, { id: 'slash1', cwd: `${resolve(tmp)}${sep}`, messages: [{ role: 'user', content: '同目录' }] });
    await fs.writeFile(sessionPath(tmp, slash.id), `${JSON.stringify(slash, null, 2)}\n`);
    await manager.resume('slash1');
    expect(loop.getMessages()).toEqual([{ role: 'user', content: '同目录' }]);
  });

  it.skipIf(process.platform !== 'win32')('Windows 上 cwd 只有大小写不同时可以恢复', async () => {
    const { loop, manager } = makeHarness({ autoSave: false });
    const flipped = resolve(tmp).replace(/[A-Za-z]/g, (char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()));
    const file = buildFile(tmp, { id: 'case1', cwd: flipped, messages: [{ role: 'user', content: '大小写' }] });
    await fs.mkdir(sessionsDir(tmp), { recursive: true });
    await fs.writeFile(sessionPath(tmp, file.id), `${JSON.stringify(file, null, 2)}\n`);
    await manager.resume('case1');
    expect(loop.getMessages()).toEqual([{ role: 'user', content: '大小写' }]);
  });

  it('未完成的 tool_use 在保存前裁掉；直接保存未裁剪历史会拒绝且不产生文件；头部孤儿结果会被裁', async () => {
    const orphanHead = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'missing', content: 'x' }] },
      { role: 'user', content: 'real' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ] as Message[];
    const head = trimToSafeTail(orphanHead);
    expect(head.messages[0]).toEqual({ role: 'user', content: 'real' });
    expect(head.reason).toBe('orphan_tool_result');
    expect(orphanHead).toHaveLength(3);

    const emptyTail = [
      { role: 'user', content: 'keep' },
      { role: 'assistant', content: [] },
    ] as Message[];
    expect(trimToSafeTail(emptyTail)).toMatchObject({ reason: 'empty_tail', dropped: 1, messages: [{ role: 'user', content: 'keep' }] });

    const { loop, manager } = makeHarness({
      maxTurns: 4,
      script: [
        textResponse('已完成'),
        [
          { type: 'message_start' },
          { type: 'tool_use_start', id: 'dangling', name: 'read_file' },
          { type: 'tool_use_delta', input: '{}' },
          { type: 'tool_use_stop' },
          { type: 'message_stop', stopReason: 'max_tokens' },
          { type: 'usage', inputTokens: 1, outputTokens: 1 },
        ],
      ],
    });
    await loop.run('先完成');
    await loop.run('再中断工具');
    await manager.flush();
    expect(JSON.stringify(loop.getMessages())).toContain('dangling');
    const loaded = await loadSession(tmp, manager.id);
    expect(JSON.stringify(loaded.messages)).toContain('已完成');
    expect(JSON.stringify(loaded.messages)).not.toContain('dangling');

    const bad = buildFile(tmp, { id: 'untrimmed1', messages: structuredClone(loop.getMessages()) as Message[] });
    await expect(saveSession(bad)).rejects.toMatchObject({ code: 'invariant' });
    await expect(fs.access(sessionPath(tmp, 'untrimmed1'))).rejects.toThrow();
  });

  it('中断后仍保留已经完成的轮次', async () => {
    const events = new EventBus();
    const { loop, manager } = makeHarness({
      events,
      mode: 'ask',
      script: [
        textResponse('已经做完'),
        toolUseResponse([{ id: 'later', name: 'read_file', input: { path: 'a.txt' } }]),
      ],
    });
    await loop.run('第一轮');
    events.on('permission_request', () => loop.abort_current());
    const aborted = await loop.run('第二轮');
    expect(aborted.reason).toBe('aborted');
    await manager.flush();
    const loaded = await loadSession(tmp, manager.id);
    expect(JSON.stringify(loaded.messages)).toContain('已经做完');
    expect(JSON.stringify(loaded.messages)).toContain('第一轮');
  });

  it('completed / max_turns / max_tokens / error 都自动保存到同一个 id，runs 递增', async () => {
    const { loop, manager } = makeHarness({
      maxTurns: 1,
      makeId: () => 'same-session',
      script: [
        textResponse('完成了'),
        toolUseResponse([{ id: 'once', name: 'read_file', input: { path: 'missing.txt' } }]),
        [
          { type: 'message_start' },
          { type: 'text_delta', text: '截断' },
          { type: 'message_stop', stopReason: 'max_tokens' },
          { type: 'usage', inputTokens: 10, outputTokens: 10 },
        ],
        () => { throw new Error('boom'); },
      ],
    });
    expect((await loop.run('a')).reason).toBe('completed');
    await manager.flush();
    expect((await loadSession(tmp, 'same-session')).stats.runs).toBe(1);

    expect((await loop.run('b')).reason).toBe('max_turns');
    await manager.flush();
    expect((await loadSession(tmp, 'same-session')).stats.runs).toBe(2);

    expect((await loop.run('c')).reason).toBe('max_tokens');
    await manager.flush();
    expect((await loadSession(tmp, 'same-session')).stats.runs).toBe(3);

    expect((await loop.run('d')).reason).toBe('error');
    await manager.flush();
    const loaded = await loadSession(tmp, 'same-session');
    expect(loaded.id).toBe('same-session');
    expect(loaded.stats.runs).toBe(4);
    expect(manager.id).toBe('same-session');
  });

  it('恢复后下一轮看到旧历史，工具重新快照，不重放 tool_call，已知模型联动压缩阈值', async () => {
    let seen: ChatRequest | undefined;
    const { loop, provider, tools, context, manager, events } = makeHarness({
      mode: 'auto',
      compactThreshold: 1_000_000,
      modelInfo: (model) => MODEL_PRESETS[model],
      script: [
        toolUseResponse([{ id: 'old-tool', name: 'read_file', input: { path: 'missing.txt' } }]),
        textResponse('历史回复'),
        (req) => {
          seen = req;
          return textResponse('下一句回复');
        },
      ],
    });
    let toolCalls = 0;
    events.on('tool_call', () => { toolCalls += 1; });
    loop.setModel('claude-sonnet-4-5');
    loop.setThinking('medium');
    await loop.run('你好');
    await manager.flush();
    const callsAfterFirst = toolCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    tools.register({
      name: 'extra_tool',
      description: '后注册的工具',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      async execute() { return { content: 'x' }; },
    });
    loop.setModel('fake');
    loop.setThinking('off');
    expect(context.threshold).toBe(1_000_000);

    await manager.resume(manager.id);
    expect(loop.model).toBe('claude-sonnet-4-5');
    expect(loop.thinking).toBe('medium');
    expect(context.threshold).toBe(160_000);
    await loop.run('下一句');
    expect(toolCalls).toBe(callsAfterFirst);
    expect(seen?.model).toBe('claude-sonnet-4-5');
    expect(seen?.thinking).toBe('medium');
    expect(seen?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['read_file', 'extra_tool']));
    expect(seen?.messages.some((message) => message.role === 'user' && message.content === '你好')).toBe(true);
    expect(seen?.messages.at(-1)).toMatchObject({ role: 'user', content: '下一句' });
    expect(provider.requests.at(-1)?.messages).toEqual(seen?.messages);
  });
});

describe('权限与标题', () => {
  it('恢复时先清空再写入会话规则，配置规则仍在，非法规则不改状态', async () => {
    const rules = { allow: ['glob'], ask: [] as string[], deny: [] as string[] };
    const { loop, permission, manager } = makeHarness({ mode: 'ask', rules, autoSave: false });
    permission.addSessionRule('allow', 'edit_file');
    permission.addSessionRule('ask', 'write_file');
    expect(permission.check(writeFileTool, { path: 'a.txt', content: 'b' }).source).toBe('session');

    const file = buildFile(tmp, {
      id: 'rules1',
      permissionMode: 'ask',
      sessionRules: { allow: ['read_file'], ask: ['write_file'], deny: ['bash'] },
      messages: [{ role: 'user', content: '规则会话' }],
    });
    await saveSession(file);
    await manager.resume('rules1');
    expect(permission.getSessionRules()).toEqual({ allow: ['read_file'], ask: ['write_file'], deny: ['bash'] });
    expect(permission.check(readFileTool, { path: 'a.ts' })).toMatchObject({ kind: 'allow', source: 'session' });
    expect(permission.check(bashTool, { command: 'ls' })).toMatchObject({ kind: 'deny', source: 'session' });
    expect(permission.check(globTool, { pattern: '*' })).toMatchObject({ kind: 'allow', source: 'config' });
    expect(permission.check(writeFileTool, { path: 'a.txt', content: 'b' })).toMatchObject({ kind: 'ask', source: 'session' });
    expect(permission.check(readFileTool, { path: 'a.ts' }).kind).toBe('allow');

    const beforeRules = permission.getSessionRules();
    const beforeMessages = structuredClone(loop.getMessages());
    permission.setMode('auto');
    const bad = buildFile(tmp, {
      id: 'rules-bad',
      permissionMode: 'yolo',
      sessionRules: { allow: ['???(('], ask: [], deny: [] },
      messages: [{ role: 'user', content: '不该进来' }],
    });
    await saveSession(bad);
    await expect(manager.resume('rules-bad')).rejects.toMatchObject({ code: 'invalid_schema' });
    expect(permission.getSessionRules()).toEqual(beforeRules);
    expect(loop.getMessages()).toEqual(beforeMessages);
    expect(permission.mode).toBe('auto');
    expect(() => permission.setSessionRules({ allow: ['???'], deny: ['bash'] })).toThrow();
    expect(permission.getSessionRules()).toEqual(beforeRules);
  });

  it('更宽的保存模式不会自动放宽，更窄的会收紧', async () => {
    const notices: string[] = [];
    const events = new EventBus();
    events.on('notice', (event) => notices.push(event.text));
    const { permission, manager } = makeHarness({ events, mode: 'ask', autoSave: false });
    await saveSession(buildFile(tmp, { id: 'wide1', permissionMode: 'yolo', messages: [{ role: 'user', content: '宽' }] }));
    await manager.resume('wide1');
    expect(permission.mode).toBe('ask');
    expect(notices.some((text) => text.includes('yolo') && text.includes('ask'))).toBe(true);

    const { permission: wide, manager: wideManager } = makeHarness({ mode: 'yolo', autoSave: false });
    await saveSession(buildFile(tmp, { id: 'narrow1', permissionMode: 'ask', messages: [{ role: 'user', content: '窄' }] }));
    await wideManager.resume('narrow1');
    expect(wide.mode).toBe('ask');
  });

  it('标题按码点截断、折叠空白、跳过摘要，并且一旦生成就粘住', () => {
    expect(makeTitle([{ role: 'user', content: '  a \n\t b  ' }])).toBe('a b');
    expect(makeTitle([{ role: 'user', content: 'a'.repeat(40) }])).toBe('a'.repeat(40));
    expect(makeTitle([{ role: 'user', content: 'a'.repeat(41) }])).toBe(`${'a'.repeat(40)}…`);
    const emoji = '😀'.repeat(41);
    const titled = makeTitle([{ role: 'user', content: emoji }]);
    expect([...titled].length).toBe(41);
    expect(titled.endsWith('…')).toBe(true);
    expect(titled.includes('\uD83D') && !titled.includes('😀')).toBe(false);
    expect(makeTitle([
      { role: 'user', source: 'summary', content: `${SUMMARY_MARKER} 旧摘要` },
      { role: 'user', content: '真正的标题' },
    ])).toBe('真正的标题');
    expect(makeTitle([{ role: 'user', content: '   \n' }])).toBe('(未命名会话)');
    expect(makeTitle([{ role: 'user', content: `${SUMMARY_MARKER} 用户原文` }])).toBe(`${SUMMARY_MARKER} 用户原文`);
    expect(makeTitle([])).toBe('(未命名会话)');
    expect(makeTitle([{ role: 'user', content: [{ type: 'text', text: '从块里来' }] }])).toBe('从块里来');
  });

  it('已有标题不会被后续保存改写', async () => {
    const { manager } = makeHarness({ autoSave: false });
    await saveSession(buildFile(tmp, {
      id: 'sticky01',
      title: '粘住的标题',
      messages: [{ role: 'user', content: '别的内容' }],
    }));
    await manager.resume('sticky01');
    expect(manager.title).toBe('粘住的标题');
    await manager.save();
    expect((await loadSession(tmp, 'sticky01')).title).toBe('粘住的标题');
  });
});

describe('列表、并发与空历史', () => {
  it('按更新时间排序，删除幂等，非法 id 不能逃出目录', async () => {
    expect(newSessionId(new Date(2026, 9, 5, 19, 2, 33))).toMatch(/^s-20261005-190233-[0-9a-f]{4}$/);
    await saveSession(buildFile(tmp, { id: 'id-a', updatedAt: '2020-01-01T00:00:00.000Z', title: 'a' }));
    await saveSession(buildFile(tmp, { id: 'id-b', updatedAt: '2021-01-01T00:00:00.000Z', title: 'b' }));
    await saveSession(buildFile(tmp, { id: 'id-c', updatedAt: '2021-01-01T00:00:00.000Z', title: 'c' }));
    expect((await listSessions(tmp)).sessions.map((item) => item.id)).toEqual(['id-c', 'id-b', 'id-a']);
    expect(await latestSessionId(tmp)).toBe('id-c');
    expect(await deleteSession(tmp, 'id-c')).toBe(true);
    expect(await deleteSession(tmp, 'id-c')).toBe(false);
    expect(await latestSessionId(tmp)).toBe('id-b');
    await expect(deleteSession(tmp, '../id-a')).rejects.toMatchObject({ code: 'invalid_id' });
    expect(() => sessionPath(tmp, 'a/b')).toThrow(/不合法/);
    await expect(fs.access(sessionPath(tmp, 'id-a'))).resolves.toBeUndefined();
  });

  it('并发三次保存，磁盘上是最后一次，且没有残留临时文件', async () => {
    const { loop, manager } = makeHarness({ autoSave: false, makeId: () => 'concurrent1' });
    const write = (text: string) => {
      loop.importSession({ messages: [{ role: 'user', content: text }] });
      return manager.save();
    };
    await Promise.all([write('v1'), write('v2'), write('v3')]);
    expect(await loadSession(tmp, 'concurrent1')).toMatchObject({
      messages: [{ role: 'user', content: 'v3' }],
    });
    expect((await fs.readdir(sessionsDir(tmp))).some((name) => name.includes('.tmp'))).toBe(false);
  });

  it('运行中恢复会拒绝，并且不替换历史', async () => {
    const events = new EventBus();
    const { loop, manager } = makeHarness({
      events,
      mode: 'ask',
      autoSave: false,
      script: [toolUseResponse([{ id: 'z', name: 'read_file', input: { path: 'a' } }])],
    });
    await saveSession(buildFile(tmp, { id: 'other-session', messages: [{ role: 'user', content: 'saved-history' }] }));
    let entered!: () => void;
    const waiting = new Promise<void>((resolveWait) => { entered = resolveWait; });
    events.on('permission_request', () => entered());
    const running = loop.run('first-input');
    await waiting;
    expect(loop.running).toBe(true);
    await expect(manager.resume('other-session')).rejects.toMatchObject({ code: 'busy' });
    expect(loop.getMessages().some((message) => message.role === 'user' && message.content === 'first-input')).toBe(true);
    expect(loop.getMessages().some((message) => message.content === 'saved-history')).toBe(false);
    loop.abort_current();
    await running;
  });

  it('空历史保存返回 undefined，并且不创建会话目录', async () => {
    const { manager } = makeHarness();
    expect(await manager.save()).toBeUndefined();
    await expect(fs.access(sessionsDir(tmp))).rejects.toThrow();
  });
});


describe('保存完成与失败反馈', () => {
  it('自动保存失败使 headless run 和 flush 可观察，保留 error 事件', async () => {
    const { loop, manager, events } = makeHarness({ script: [textResponse('done')] });
    const errors: Error[] = [];
    events.on('error', (event) => errors.push(event.error));
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    await expect(loop.run('hello')).rejects.toThrow(/保存失败/);
    expect(loop.running).toBe(false);
    expect(errors.some((error) => error.message.includes('EIO'))).toBe(true);
    await expect(manager.flush()).rejects.toThrow(/保存失败/);
    vi.restoreAllMocks();
    await manager.save();
    await expect(manager.flush()).resolves.toBeUndefined();
  });

  it('底层 flush 报告已经完成的失败，后续写入仍可重试', async () => {
    const path = sessionPath(tmp, 'failed-queue');
    await expect(enqueueWrite(path, async () => { throw new Error('queue failure'); })).rejects.toThrow('queue failure');
    await expect(flushWrites(path)).rejects.toThrow(/写入失败/);
    await enqueueWrite(path, async () => undefined);
    await expect(flushWrites(path)).resolves.toBeUndefined();
  });

  it('延迟保存后切换会话，返回摘要仍属于原快照，flush 等待旧路径', async () => {
    const { loop, manager } = makeHarness({ autoSave: false, makeId: () => 'original' });
    loop.importSession({ messages: [{ role: 'user', content: 'original title' }], model: 'old-model' });
    await saveSession(buildFile(tmp, { id: 'other', title: 'other title', model: 'new-model' }));
    const realRename = fs.rename.bind(fs);
    let entered!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === sessionPath(tmp, 'original')) { entered(); await gate; }
      return realRename(from, to);
    });
    const saving = manager.save();
    await started;
    await manager.resume('other');
    let flushed = false;
    const flushing = manager.flush().then(() => { flushed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    release();
    const result = await saving;
    await flushing;
    expect(result).toMatchObject({ id: 'original', title: 'original title', model: 'old-model', path: sessionPath(tmp, 'original') });
    expect(manager.id).toBe('other');
    expect(await loadSession(tmp, 'original')).toMatchObject({ title: 'original title', model: 'old-model' });
    expect(await loadSession(tmp, 'other')).toMatchObject({ title: 'other title', model: 'new-model' });
  });
});


describe('删除与跨进程版本冲突', () => {
  it('删除等待删除前的旧排队保存，成功后不复活；新的明确保存可重建', async () => {
    const { loop, manager } = makeHarness({ autoSave: false, makeId: () => 'delete-queue' });
    loop.importSession({ messages: [{ role: 'user', content: 'first' }] });
    const realRename = fs.rename.bind(fs);
    let entered!: () => void;
    let release!: () => void;
    let delayed = false;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!delayed && String(to) === sessionPath(tmp, manager.id)) { delayed = true; entered(); await gate; }
      return realRename(from, to);
    });
    const first = manager.save();
    await started;
    loop.importSession({ messages: [{ role: 'user', content: 'queued old' }] });
    const second = manager.save();
    const deleting = manager.delete(manager.id);
    release();
    await Promise.all([first, second]);
    expect(await deleting).toBe(true);
    await manager.flush();
    await expect(loadSession(tmp, manager.id)).rejects.toMatchObject({ code: 'not_found' });
    await manager.save();
    expect(await loadSession(tmp, manager.id)).toMatchObject({ revision: 4, messages: [{ role: 'user', content: 'queued old' }] });
    expect((await fs.readdir(sessionsDir(tmp))).some((name) => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false);
  });

  it('旧 v1 无版本历史删除后，旧写入拒绝；重建也不产生版本 ABA', async () => {
    const file = buildFile(tmp, { id: 'legacy-deleted' });
    await fs.mkdir(sessionsDir(tmp), { recursive: true });
    await fs.writeFile(sessionPath(tmp, file.id), JSON.stringify(file));
    const stale = await loadSession(tmp, file.id);
    expect(stale.revision).toBeUndefined();
    expect(await deleteSession(tmp, file.id)).toBe(true);
    await expect(saveSession(stale)).rejects.toMatchObject({ code: 'conflict' });
    await saveSession(stale, { recreate: true });
    expect((await loadSession(tmp, file.id)).revision).toBe(2);
    await expect(saveSession(stale)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('两个管理器恢复同一版本后，过期写入保留内存和磁盘历史', async () => {
    await saveSession(buildFile(tmp, { id: 'two-managers' }));
    const first = makeHarness({ autoSave: false });
    const second = makeHarness({ autoSave: false });
    await first.manager.resume('two-managers');
    await second.manager.resume('two-managers');
    first.loop.importSession({ messages: [{ role: 'user', content: 'first branch' }] });
    second.loop.importSession({ messages: [{ role: 'user', content: 'second branch' }] });
    await first.manager.save();
    await expect(second.manager.save()).rejects.toMatchObject({ code: 'conflict' });
    expect(second.loop.getMessages()).toEqual([{ role: 'user', content: 'second branch' }]);
    expect((await loadSession(tmp, 'two-managers')).messages).toEqual([{ role: 'user', content: 'first branch' }]);
  });

  it('两个真实进程恢复相同版本同时保存，恰好一个提交，另一个报 conflict', { timeout: 15000 }, async () => {
    await fs.writeFile(join(tmp, 'agent.config.json'), JSON.stringify({ provider: 'fake' }));
    await saveSession(buildFile(tmp, { id: 'two-processes' }));
    const entry = fileURLToPath(new URL('./fixtures/session-writer.ts', import.meta.url));
    const children: ChildProcess[] = [];
    function writer(text: string) {
      const child = fork(entry, [tmp, 'two-processes', text], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', (data) => { stderr += String(data); });
      let ready!: () => void;
      let result!: (value: { ok: boolean; code?: string }) => void;
      let reject!: (error: Error) => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const done = new Promise<{ ok: boolean; code?: string }>((resolve, rejectResult) => { result = resolve; reject = rejectResult; });
      child.on('message', (message: { type?: string; ok: boolean; code?: string }) => {
        if (message.type === 'ready') ready();
        if (message.type === 'result') result(message);
      });
      child.on('error', reject);
      child.on('exit', (code) => { if (code) reject(new Error(`writer exited ${code}: ${stderr}`)); });
      return { child, started, done };
    }
    try {
      const a = writer('process-A');
      const b = writer('process-B');
      await Promise.all([a.started, b.started]);
      a.child.send('save'); b.child.send('save');
      const results = await Promise.all([a.done, b.done]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.code).toBe('conflict');
      const file = await loadSession(tmp, 'two-processes');
      expect(file.revision).toBe(2);
      const text = JSON.stringify(file.messages);
      expect(Number(text.includes('process-A')) + Number(text.includes('process-B'))).toBe(1);
    } finally { for (const child of children) child.kill(); }
  });
});
