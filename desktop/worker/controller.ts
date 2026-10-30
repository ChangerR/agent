import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { createAgent, type Agent, type AgentEvent, type Message } from '../../src/index.js';
import { defaultPreset } from '../../src/builtin/default-preset.js';
import type { InteractionRequest } from '../../src/sdk/index.js';
import {
  actionSchema,
  type DesktopAction,
  type RuntimeSnapshot,
  type Row,
} from '../shared/protocol.js';
import { inspectLocalProject } from './inspection.js';
import { demoProviderPlugin } from './demo.js';
import { SessionDebugTrace, sessionDebugPlugin } from './debug-trace.js';
import { planningErrorMessage } from '../../src/builtin/planning/errors.js';
import { settingsErrorMessage } from '../../src/runtime/config-store.js';
import { safeSettingsValue } from '../../src/builtin/configuration-settings.js';
import { loadConfigWithSources } from '../../src/core/config.js';
async function effectiveSettings(
  section: import('../../src/sdk/index.js').SettingsSection,
  signal: AbortSignal,
  scope: 'global' | 'project',
) {
  try {
    return {
      effectiveValue: safeSettingsValue(await section.readEffective?.(signal, scope)),
      effectiveError: undefined,
    };
  } catch (error) {
    return { effectiveValue: undefined, effectiveError: settingsErrorMessage(error) };
  }
}
import type { SettingsSection } from '../../src/sdk/index.js';

/** 跨进程只传展示快照与脱敏调试副本；审批函数、凭证与执行对象保留在 worker。 */
export class DesktopController {
  private debug = new SessionDebugTrace();
  private agent?: Agent;
  private state?: RuntimeSnapshot;
  private active?: Promise<unknown>;
  private stopping = false;
  private operationAbort?: AbortController;
  private disposed = false;
  private disposal?: Promise<void>;
  private seq = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private textId?: string;
  private thinkingId?: string;
  private toolRows = new Map<string, Row>();
  private approved = new Map<
    string,
    {
      resolve: (decision: { allow: true } | { allow: false; feedback?: string }) => void;
      signal: AbortSignal;
      remove: () => void;
    }
  >();
  private interactions = new Map<
    string,
    { resolve: (value: string | undefined) => void; remove: () => void }
  >();
  private submissions = new Set<string>();
  private detach: Array<() => void> = [];
  private settingsOperation = false;
  private settingsAbort?: AbortController;
  private settingsFinished?: Promise<void>;
  private editor?: { id: string; section: SettingsSection; scope: 'project' | 'global' };
  constructor(
    private publish: (state: RuntimeSnapshot) => void,
    private factory: typeof createAgent = createAgent,
  ) {}
  get snapshot(): RuntimeSnapshot | undefined {
    return this.state ? structuredClone(this.state) : undefined;
  }
  private error(error: unknown): string {
    const planning = planningErrorMessage(error);
    if (planning) return planning;
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'operation_failed';
    const safeCode = /^[a-zA-Z0-9_-]{1,40}$/.test(code) ? code : 'operation_failed';
    return '操作未完成（' + safeCode + '）。请检查项目配置、文件权限或会话冲突；未自动重试。';
  }
  private emit(immediate = false) {
    if (!this.state || this.disposed) return;
    if (!immediate) {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.emit(true);
      }, 50);
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const a = this.agent;
    if (a) {
      this.state.model = a.loop.model;
      this.state.mode = a.permission.mode;
      this.state.thinking = a.loop.thinking;
      if (!this.state.models.includes(a.loop.model)) this.state.models.push(a.loop.model);
      this.state.sessionId = a.session.id;
      this.state.title = a.session.title || '新会话';
      this.state.usage = a.session.tokenUsage;
      this.state.debug = this.debug.snapshot();
    }
    this.state.seq = ++this.seq;
    this.publish(structuredClone({ ...this.state, rows: this.state.rows.slice(-500) }));
  }
  async initialize(
    cwd: string,
    demo: boolean,
    generation: string,
    credentials: Record<string, { key: string; binding: string }> = {},
  ) {
    if (this.agent || this.disposed) throw new Error('运行时不能重复初始化');
    this.agent = await this.factory(
      cwd,
      demo
        ? {
            config: {
              provider: 'fake',
              model: 'fake-desktop',
              apiKeyEnv: 'AGENTLAB_DEMO_KEY',
              pluginEntries: [],
              disabledPlugins: [],
              mcpConfig: '.desktop-demo-no-mcp.json',
              capabilities: { reviewer: false },
              pluginConfig: { 'agentlab.planning': { mode: 'off' } },
              permissions: { allow: [], deny: [], ask: ['write_file'] },
            },
            preset: (input) => {
              const preset = defaultPreset(input);
              return {
                ...preset,
                plugins: [
                  ...preset.plugins.filter((p) => p.manifest.id !== 'agentlab.provider-fake'),
                  demoProviderPlugin(),
                ],
              };
            },
            plugins: [sessionDebugPlugin(this.debug)],
          }
        : {
            plugins: [sessionDebugPlugin(this.debug)],
            resolveCredential(reference, identity) {
              const item = credentials[reference];
              if (!item || item.binding !== identity)
                throw new Error(
                  '保存的 API key 不可用或实际端点已变化，请检查全局安全存储；未发送请求。',
                );
              return item.key;
            },
          },
    );
    const a = this.agent;
    this.debug.configure(a.paths.projectStateDir, a.session.id);
    this.state = {
      generation,
      seq: 0,
      cwd: a.cwd,
      projectName: basename(a.cwd),
      sessionId: a.session.id,
      title: '新会话',
      demo,
      busy: false,
      phase: '就绪',
      rows: [],
      approvals: [],
      model: a.loop.model,
      mode: a.permission.mode,
      thinking: a.loop.thinking,
      provider: a.config.provider,
      sources: {
        model: a.configSources.model.scope,
        mode: a.configSources.permissionMode.scope,
        thinking: a.configSources.thinking.scope,
      },
      models: [...new Set([a.loop.model, ...a.knownModels.map((m) => m.name)])],
      providers: a.providers.list().map((p) => p.name),
      modelDetails: a.knownModels.map(({ name, info }) => ({ id: name, ...info })),
      usage: a.session.tokenUsage,
      sessions: [],
      brokenSessions: 0,
      plugins: a.plugins.manifests.map((p) => ({ id: p.id, version: p.version })),
      tools: a.tools.list().map((t) => ({ name: t.name, risk: t.risk })),
      commands: a.commands.list(),
      settings: a.settings
        .filter(
          ({ id, section }) =>
            id.startsWith('configuration-') ||
            (!['planning', 'subagents', 'reviewer-model-config'].includes(id) &&
              !!section.draft &&
              !!section.commit &&
              section.scopeTargets?.some((target) =>
                ['project', 'global'].includes(target.scope),
              )) ||
            [
              'capability-selection',
              'policy-deterministic-config',
              'config-paths',
              'mcp',
              'reviewer-model-status',
            ].includes(id),
        )
        .map(({ id, section }) => ({
          id,
          title: section.title,
          description: section.description,
          schema: section.getSchema?.() ?? section.schema,
          applyMode: section.applyMode,
          scopes: (section.scopeTargets ?? []).filter(
            (target) => target.scope !== 'session',
          ) as Array<{ scope: 'project' | 'global'; path: string }>,
          editable: !!section.draft && !!section.commit,
        })),
      inspection: { kind: 'files', content: '点击刷新，通过权限执行器列出项目文件。' },
    };
    this.detach.push(a.events.on('permission_request', (event) => this.permission(event)));
    this.detach.push(a.events.onAll((event) => this.event(event)));
    await this.refreshSessions();
    this.emit(true);
  }
  private permission(event: Extract<AgentEvent, { type: 'permission_request' }>) {
    if (this.disposed || event.signal.aborted) {
      event.resolve({ allow: false, feedback: '桌面请求已取消' });
      return;
    }
    const id = randomUUID();
    const cancel = () => {
      this.approved.delete(id);
      this.state!.approvals = this.state!.approvals.filter((p) => p.id !== id);
      this.emit(true);
    };
    event.signal.addEventListener('abort', cancel, { once: true });
    this.approved.set(id, {
      resolve: event.resolve,
      signal: event.signal,
      remove: () => event.signal.removeEventListener('abort', cancel),
    });
    this.state!.approvals.push({
      id,
      summary: event.request.summary,
      reason: event.request.reason,
      toolName: event.request.toolName,
      input: JSON.stringify(event.request.input, null, 2),
      cwd: event.request.cwd ?? this.agent!.cwd,
      agentName: event.request.agentName,
      interpreter:
        event.request.toolName === 'bash'
          ? process.platform === 'win32'
            ? 'PowerShell'
            : 'Bash'
          : undefined,
    });
    this.state!.phase = '等待人工确认';
    this.emit(true);
  }
  private row(kind: Row['kind'], text: string, id: string = randomUUID()) {
    const row: Row = { id, kind, text };
    this.state!.rows.push(row);
    return row;
  }
  private event(event: AgentEvent) {
    const s = this.state;
    if (!s) return;
    switch (event.type) {
      case 'text_delta':
      case 'thinking_delta': {
        const thinking = event.type === 'thinking_delta';
        let id = thinking ? this.thinkingId : this.textId;
        if (!id) {
          id = randomUUID();
          this.row(thinking ? 'thinking' : 'assistant', '', id);
          if (thinking) this.thinkingId = id;
          else this.textId = id;
        }
        const row = s.rows.find((r) => r.id === id)!;
        row.text = (row.text + event.text).slice(-200_000);
        s.phase = thinking ? '正在思考' : '生成回复';
        break;
      }
      case 'assistant_message': {
        const text = event.message.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (this.textId) {
          const row = s.rows.find((r) => r.id === this.textId);
          if (row) row.text = text;
        } else if (text) this.row('assistant', text);
        this.textId = undefined;
        this.thinkingId = undefined;
        break;
      }
      case 'tool_call': {
        this.textId = undefined;
        this.thinkingId = undefined;
        s.phase = '执行工具';
        const row: Row = {
          id: randomUUID(),
          kind: 'tool',
          toolName: event.toolUse.name,
          input: JSON.stringify(event.toolUse.input, null, 2),
          text: '等待执行',
          status: 'running',
          startedAt: Date.now(),
        };
        s.rows.push(row);
        this.toolRows.set(event.toolUse.id, row);
        break;
      }
      case 'tool_result': {
        const row = this.toolRows.get(event.toolUseId);
        if (row) {
          row.text = event.result.content.slice(0, 100_000);
          row.status = event.result.isError ? 'error' : 'completed';
          row.durationMs = Date.now() - (row.startedAt ?? Date.now());
        }
        break;
      }
      case 'permission_decision':
        if (event.phase === 'judge') s.phase = '模型审批';
        break;
      case 'loop_end':
        s.phase = '结算与保存';
        break;
      case 'compacted':
        this.row(
          'notice',
          '上下文已压缩：' + event.beforeMessages + ' → ' + event.afterMessages + ' 条消息',
        );
        break;
      case 'error':
        s.error = this.error(event.error);
        break;
      case 'notice':
        this.row('notice', event.text);
        break;
      case 'session_restored':
        s.rows = this.history(event.messages);
        s.sources.model = 'session';
        s.sources.thinking = 'session';
        this.textId = undefined;
        this.thinkingId = undefined;
        break;
    }
    // 等待审批/停止的状态不被后台文本与工具事件覆盖。
    if (s.approvals.length) s.phase = '等待人工确认';
    if (this.stopping) s.phase = '正在停止';
    this.emit(event.type !== 'text_delta' && event.type !== 'thinking_delta');
  }
  private history(messages: readonly Message[]): Row[] {
    const rows: Row[] = [];
    const pending = new Map<string, Row>();
    for (const message of messages) {
      if (message.role === 'assistant')
        for (const b of message.content) {
          if (b.type === 'text') rows.push({ id: randomUUID(), kind: 'assistant', text: b.text });
          if (b.type === 'thinking')
            rows.push({ id: randomUUID(), kind: 'thinking', text: b.thinking });
          if (b.type === 'tool_use') {
            const row: Row = {
              id: randomUUID(),
              kind: 'tool',
              toolName: b.name,
              input: JSON.stringify(b.input, null, 2),
              text: '历史调用',
              status: 'completed',
            };
            rows.push(row);
            pending.set(b.id, row);
          }
        }
      else if (typeof message.content === 'string') {
        if (message.source !== 'runtime')
          rows.push({
            id: randomUUID(),
            kind: message.source ? 'notice' : 'user',
            text: message.content,
          });
      } else
        for (const b of message.content) {
          if (b.type === 'tool_result') {
            const row = pending.get(b.toolUseId);
            if (row) {
              row.text = b.content;
              row.status = b.isError ? 'error' : 'completed';
              pending.delete(b.toolUseId);
            }
          } else rows.push({ id: randomUUID(), kind: 'notice', text: b.text });
        }
    }
    return rows;
  }
  private async refreshSessions() {
    const listing = await this.agent!.session.list();
    this.state!.sessions = listing.sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
    }));
    this.state!.brokenSessions = listing.broken.length;
  }
  private interact(request: InteractionRequest, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise((resolve) => {
      const done = (value: string | undefined) => {
        signal.removeEventListener('abort', abort);
        this.interactions.delete(id);
        this.state!.interaction = undefined;
        resolve(value);
        this.emit(true);
      };
      const abort = () => done(undefined);
      this.interactions.set(id, {
        resolve: done,
        remove: () => signal.removeEventListener('abort', abort),
      });
      signal.addEventListener('abort', abort, { once: true });
      this.state!.interaction = {
        id,
        prompt: request.prompt,
        body: request.body,
        kind: request.kind,
        initialValue: request.initialValue,
        choices: request.choices?.map((c) => ({ ...c })),
      };
      this.emit(true);
    });
  }
  async handle(raw: unknown): Promise<void> {
    const action = actionSchema.parse(raw),
      s = this.state,
      a = this.agent;
    if (!s || !a || this.disposed || this.disposal) throw new Error('运行时不可用');
    if (action.generation !== s.generation || action.sessionId !== a.session.id)
      throw new Error('会话已变化，请刷新后重试');
    if (
      action.type === 'debug-read' ||
      action.type === 'debug-export' ||
      action.type === 'debug-close'
    ) {
      try {
        if (action.type === 'debug-read')
          this.debug.select(
            action.page,
            action.eventPage,
            action.requestId,
            action.eventId,
            action.filters,
          );
        else if (action.type === 'debug-export') this.debug.exportReport();
        else this.debug.select(0, 0);
      } catch {
        throw new Error('调试记录读取或导出失败，请检查记录文件或重新打开会话；原会话未修改。');
      }
      this.emit(true);
      return;
    }
    if (action.type === 'approve') {
      const pending = this.approved.get(action.approvalId);
      if (!pending || pending.signal.aborted) throw new Error('审批已结束，未执行迟到操作');
      this.approved.delete(action.approvalId);
      pending.remove();
      s.approvals = s.approvals.filter((p) => p.id !== action.approvalId);
      pending.resolve(action.allow ? { allow: true } : { allow: false, feedback: action.feedback });
      s.phase = '执行工具';
      this.emit(true);
      return;
    }
    if (action.type === 'interact') {
      const pending = this.interactions.get(action.interactionId);
      if (!pending) throw new Error('选择已失效');
      pending.resolve(action.value);
      return;
    }
    if (action.type === 'stop') {
      this.stopping = true;
      s.phase = '正在停止';
      this.operationAbort?.abort();
      a.loop.abort_current();
      this.emit(true);
      await this.active;
      return;
    }
    if (action.type === 'settings-close') {
      this.editor = undefined;
      s.settingsEditor = undefined;
      this.emit(true);
      return;
    }
    if (action.type === 'settings-read' || action.type === 'settings-commit') {
      if (s.busy || this.settingsOperation) throw new Error('请等待当前操作结算后编辑设置。');
      this.settingsOperation = true;
      const controller = new AbortController();
      this.settingsAbort = controller;
      let finish!: () => void;
      this.settingsFinished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        if (action.type === 'settings-read') {
          try {
            const configured = loadConfigWithSources(a.cwd).config.pluginConfig[
              'agentlab.provider-connections'
            ]?.connections;
            s.providerLabels = Object.fromEntries(
              Object.entries(
                (configured && typeof configured === 'object' ? configured : {}) as Record<
                  string,
                  { displayName?: string }
                >,
              )
                .filter(([, v]) => typeof v.displayName === 'string')
                .map(([id, v]) => [id, v.displayName!]),
            );
            s.providerOptions = [
              ...new Set([
                ...s.providers,
                ...Object.entries(
                  (configured && typeof configured === 'object' ? configured : {}) as Record<
                    string,
                    { enabled?: boolean }
                  >,
                )
                  .filter(([, v]) => v.enabled !== false)
                  .map(([id]) => id),
              ]),
            ];
          } catch {
            s.providerOptions = [...s.providers];
          }
          const metadata = s.settings.find((item) => item.id === action.sectionId);
          const record = a.settings.find((item) => item.id === action.sectionId);
          if (
            !metadata ||
            !record ||
            (metadata.scopes.length && !metadata.scopes.some((item) => item.scope === action.scope))
          )
            throw new Error('不支持此设置或作用域。');
          this.editor = undefined;
          const id = randomUUID();
          metadata.scopes = (record.section.scopeTargets ?? []).filter(
            (target) => target.scope !== 'session',
          ) as typeof metadata.scopes;
          metadata.schema = record.section.getSchema?.() ?? record.section.schema;
          metadata.description = record.section.description;
          let value = await record.section.read?.(controller.signal, action.scope);
          // 专用目录授权只投影 schema 拥有的字段；未知配置不传入 renderer。
          if (action.sectionId === 'policy-deterministic-config')
            value =
              value && typeof value === 'object' && Object.hasOwn(value, 'writeRoots')
                ? { writeRoots: (value as { writeRoots?: unknown }).writeRoots }
                : {};
          if (this.disposal || action.sessionId !== a.session.id)
            throw new Error('设置读取已失效。');
          this.editor = { id, section: record.section, scope: action.scope };
          s.settingsEditor = {
            id,
            sectionId: action.sectionId,
            scope: action.scope,
            value: safeSettingsValue(value),
            ...(await effectiveSettings(record.section, controller.signal, action.scope)),
          };
        } else {
          const editor = this.editor,
            view = s.settingsEditor;
          if (
            !editor ||
            editor.id !== action.editorId ||
            !view ||
            !editor.section.draft ||
            !editor.section.commit
          )
            throw new Error('设置草稿已过期，请重新打开。');
          view.error = undefined;
          view.saved = false;
          view.feedbackRevision = (view.feedbackRevision ?? 0) + 1;
          const signal = controller.signal;
          try {
            const draft = await editor.section.draft(JSON.parse(action.json), signal, editor.scope);
            if (this.disposal || this.editor !== editor || action.sessionId !== a.session.id)
              throw new Error('设置草稿已失效。');
            await editor.section.commit(draft, signal, editor.scope);
            let value = await editor.section.read?.(signal, editor.scope);
            if (view.sectionId === 'policy-deterministic-config')
              value = { writeRoots: (value as { writeRoots?: unknown })?.writeRoots ?? [] };
            view.value = safeSettingsValue(value);
            Object.assign(view, await effectiveSettings(editor.section, signal, editor.scope));
            view.saved = true;
            // 只有 read 返回的新基线可再提交；旧 token 一次性消费。
            editor.id = view.id = randomUUID();
          } catch (error) {
            view.error = settingsErrorMessage(error);
          }
        }
      } finally {
        this.settingsOperation = false;
        this.settingsAbort = undefined;
        finish();
        this.emit(true);
      }
      return;
    }
    if (this.settingsOperation) throw new Error('设置正在保存，请等待。');
    if (s.busy) throw new Error('当前操作尚未结算，请先停止或等待');
    this.editor = undefined;
    s.settingsEditor = undefined;
    if (action.type === 'submit') {
      if (this.submissions.has(action.invocationId)) throw new Error('此任务已提交，不会重复执行');
      this.submissions.add(action.invocationId);
      this.debug.input(action.text);
      this.row('user', action.text);
    }
    s.busy = true;
    s.error = undefined;
    s.phase =
      action.type === 'submit' ? '生成回复' : action.type === 'inspect' ? '检查项目' : '更新会话';
    this.stopping = false;
    this.emit(true);
    const controller = new AbortController();
    this.operationAbort = controller;
    const operation = async () => {
      try {
        if (action.type === 'submit') {
          if (action.text.startsWith('/')) {
            const result = await a.dispatchCommand(action.text, {
              signal: controller.signal,
              interact: (r) => this.interact(r, controller.signal),
            });
            if (result?.type === 'text') this.row('notice', result.text);
            else if (result?.type === 'data')
              this.row('notice', result.text ?? JSON.stringify(result.data, null, 2));
          } else {
            const result = await a.loop.run(action.text);
            if (result.reason === 'error') s.error ??= '模型请求失败，请检查配置与连接。';
          }
        } else if (action.type === 'setting') {
          const result = await a.dispatchCommand('/' + action.field + ' ' + action.value, {
            signal: controller.signal,
          });
          if (result?.type === 'text') this.row('notice', result.text);
          s.sources[action.field === 'think' ? 'thinking' : action.field] = 'project';
        } else if (action.type === 'resume') {
          await a.session.resume(action.id);
        } else if (action.type === 'session-save') {
          await a.dispatchCommand('/save', { signal: controller.signal });
        } else if (action.type === 'session-delete') {
          await a.dispatchCommand('/sessions rm ' + action.id, { signal: controller.signal });
        } else if (action.type === 'inspect') {
          const kind = action.kind;
          if (kind === 'read' && !action.path) throw new Error('请选择文件');
          const result = await inspectLocalProject({
            cwd: a.cwd,
            kind,
            path: action.path,
            signal: controller.signal,
          });
          s.inspection = {
            kind,
            path: action.path,
            content: result.content,
            error: result.error,
          };
        }
        await this.refreshSessions();
        s.phase = this.stopping ? '已停止' : s.error ? '操作失败' : '就绪';
      } catch (error) {
        s.error = this.error(error);
        s.phase = '操作失败';
      } finally {
        controller.abort();
        this.operationAbort = undefined;
        s.busy = false;
        this.stopping = false;
        for (const row of s.rows) if (row.status === 'running') row.status = 'cancelled';
        this.textId = undefined;
        this.thinkingId = undefined;
        this.toolRows.clear();
        this.emit(true);
      }
    };
    // 先建立宿主的在途记录，再运行；应答只确认入队，终态由完整快照通知。
    this.active = Promise.resolve().then(operation);
    void this.active.catch(() => {});
    // 简单选择项的应答表示持久化 / 应用已结算，前端随后可安全刷新配置层。
    if (
      action.type === 'setting' ||
      action.type === 'session-save' ||
      action.type === 'session-delete'
    )
      await this.active;
  }
  dispose(): Promise<void> {
    this.disposal ??= this.finishDispose();
    return this.disposal;
  }
  private async finishDispose() {
    if (this.disposed) return;
    this.agent?.loop.abort_current();
    this.operationAbort?.abort();
    this.settingsAbort?.abort();
    await this.settingsFinished;
    for (const [id, p] of this.approved) {
      p.remove();
      p.resolve({ allow: false, feedback: '桌面会话已关闭' });
      this.approved.delete(id);
    }
    for (const p of this.interactions.values()) p.resolve(undefined);
    await this.active;
    await this.agent?.dispose();
    this.detach.forEach((off) => off());
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
