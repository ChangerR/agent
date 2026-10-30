/** Provider 对宿主披露的 HTTP 调试副本；不携带认证明文，不参与请求决策。 */
export interface ApiTransport {
  id: string;
  attempt: number;
  phase: 'request' | 'headers' | 'body' | 'error';
  protocol: string;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  status?: number;
  durationMs?: number;
  format?: 'json' | 'sse-json';
  truncated?: boolean;
  errorCode?: string;
}
export interface ProviderTrace {
  onTransport: (event: ApiTransport) => void;
}
