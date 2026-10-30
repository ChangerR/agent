import { useEffect, useRef, useState } from 'react';
import type { RuntimeSnapshot } from '../shared/protocol.js';
import type { DebugFilters, DebugRequest } from '../shared/debug.js';
import {
  Json,
  RequestView,
  ResponseView,
  EventView,
  roles,
  status,
  time,
  duration,
} from './DebugDetails.js';
import { ApiTransportView } from './ApiTransportView.js';
import { Icon } from './Icon.js';

const inputTokens = (item: DebugRequest) =>
  (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0) + (item.cacheWriteTokens ?? 0);
const cacheRate = (item: DebugRequest) =>
  item.cacheAvailable && inputTokens(item) > 0
    ? (((item.cacheReadTokens ?? 0) / inputTokens(item)) * 100).toFixed(2) + '%'
    : '—';
const requestStatus = (item: DebugRequest) =>
  item.stopReason === 'max_tokens'
    ? '输出达到上限'
    : item.stopReason === 'tool_use'
      ? '返回工具调用'
      : status[item.status];
const tabs = [
  ['api-request', 'API 请求'],
  ['api-response', 'API 响应'],
  ['context', 'Agent 上下文'],
  ['response', '模型返回'],
  ['tools', '工具与审批'],
  ['raw', '规范化数据'],
] as const;
type Tab = (typeof tabs)[number][0];
export function DebugPage({
  runtime,
  request,
  onBack,
}: {
  runtime: RuntimeSnapshot;
  request: (payload: Record<string, unknown>) => Promise<void>;
  onBack: () => void;
}) {
  const debug = runtime.debug;
  const [tab, setTab] = useState<Tab>('api-request'),
    [selected, setSelected] = useState<string>();
  const [filters, setFilters] = useState<DebugFilters>({}),
    [query, setQuery] = useState('');
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    exported = useRef('');
  const opener = useRef<HTMLElement | null>(null);
  const run = async (payload: Record<string, unknown>) => {
    setPending(true);
    setError('');
    try {
      await request(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : '调试记录读取失败');
    } finally {
      setPending(false);
    }
  };
  useEffect(() => {
    void run({ type: 'debug-read', page: 0, eventPage: 0, filters: {} });
  }, []);
  useEffect(() => {
    if (selected && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [selected]);
  useEffect(() => {
    if (!debug?.report || exported.current === debug.report.id) return;
    exported.current = debug.report.id;
    const url = URL.createObjectURL(
      new Blob([debug.report.markdown], { type: 'text/markdown;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentlab-debug-${runtime.sessionId}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [debug?.report?.id]);
  const closeDetail = () => {
    setSelected(undefined);
    void run({
      type: 'debug-read',
      page: debug?.page ?? 0,
      eventPage: debug?.eventPage ?? 0,
      filters,
    });
    requestAnimationFrame(() => opener.current?.focus());
  };
  const choose = (id: string, keepTab = false) => {
    if (!selected) opener.current = document.activeElement as HTMLElement;
    setSelected(id);
    if (!keepTab) setTab('api-request');
    void run({
      type: 'debug-read',
      page: debug?.page ?? 0,
      eventPage: debug?.eventPage ?? 0,
      requestId: id,
      filters,
    });
  };
  const filter = (patch: Partial<DebugFilters>) => {
    const next = { ...filters, ...patch };
    for (const key of Object.keys(next) as Array<keyof DebugFilters>)
      if (!next[key]) delete next[key];
    setFilters(next);
    setSelected(undefined);
    void run({ type: 'debug-read', page: 0, eventPage: debug?.eventPage ?? 0, filters: next });
  };
  const page = (value: number, eventPage = debug?.eventPage ?? 0) =>
    void run({ type: 'debug-read', page: value, eventPage, filters });
  const detail = debug?.detail && debug.detail.requestId === selected ? debug.detail : undefined;
  const current = detail?.request ?? debug?.requests.find((item) => item.id === selected);
  const entries = detail?.entries ?? [],
    main = entries.find((entry) => entry.type === 'model_request' && entry.requestId === selected),
    response = entries.find(
      (entry) => entry.type === 'model_response' && entry.requestId === selected,
    );
  const transport = entries.filter(
    (entry) => entry.type === 'model_transport' && entry.requestId === selected,
  );
  const toolEntries = entries.filter(
    (entry) =>
      !['model_request', 'model_response', 'model_usage', 'model_transport'].includes(entry.type) ||
      entry.requestId !== selected,
  );
  const position = debug?.requests.findIndex((item) => item.id === selected) ?? -1;
  const total = debug?.filteredRequests ?? debug?.totalRequests ?? 0,
    size = debug?.pageSize ?? 40;
  return (
    <main className="debug-screen api-log-screen" aria-label="会话调试页面">
      <header className="debug-header">
        <div>
          <button type="button" onClick={onBack}>
            <Icon name="back" size={15} /> 返回会话
          </button>
          <h1>诊断工作台</h1>
          <span className="tag">{runtime.busy ? '实时记录中' : '会话调试'}</span>
        </div>
        <div>
          <button type="button" disabled={pending} onClick={() => page(debug?.page ?? 0)}>
            <Icon name="refresh" size={14} /> 刷新
          </button>
          <button
            type="button"
            disabled={pending || runtime.busy || !debug?.totalEvents}
            onClick={() => void run({ type: 'debug-export' })}
          >
            <Icon name="download" size={14} /> 导出 Markdown 报告
          </button>
        </div>
      </header>
      <section className="debug-overview" aria-label="诊断摘要">
        <div className="debug-context">
          <strong>{runtime.projectName}</strong>
          <span>请求、传输与 Agent 执行链</span>
          <code title="会话 ID">{runtime.sessionId}</code>
        </div>
        <section className="debug-stats" aria-label="会话调试统计">
          {[
            ['模型请求', debug?.totalRequests ?? 0],
            ['HTTP 尝试', debug?.httpAttempts ?? 0],
            ['工具调用', debug?.toolCalls ?? 0],
            ['人工审批', debug?.approvals ?? 0],
          ].map(([label, count]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{count}</strong>
            </div>
          ))}
        </section>
      </section>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {debug?.warning && (
        <p className="error-banner" role="alert">
          {debug.warning}
        </p>
      )}
      {runtime.approvals.length > 0 && (
        <p className="info debug-approval" role="status">
          有工具正在等待你的审批。<button onClick={onBack}>返回会话处理</button>
        </p>
      )}
      <section className="api-log-card" aria-label="API 调用日志列表">
        <form
          className="api-log-filters"
          onSubmit={(event) => {
            event.preventDefault();
            filter({ query });
          }}
        >
          <label>
            开始日期
            <input
              type="date"
              aria-label="开始日期"
              value={filters.from ?? ''}
              onChange={(e) => filter({ from: e.target.value })}
            />
          </label>
          <label>
            结束日期
            <input
              type="date"
              aria-label="结束日期"
              value={filters.to ?? ''}
              onChange={(e) => filter({ to: e.target.value })}
            />
          </label>
          <label>
            供应商
            <select
              aria-label="筛选供应商"
              value={filters.provider ?? ''}
              onChange={(e) => filter({ provider: e.target.value })}
            >
              <option value="">全部供应商</option>
              {debug?.choices.providers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            模型
            <select
              aria-label="筛选模型"
              value={filters.model ?? ''}
              onChange={(e) => filter({ model: e.target.value })}
            >
              <option value="">全部模型</option>
              {debug?.choices.models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            用途
            <select
              aria-label="筛选用途"
              value={filters.role ?? ''}
              onChange={(e) => filter({ role: e.target.value })}
            >
              <option value="">全部用途</option>
              {debug?.choices.roles.map((name) => (
                <option key={name} value={name}>
                  {roles[name] ?? name}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              aria-label="筛选状态"
              value={filters.status ?? ''}
              onChange={(e) => filter({ status: e.target.value })}
            >
              <option value="">全部状态</option>
              {Object.entries(status).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="api-query">
            搜索
            <input
              aria-label="搜索调用日志"
              placeholder="模型、请求 ID 或端点"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <button type="submit" disabled={pending}>
            筛选
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setQuery('');
              setFilters({});
              void run({ type: 'debug-read', page: 0, eventPage: 0, filters: {} });
            }}
          >
            重置
          </button>
        </form>
        <div className="api-table-caption">
          <div className="api-table-title">
            <h2>调用日志</h2>
            <p>
              共 {total} 条
              {total !== debug?.totalRequests ? ` / 全部 ${debug?.totalRequests} 条` : ''} ·
              选择一行检查详情与重试
            </p>
          </div>
          <label>
            排序
            <select
              aria-label="调用排序"
              value={filters.order ?? 'newest'}
              onChange={(e) => filter({ order: e.target.value as DebugFilters['order'] })}
            >
              <option value="newest">最新在前</option>
              <option value="oldest">按执行顺序</option>
            </select>
          </label>
        </div>
        <div className="api-table-scroll" tabIndex={0} aria-label="调用日志表格，可横向滚动">
          <table className="api-log-table">
            <colgroup>
              <col style={{ width: '14%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '6%' }} />
              <col style={{ width: '6%' }} />
            </colgroup>
            <thead>
              <tr>
                {[
                  '时间 / 序号',
                  '模型',
                  '用途',
                  '供应商',
                  '状态',
                  '输入 Token',
                  '输出 Token',
                  '缓存命中',
                  '耗时',
                  '操作',
                ].map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className={
                      name === '操作'
                        ? 'api-action'
                        : ['输入 Token', '输出 Token', '缓存命中', '耗时'].includes(name)
                          ? 'api-number'
                          : undefined
                    }
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {debug?.requests.map((item) => (
                <tr key={item.id} className="debug-request" onClick={() => choose(item.id)}>
                  <td>
                    <time dateTime={item.at}>
                      {new Date(item.at).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                      })}
                    </time>
                    <small>#{item.sequence}</small>
                  </td>
                  <td>
                    <strong title={item.model}>{item.model}</strong>
                    <small>
                      {item.protocol ??
                        (item.provider === 'fake' ? '离线 FakeProvider' : '统一协议记录')}
                    </small>
                  </td>
                  <td>
                    {roles[item.role] ?? item.role}
                    {item.agent && <small>{item.agent}</small>}
                  </td>
                  <td>{item.provider}</td>
                  <td>
                    <span className={'debug-state ' + item.status}>{requestStatus(item)}</span>
                    <small>
                      {item.httpStatus
                        ? `HTTP ${item.httpStatus}${(item.transportCount ?? 0) > 1 ? ` · ${item.transportCount} 次` : ''}`
                        : item.provider === 'fake'
                          ? '无 HTTP 调用'
                          : '未记录 HTTP'}
                    </small>
                  </td>
                  <td className="api-number">
                    {item.usageReported ? inputTokens(item).toLocaleString() : '—'}
                  </td>
                  <td className="api-number">
                    {item.usageReported ? (item.outputTokens?.toLocaleString() ?? '—') : '—'}
                  </td>
                  <td className="api-number">{cacheRate(item)}</td>
                  <td className="api-number">{duration(item.durationMs)}</td>
                  <td className="api-action">
                    <button
                      type="button"
                      className="api-detail-button"
                      aria-label={`查看请求 ${item.sequence} 详情`}
                      onClick={(e) => {
                        e.stopPropagation();
                        choose(item.id);
                      }}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))}
              {!total && (
                <tr>
                  <td colSpan={10}>
                    <div className="api-log-empty">
                      <h2>{debug?.totalRequests ? '没有匹配的调用' : '还没有模型调用记录'}</h2>
                      <p>
                        {debug?.totalRequests
                          ? '调整筛选条件，或点击重置查看全部记录。'
                          : '发送任务后会自动记录。旧会话未保存的 HTTP 内容不会补造。'}
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <nav className="debug-pagination" aria-label="请求翻页">
          <button disabled={pending || !debug?.page} onClick={() => page((debug?.page ?? 0) - 1)}>
            上一页
          </button>
          <span>
            第 {(debug?.page ?? 0) + 1} / {Math.max(1, Math.ceil(total / size))} 页
          </span>
          <button
            disabled={pending || ((debug?.page ?? 0) + 1) * size >= total}
            onClick={() => page((debug?.page ?? 0) + 1)}
          >
            下一页
          </button>
        </nav>
      </section>
      <details className="debug-timeline">
        <summary>完整 Agent 过程时间线 · {debug?.totalEvents ?? 0} 个事件</summary>
        <div>
          {debug?.timeline.map((entry) => (
            <button
              type="button"
              key={entry.id}
              onClick={() =>
                entry.requestId
                  ? choose(entry.requestId)
                  : void run({
                      type: 'debug-read',
                      page: debug.page,
                      eventPage: debug.eventPage,
                      eventId: entry.id,
                      filters,
                    })
              }
            >
              <time>{time(entry.at)}</time>
              <span>{entry.title}</span>
              <small>{entry.agent}</small>
            </button>
          ))}
        </div>
        {debug?.event && <EventView entry={debug.event} />}
        <nav className="debug-pagination" aria-label="事件翻页">
          <button
            disabled={pending || !debug?.eventPage}
            onClick={() => page(debug?.page ?? 0, (debug?.eventPage ?? 0) - 1)}
          >
            较新事件
          </button>
          <span>{(debug?.eventPage ?? 0) + 1}</span>
          <button
            disabled={pending || ((debug?.eventPage ?? 0) + 1) * size >= (debug?.totalEvents ?? 0)}
            onClick={() => page(debug?.page ?? 0, (debug?.eventPage ?? 0) + 1)}
          >
            较早事件
          </button>
        </nav>
      </details>
      {selected && (
        <dialog
          className="api-detail-drawer"
          ref={dialog}
          aria-label="API 调用详情"
          onCancel={(event) => {
            event.preventDefault();
            closeDetail();
          }}
          onClick={(event) => {
            if (
              event.target === event.currentTarget &&
              event.clientX < event.currentTarget.getBoundingClientRect().left
            )
              closeDetail();
          }}
        >
          <header className="api-drawer-heading">
            <div>
              <span className="eyebrow">
                调用 #{current?.sequence ?? '—'} · {roles[current?.role ?? 'main'] ?? current?.role}
              </span>
              <h2>{current?.model ?? '请求详情'}</h2>
              <code>{selected}</code>
            </div>
            <div className="api-drawer-controls">
              <button
                type="button"
                disabled={pending || position <= 0}
                onClick={() => {
                  const item = debug?.requests[position - 1];
                  if (item) choose(item.id, true);
                }}
              >
                上一条
              </button>
              <button
                type="button"
                disabled={pending || position < 0 || position + 1 >= (debug?.requests.length ?? 0)}
                onClick={() => {
                  const item = debug?.requests[position + 1];
                  if (item) choose(item.id, true);
                }}
              >
                下一条
              </button>
              <button type="button" aria-label="关闭调用详情" autoFocus onClick={closeDetail}>
                <Icon name="close" size={14} /> 关闭
              </button>
            </div>
          </header>
          <div className="api-drawer-summary">
            {runtime.approvals.length > 0 && (
              <p className="info" role="status">
                有工具正在等待你的审批。<button onClick={onBack}>返回会话处理</button>
              </p>
            )}
            <dl className="debug-metrics">
              <div>
                <dt>状态</dt>
                <dd>
                  {current ? requestStatus(current) : '读取中'}
                  {current?.httpStatus ? ` · HTTP ${current.httpStatus}` : ''}
                </dd>
              </div>
              <div>
                <dt>耗时 / 首次输出</dt>
                <dd>
                  {duration(current?.durationMs)} / {duration(current?.ttftMs)}
                </dd>
              </div>
              <div>
                <dt>输入 / 输出 Token</dt>
                <dd>
                  {current?.usageReported
                    ? `${inputTokens(current).toLocaleString()} / ${current.outputTokens?.toLocaleString() ?? '—'}`
                    : '服务未报告'}
                </dd>
              </div>
              <div>
                <dt>缓存命中率</dt>
                <dd>{current ? cacheRate(current) : '—'}</dd>
              </div>
            </dl>
          </div>
          <div className="debug-tabs" role="tablist" aria-label="请求内容">
            {tabs.map(([id, label]) => (
              <button
                type="button"
                role="tab"
                key={id}
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="api-drawer-scroll debug-tab-content" role="tabpanel">
            {pending && !detail ? (
              <p role="status">正在读取请求…</p>
            ) : tab === 'api-request' ? (
              <ApiTransportView entries={transport} request={current} />
            ) : tab === 'api-response' ? (
              <ApiTransportView entries={transport} request={current} response />
            ) : tab === 'context' ? (
              <RequestView entry={main} />
            ) : tab === 'response' ? (
              <ResponseView entry={response} request={current} />
            ) : tab === 'raw' ? (
              <Json value={entries} />
            ) : (
              <>
                <p className="debug-explanation">
                  模型提出工具 → 参数校验 → 影响分析 → 权限策略 → 必要的审批 → 实际执行 →
                  结果回填，随后形成下一次 API 请求。
                </p>
                {!toolEntries.length && <p>本次没有工具或审批记录。</p>}
                {toolEntries.map((entry) => (
                  <details className="debug-section" key={entry.id}>
                    <summary>
                      {time(entry.at)} · {entry.title}
                      {entry.data.phase ? ` · ${String(entry.data.phase)}` : ''}
                      {entry.data.toolName ? ` · ${String(entry.data.toolName)}` : ''}
                    </summary>
                    <EventView entry={entry} />
                  </details>
                ))}
              </>
            )}
          </div>
        </dialog>
      )}
    </main>
  );
}
