/** 出站 HTTP 传输：只作用于显式接入的客户端，不改写全局 fetch/dispatcher。 */
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';

export class EnvironmentProxyTransport {
  // 小写优先，空字符串也覆盖大写；快照与用户 .env 的重启语义一致。
  private readonly httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY ?? '';
  private readonly httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? '';
  private readonly noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? '';
  private dispatcher?: EnvHttpProxyAgent;

  options(): { fetch?: typeof globalThis.fetch } {
    if (!this.httpProxy && !this.httpsProxy) return {};
    if (!this.dispatcher) {
      for (const [name, value] of [
        ['HTTP_PROXY/http_proxy', this.httpProxy],
        ['HTTPS_PROXY/https_proxy', this.httpsProxy],
      ]) {
        if (!value) continue;
        try {
          const url = new URL(value);
          if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
            throw new Error('invalid_proxy');
        } catch {
          // URL 可能含代理凭据；不保留原错误或回显原值。
          throw new Error(`${name} 配置无效；请填写 http:// 或 https:// 代理地址后重启。`);
        }
      }
      this.dispatcher = new EnvHttpProxyAgent({
        httpProxy: this.httpProxy,
        httpsProxy: this.httpsProxy,
        noProxy: this.noProxy,
      });
    }
    const dispatcher = this.dispatcher;
    // 使用同版本 Undici 的 fetch 与 dispatcher，保留 SSE、取消和 SDK 重试语义。
    return {
      fetch: ((input, init) =>
        proxyFetch(
          input as Parameters<typeof proxyFetch>[0],
          {
            ...init,
            dispatcher,
          } as Parameters<typeof proxyFetch>[1],
        )) as typeof globalThis.fetch,
    };
  }

  async dispose(): Promise<void> {
    const dispatcher = this.dispatcher;
    this.dispatcher = undefined;
    await dispatcher?.destroy();
  }
}
