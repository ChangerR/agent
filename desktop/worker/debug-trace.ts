/** 桌面调试作为 telemetry 插件挂载；只保存脱敏副本，不参与权限或模型决策。 */
import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { definePlugin } from '../../src/sdk/index.js';
import type { AgentEvent } from '../../src/core/events.js';
import { assertManagedSettingsPath } from '../../src/builtin/settings-paths.js';
import type { DebugEntry, DebugRequest, DebugSnapshot, DebugFilters } from '../shared/debug.js';

const titles: Record<string, string> = {
  user_input: '用户提交任务',
  model_request: '发送模型请求',
  model_response: '模型响应结束',
  model_usage: '统计模型用量',
  model_transport: 'API 传输',
  tool_call: '模型提出工具调用',
  tool_execution: '工具执行管线',
  tool_result: '工具返回结果',
  permission_request: '等待人工审批',
  permission_decision: '权限判定',
  plan_changed: '计划更新',
  compacted: '压缩上下文',
  loop_end: '本轮任务结束',
  session_saved: '会话已保存',
  session_restored: '恢复会话',
  notice: '运行提示',
  error: '运行错误',
};
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const secretName =
  /^(?:api[-_]?key|apiKeyRef|authorization|cookie|set-cookie|password|passwd|secret|(?:access|refresh|auth)[-_]?token|token|signature|credentials)$|[_-](?:api[-_]?key|token|secret|password)$/i;
/** 不读取进程凭据；结构字段、JSON 字符串、常见 Key/Authorization 与 URL 凭据统一脱敏。 */
export function redactDebug(value: unknown): unknown {
  let remaining = 1_500_000;
  const clean = (v: unknown, key = '', depth = 0): unknown => {
    if (secretName.test(key)) return '[已隐藏凭据]';
    if (depth > 40) return '[嵌套内容过深，调试副本省略]';
    if (record(v).type === 'redacted_thinking')
      return { type: 'redacted_thinking', data: '[服务隐藏的思考块]' };
    if (typeof v === 'string') {
      const text = v.slice(0, Math.max(0, remaining));
      remaining -= text.length;
      if (/^\s*[\[{]/.test(text)) {
        try {
          return JSON.stringify(clean(JSON.parse(text), '', depth + 1), null, 2);
        } catch {}
      }
      const redacted = text
        .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s"'<>]+)/gi, '[已隐藏凭据]')
        .replace(
          /((?:[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)|apiKey|authorization|password)\s*[=:]\s*)([^\r\n,}]+)/gi,
          '$1[已隐藏凭据]',
        )
        .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
          try {
            const u = new URL(raw);
            u.username = '';
            u.password = '';
            for (const name of [...u.searchParams.keys()])
              if (secretName.test(name) || /key|token|secret/i.test(name))
                u.searchParams.set(name, '[隐藏]');
            return u.href;
          } catch {
            return raw;
          }
        });
      return redacted + (text.length < v.length ? '\n[内容过长，调试副本已截断]' : '');
    }
    if (Array.isArray(v))
      return [
        ...v.slice(0, 10_000).map((item) => clean(item, '', depth + 1)),
        ...(v.length > 10_000 ? ['[数组过长，调试副本仅保留前 10000 项]'] : []),
      ];
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(
            ([k, item]) =>
              !['__proto__', 'constructor', 'prototype', 'signal', 'resolve'].includes(k) &&
              typeof item !== 'function',
          )
          .map(([k, item]) => [
            k,
            k === 'env'
              ? '[已隐藏环境变量]'
              : k === 'headers'
                ? Object.fromEntries(
                    Object.entries(record(item)).map(([name, value]) => [
                      name,
                      /^(content-type|accept|anthropic-version|anthropic-beta|x-stainless-retry-count|retry-after|x-request-id|request-id)$/i.test(
                        name,
                      )
                        ? clean(value, '', depth + 1)
                        : '[已隐藏]',
                    ]),
                  )
                : clean(item, k, depth + 1),
          ]),
      );
    return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : undefined;
  };
  return clean(value);
}
type IndexEntry = Omit<DebugEntry, 'data'> & { offset: number; bytes: number };
const fence = (text: string) => {
  let size = 3;
  for (const match of text.matchAll(/`+/g)) size = Math.max(size, match[0].length + 1);
  const delimiter = '`'.repeat(size);
  return delimiter + 'json\n' + text + '\n' + delimiter;
};
export class SessionDebugTrace {
  private root = '';
  private sessionId = '';
  private entries: IndexEntry[] = [];
  private requests = new Map<string, DebugRequest>();
  private tools = new Map<string, string>();
  private bytes = 0;
  private warning?: string;
  private page = 0;
  private filters: DebugFilters = {};
  private eventPage = 0;
  private detailId?: string;
  private eventId?: string;
  private detailCache?: { id: string; length: number; entries: DebugEntry[] };
  private report?: { id: string; markdown: string };
  configure(root: string, sessionId: string) {
    this.root = root;
    this.switchSession(sessionId);
  }
  private path() {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.sessionId)) throw new Error('invalid_debug_session');
    const path = join(this.root, 'debug', this.sessionId + '.jsonl');
    assertManagedSettingsPath(this.root, path);
    return path;
  }
  private open(write = false): number {
    const path = this.path();
    if (write) mkdirSync(join(this.root, 'debug'), { recursive: true, mode: 0o700 });
    let before;
    try {
      before = lstatSync(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        throw new Error('unsafe_debug_file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fd = openSync(
      path,
      (write ? constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT : constants.O_RDONLY) |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      (before && (before.dev !== after.dev || before.ino !== after.ino))
    ) {
      closeSync(fd);
      throw new Error('debug_file_changed');
    }
    return fd;
  }
  switchSession(id: string) {
    this.sessionId = id;
    this.entries = [];
    this.requests.clear();
    this.tools.clear();
    this.bytes = 0;
    this.page = 0;
    this.filters = {};
    this.eventPage = 0;
    this.detailId = undefined;
    this.eventId = undefined;
    this.detailCache = undefined;
    this.report = undefined;
    this.warning = undefined;
    let fd: number | undefined;
    try {
      fd = this.open();
      const buffer = Buffer.alloc(64 * 1024);
      let pending = Buffer.alloc(0),
        offset = 0;
      for (;;) {
        const count = readSync(fd, buffer);
        if (!count) break;
        pending = Buffer.concat([pending, buffer.subarray(0, count)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const bytes = newline + 1;
          const entry = this.parse(pending.subarray(0, newline).toString());
          this.index(entry, offset, bytes);
          offset += bytes;
          pending = pending.subarray(bytes);
        }
        if (pending.length > 12_000_000) throw new Error('debug_line_too_large');
      }
      this.bytes = offset;
      if (pending.length) throw new Error('incomplete_debug_file');
      for (const request of this.requests.values())
        if (request.status === 'running') request.status = 'interrupted';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.warning = '调试记录读取失败或尾部不完整；已有可读记录保留，会话仍可正常使用。';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private parse(line: string): DebugEntry {
    const value = record(JSON.parse(line));
    if (
      typeof value.id !== 'string' ||
      typeof value.at !== 'string' ||
      !Object.hasOwn(titles, String(value.type)) ||
      !value.data ||
      typeof value.data !== 'object'
    )
      throw new Error('invalid_debug_record');
    return { ...value, data: redactDebug(value.data) } as unknown as DebugEntry;
  }
  private index(entry: DebugEntry, offset: number, bytes: number) {
    const data = entry.data;
    if (entry.type === 'model_request') {
      const request = record(data.request),
        id = String(data.requestId);
      const parentRequestId = data.toolCallId ? this.tools.get(String(data.toolCallId)) : undefined;
      this.requests.set(id, {
        sequence: this.requests.size + 1,
        id,
        at: entry.at,
        provider: String(data.provider),
        model: String(request.model),
        role: String(data.modelRole ?? data.purpose ?? 'main'),
        agent: entry.agent,
        parentRequestId,
        status: 'running',
      });
    }
    if (entry.type === 'model_response') {
      const item = this.requests.get(String(data.requestId)),
        response = record(data.response);
      if (item) {
        item.status = response.status as DebugRequest['status'];
        item.chunks = Number(response.chunks);
        item.stopReason = response.stopReason as string | undefined;
        for (const tool of (response.tools as Array<{ id: string }>) ?? [])
          this.tools.set(tool.id, item.id);
      }
    }
    if (entry.type === 'model_transport') {
      const item = this.requests.get(String(data.requestId)),
        transport = record(data.transport);
      if (item) {
        if (transport.phase === 'request') {
          item.transportCount = (item.transportCount ?? 0) + 1;
          item.endpoint = String(transport.url);
          item.protocol = String(transport.protocol);
        }
        if (typeof transport.status === 'number') item.httpStatus = transport.status;
      }
    }
    if (entry.type === 'model_usage') {
      const item = this.requests.get(String(data.requestId)),
        usage = record(data.usage),
        metrics = record(data.metrics);
      if (item)
        Object.assign(item, {
          durationMs: metrics.durationMs,
          ttftMs: metrics.ttftMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          usageReported: data.usageReported,
          cacheAvailable: !!data.cache,
        });
    }
    const { data: _, ...meta } = entry;
    this.entries.push({ ...meta, offset, bytes });
  }
  input(text: string) {
    this.capture({ type: 'user_input', text });
  }
  record(event: AgentEvent) {
    if (event.type === 'session_restored') this.switchSession(event.id);
    if (event.type === 'subagent_event') {
      if (event.detail?.type && Object.hasOwn(titles, String(event.detail.type)))
        this.capture(event.detail, event.name);
      else if (event.kind === 'usage') this.capture({ ...event, type: 'model_usage' }, event.name);
      return;
    }
    if (Object.hasOwn(titles, event.type)) {
      if (event.type === 'permission_request')
        this.capture({ type: event.type, request: event.request });
      else if (event.type === 'session_restored')
        this.capture({ type: event.type, id: event.id, model: event.model });
      else if (event.type === 'error')
        this.capture({
          type: event.type,
          error: {
            name: event.error.name,
            code: /^[a-z_]+:/.exec(event.error.message)?.[0].slice(0, -1) ?? 'operation_failed',
          },
        });
      else this.capture(event as unknown as Record<string, unknown>);
    }
  }
  private capture(raw: Record<string, unknown>, agent?: string) {
    if (!this.root || this.warning) return;
    const type = String(raw.type),
      data = redactDebug(raw) as Record<string, unknown>;
    const toolId =
      type === 'tool_call'
        ? record(data.toolUse).id
        : type === 'permission_request'
          ? record(data.request).toolUseId
          : (data.toolUseId ?? data.toolCallId);
    const requestId = type.startsWith('model_')
      ? String(data.requestId)
      : this.tools.get(String(toolId));
    const entry: DebugEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      title: titles[type],
      requestId,
      agent,
      data,
    };
    let fd: number | undefined;
    try {
      const line = Buffer.from(JSON.stringify(entry) + '\n');
      fd = this.open(true);
      if (fstatSync(fd).size !== this.bytes) throw new Error('debug_file_changed');
      let written = 0;
      while (written < line.length) written += writeSync(fd, line, written, line.length - written);
      this.index(entry, this.bytes, line.length);
      this.bytes += line.length;
      this.report = undefined;
    } catch {
      this.warning =
        '调试记录保存失败，后续记录已暂停；会话执行不受影响。请检查磁盘空间与文件权限。';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  private readEntries(items: IndexEntry[]): DebugEntry[] {
    if (!items.length) return [];
    const fd = this.open();
    try {
      return items.map((item) => {
        const buffer = Buffer.alloc(item.bytes);
        if (readSync(fd, buffer, 0, item.bytes, item.offset) !== item.bytes)
          throw new Error('debug_file_changed');
        return this.parse(buffer.toString());
      });
    } finally {
      closeSync(fd);
    }
  }
  private detail(id: string): DebugEntry[] {
    if (this.detailCache?.id === id && this.detailCache.length === this.entries.length)
      return this.detailCache.entries;
    const entries = this.readEntries(
      this.entries.filter(
        (entry) =>
          entry.requestId === id ||
          (entry.requestId && this.requests.get(entry.requestId)?.parentRequestId === id),
      ),
    );
    this.detailCache = { id, length: this.entries.length, entries };
    return entries;
  }
  select(
    page: number,
    eventPage: number,
    requestId?: string,
    eventId?: string,
    filters?: DebugFilters,
  ) {
    if (requestId && !this.requests.has(requestId)) throw new Error('调试请求不属于当前会话。');
    if (eventId && !this.entries.some((entry) => entry.id === eventId))
      throw new Error('调试事件不属于当前会话。');
    this.page = page;
    if (filters) this.filters = { ...filters };
    this.eventPage = eventPage;
    this.detailId = requestId;
    if (!requestId) this.detailCache = undefined;
    this.eventId = eventId;
    this.report = undefined;
  }
  snapshot(): DebugSnapshot {
    const pageSize = 40;
    const all = [...this.requests.values()],
      f = this.filters;
    const filtered = all.filter((item) => {
      const at = new Date(item.at).getTime(),
        end = f.to ? new Date(f.to + 'T00:00:00') : undefined;
      if (end) end.setDate(end.getDate() + 1);
      return (
        (!f.provider || item.provider === f.provider) &&
        (!f.model || item.model === f.model) &&
        (!f.role || item.role === f.role) &&
        (!f.status || item.status === f.status) &&
        (!f.from || at >= new Date(f.from + 'T00:00:00').getTime()) &&
        (!end || at < end.getTime()) &&
        (!f.query ||
          [item.id, item.model, item.provider, item.agent, item.endpoint]
            .join(' ')
            .toLowerCase()
            .includes(f.query.toLowerCase()))
      );
    });
    if (f.order !== 'oldest') filtered.reverse();
    this.page = Math.min(this.page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
    this.eventPage = Math.min(
      this.eventPage,
      Math.max(0, Math.ceil(this.entries.length / pageSize) - 1),
    );
    let detail: DebugSnapshot['detail'];
    let event: DebugEntry | undefined;
    try {
      if (this.detailId)
        detail = {
          requestId: this.detailId,
          request: this.requests.get(this.detailId),
          entries: this.detail(this.detailId),
        };
      if (this.eventId)
        event = this.readEntries(this.entries.filter((entry) => entry.id === this.eventId))[0];
    } catch {
      this.warning = '所选请求的调试详情读取失败；请检查记录文件。';
    }
    return {
      sessionId: this.sessionId,
      totalRequests: this.requests.size,
      httpAttempts: all.reduce((sum, item) => sum + (item.transportCount ?? 0), 0),
      filteredRequests: filtered.length,
      filters: { ...f },
      choices: {
        providers: [...new Set(all.map((r) => r.provider))],
        models: [...new Set(all.map((r) => r.model))],
        roles: [...new Set(all.map((r) => r.role))],
      },
      totalEvents: this.entries.length,
      toolCalls: this.entries.filter((entry) => entry.type === 'tool_call').length,
      approvals: this.entries.filter((entry) => entry.type === 'permission_request').length,
      page: this.page,
      eventPage: this.eventPage,
      pageSize,
      requests: filtered.slice(this.page * pageSize, (this.page + 1) * pageSize),
      timeline: this.entries
        .slice()
        .reverse()
        .slice(this.eventPage * pageSize, (this.eventPage + 1) * pageSize)
        .map(({ offset: _, bytes: __, ...entry }) => entry),
      warning: this.warning,
      detail,
      event,
      report: this.report,
    };
  }
  exportReport() {
    const parts = [
      '# agentlab 会话调试报告',
      `会话：${this.sessionId}`,
      '记录含脱敏后的规范化协议与实际 SDK fetch 传输元数据。HTTP 头保留名称，认证及敏感值隐藏；SSE 正文为 SDK 解析后的 JSON 事件。未采集的 HTTP 正文不会补造。模型思考仅展示服务实际返回的内容。',
      this.warning ?? '',
    ];
    for (const [index, request] of [...this.requests.values()].entries()) {
      parts.push(
        `## 请求 ${index + 1} · ${request.role} · ${request.model}`,
        fence(JSON.stringify(request, null, 2)),
      );
      for (const entry of this.detail(request.id).filter((entry) => entry.requestId === request.id))
        parts.push(`### ${entry.title} · ${entry.at}`, fence(JSON.stringify(entry.data, null, 2)));
    }
    parts.push('## 完整会话时间线');
    for (const entry of this.readEntries(this.entries))
      parts.push(
        `### ${entry.at} · ${entry.title}`,
        entry.requestId
          ? `关联请求：${entry.requestId}`
          : fence(JSON.stringify(entry.data, null, 2)),
      );
    this.report = { id: randomUUID(), markdown: parts.join('\n\n') };
  }
}
export function sessionDebugPlugin(trace: SessionDebugTrace) {
  return definePlugin({
    manifest: { id: 'agentlab.desktop-debug', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.telemetry('desktop-debug', {
        onEvent: (event) => trace.record(event as unknown as AgentEvent),
      });
    },
  });
}
