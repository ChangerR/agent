import type { DebugEntry, DebugRequest } from '../shared/debug.js';
import { useState } from 'react';
import { Json, object, duration } from './DebugDetails.js';

/** 同一模型调用可能含 SDK 重试；每个 HTTP attempt 单独呈现。 */
export function ApiTransportView({
  entries,
  request,
  response = false,
}: {
  entries: DebugEntry[];
  request?: DebugRequest;
  response?: boolean;
}) {
  const [copied, setCopied] = useState('');
  const records = entries
    .filter((entry) => entry.type === 'model_transport')
    .map((entry) => object(entry.data.transport));
  const attempts = records.filter((item) => item.phase === 'request');
  if (!attempts.length)
    return (
      <div className="api-empty-transport">
        <h3>
          {request?.provider === 'fake'
            ? '离线演示没有发送 HTTP 请求'
            : '这条记录没有 API 传输数据'}
        </h3>
        <p>
          {request?.provider === 'fake'
            ? 'FakeProvider 在本机产生规范化事件，不存在真实 API 地址或 HTTP 响应。可以切换到 Agent 上下文和模型返回，学习循环过程。'
            : '旧记录或未接入传输观测的插件只保留统一协议；这里不会推测或补造 HTTP 数据。新的 OpenAI / Anthropic 兼容调用会自动记录。'}
        </p>
      </div>
    );
  return (
    <>
      <p className="debug-explanation">
        {response
          ? '响应头与状态来自实际 SDK fetch。SSE 内容是 SDK 解析后的原始 JSON 事件，保持服务字段，不冒充未记录的逐字节 HTTP 报文。'
          : '下面是 SDK 实际发送的地址、方法、请求头和 JSON 请求体。认证及其他敏感头已隐藏；Agent 的统一协议可在“Agent 上下文”中对照。'}
      </p>
      {attempts.map((attempt, index) => {
        const related = records.filter((item) => item.id === attempt.id),
          head = related.find((item) => item.phase === 'headers'),
          body = related.find((item) => item.phase === 'body'),
          failure = related.find((item) => item.phase === 'error');
        const header = object(response ? head?.headers : attempt.headers);
        return (
          <section className="api-attempt" key={String(attempt.id)}>
            <div className="api-attempt-heading">
              <strong>HTTP 尝试 {index + 1}</strong>
              <span>{String(attempt.protocol)}</span>
              <span className="tag">
                {head ? `HTTP ${head.status}` : failure ? '连接失败' : '等待响应'}
              </span>
            </div>
            <div className="api-endpoint">
              <span>{String(attempt.method)}</span>
              <code>{String(attempt.url)}</code>
            </div>
            {response && (
              <dl className="debug-metrics">
                <div>
                  <dt>HTTP 状态</dt>
                  <dd>{head ? String(head.status) : '未收到响应'}</dd>
                </div>
                <div>
                  <dt>收到响应头</dt>
                  <dd>{duration(head?.durationMs as number | undefined)}</dd>
                </div>
                <div>
                  <dt>总耗时</dt>
                  <dd>{duration(body?.durationMs as number | undefined)}</dd>
                </div>
              </dl>
            )}
            <details className="api-header-fields">
              <summary>
                {response ? '响应头' : '请求头'} <span>{Object.keys(header).length} 项</span>
              </summary>
              <dl>
                {Object.entries(header).map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <div className="api-body-heading">
              <h3>
                {response
                  ? body?.format === 'sse-json'
                    ? '响应事件 · SSE JSON'
                    : '响应体 · JSON'
                  : '请求体 · JSON'}
              </h3>
              <button
                type="button"
                disabled={response ? !body : attempt.body === undefined}
                onClick={async () => {
                  const id = String(attempt.id) + String(response);
                  try {
                    await navigator.clipboard.writeText(
                      JSON.stringify(response ? body?.body : attempt.body, null, 2),
                    );
                    setCopied(id);
                  } catch {
                    setCopied('failed-' + id);
                  }
                }}
              >
                {copied === String(attempt.id) + String(response)
                  ? '已复制'
                  : copied === 'failed-' + String(attempt.id) + String(response)
                    ? '复制失败，请手动选择'
                    : '复制 JSON'}
              </button>
            </div>
            {body?.truncated === true && response && (
              <p className="info">响应事件过长，调试副本已截断；模型执行使用的内容不受影响。</p>
            )}
            {response ? (
              body ? (
                <Json value={body.body} />
              ) : (
                <p className="info">
                  {failure
                    ? `网络错误：${String(failure.errorCode)}`
                    : '此 HTTP 尝试没有可读取的响应体。SDK 内部重试可能未暴露失败尝试的正文。'}
                </p>
              )
            ) : attempt.body !== undefined ? (
              <Json value={attempt.body} />
            ) : (
              <p className="info">本次没有记录到 JSON 请求体。</p>
            )}
          </section>
        );
      })}
    </>
  );
}
