/** 观测本 Provider 的 SDK fetch，不替换全局网络；AsyncLocalStorage 隔离并发调用。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ApiTransport, ProviderTrace } from '../core/protocol/transport.js';
import { modelErrorCode } from '../core/protocol/response-trace.js';

const contexts = new AsyncLocalStorage<TransportCapture>();
const wrapped = new WeakSet<object>();
const visibleHeaders = new Set([
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'x-stainless-retry-count',
  'retry-after',
  'x-request-id',
  'request-id',
]);
function headers(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const put = (name: string, val: string) => {
    result[name.toLowerCase()] = visibleHeaders.has(name.toLowerCase()) ? val : '[已隐藏]';
  };
  if (Array.isArray(value)) for (const [name, val] of value) put(String(name), String(val));
  else if (
    value &&
    typeof value === 'object' &&
    'forEach' in value &&
    typeof value.forEach === 'function'
  )
    value.forEach((val: string, name: string) => put(name, val));
  else if (value && typeof value === 'object')
    for (const [name, val] of Object.entries(value)) put(name, String(val));
  return result;
}
function safeURL(value: unknown): string {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '[已隐藏]');
    return url.href;
  } catch {
    return '[无效地址]';
  }
}
export class TransportCapture {
  private attempt = 0;
  private active?: { id: string; attempt: number; start: number };
  private chunks: unknown[] = [];
  private size = 0;
  private truncated = false;
  constructor(
    private trace: ProviderTrace | undefined,
    private protocol: string,
  ) {}
  run<T>(fn: () => T): T {
    return contexts.run(this, fn);
  }
  private emit(data: Omit<ApiTransport, 'protocol'>) {
    try {
      this.trace?.onTransport({ ...data, protocol: this.protocol });
    } catch {
      /* 观测失败不能改变 SDK 行为。 */
    }
  }
  async fetch(fetcher: (...args: any[]) => Promise<any>, receiver: unknown, args: any[]) {
    if (!this.trace) return fetcher.apply(receiver, args);
    const [input, init] = args;
    const current = { id: randomUUID(), attempt: ++this.attempt, start: performance.now() };
    this.active = current;
    let body: unknown = typeof init?.body === 'string' ? init.body : undefined;
    try {
      if (typeof body === 'string') body = JSON.parse(body);
    } catch {}
    try {
      this.emit({
        id: current.id,
        attempt: current.attempt,
        phase: 'request',
        method: init?.method ?? input?.method ?? 'GET',
        url: safeURL(typeof input === 'string' || input instanceof URL ? input : input?.url),
        headers: headers(init?.headers ?? input?.headers),
        body,
      });
    } catch {
      /* 不因调试字段读取失败而阻止网络请求。 */
    }
    try {
      const response = await fetcher.apply(receiver, args);
      try {
        this.emit({
          id: current.id,
          attempt: current.attempt,
          phase: 'headers',
          status: response.status,
          headers: headers(response.headers),
          durationMs: performance.now() - current.start,
        });
      } catch {
        /* 保留原响应。 */
      }
      return response;
    } catch (error) {
      this.emit({
        id: current.id,
        attempt: current.attempt,
        phase: 'error',
        errorCode: modelErrorCode(error),
        durationMs: performance.now() - current.start,
      });
      throw error;
    }
  }
  chunk(value: unknown) {
    if (!this.trace) return;
    let size: number;
    try {
      size = JSON.stringify(value).length;
    } catch {
      return;
    }
    if (this.size + size > 2_000_000 || this.chunks.length >= 20000) {
      this.truncated = true;
      return;
    }
    try {
      this.chunks.push(structuredClone(value));
      this.size += size;
    } catch {
      this.truncated = true;
    }
  }
  finish(error?: unknown) {
    if (!this.trace || !this.active) return;
    const { id, attempt, start } = this.active;
    try {
      // JSON 错误体由 SDK 暴露时保留结构；不采集 SDK 错误 message、stack 或配置。
      const rawError =
        error && typeof error === 'object' && 'error' in error ? error.error : undefined;
      this.emit({
        id,
        attempt,
        phase: 'body',
        body: rawError ?? this.chunks,
        format: rawError ? 'json' : 'sse-json',
        durationMs: performance.now() - start,
        truncated: this.truncated,
        errorCode: error ? modelErrorCode(error) : undefined,
      });
    } catch {
      /* 记录失败不能覆盖原始结果或异常。 */
    } finally {
      this.active = undefined;
    }
  }
}
/** SDK 使用自身已有 fetch（包括离线 mock）；包装后仍将同一参数原样交给它。 */
export function observeSDKFetch(client: object) {
  if (wrapped.has(client)) return;
  const target = client as { fetch?: (...args: any[]) => Promise<any> };
  const original = target.fetch;
  if (typeof original !== 'function') return;
  try {
    target.fetch = function (...args) {
      const context = contexts.getStore();
      return context ? context.fetch(original, this, args) : original.apply(this, args);
    };
    wrapped.add(client);
  } catch {
    /* 不可变 SDK client 继续沿用原 fetch。 */
  }
}
