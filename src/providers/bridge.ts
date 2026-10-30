/** 规范化 Provider 代理；pull 批次天然限制慢消费者的缓存，不传 AbortSignal/函数。 */
import { randomUUID } from 'node:crypto';
import type { Provider, ChatRequest } from '../core/provider.js';
import type { ProviderTrace } from '../core/protocol/transport.js';
import { providerSemantics, type ProviderDescription } from './semantics.js';
import { streamSchema } from './bridge-protocol.js';
export interface BridgeTransport {
  request<T = unknown>(method: string, payload: unknown, timeout?: number): Promise<T>;
}

export class BridgeProvider implements Provider {
  readonly capabilities = { thinking: true, streaming: true };
  private semantics;
  constructor(
    private channel: BridgeTransport,
    private description: ProviderDescription,
  ) {
    this.semantics = providerSemantics(description);
  }
  get name() {
    return this.description.name;
  }
  get routeId() {
    return this.description.routeId;
  }
  modelInfo(model: string) {
    return this.description.models[model];
  }
  modelCapabilities(model: string) {
    return this.description.capabilities[model];
  }
  normalizeRequest(req: ChatRequest) {
    if (!this.description.models[req.model]) throw new Error('MODEL_NOT_AUTHORIZED');
    return this.semantics.normalizeRequest?.(req) ?? req;
  }
  requestBytes(req: ChatRequest) {
    return this.semantics.requestBytes?.(req) ?? Buffer.byteLength(JSON.stringify(req));
  }
  estimateRequest(req: ChatRequest) {
    return (
      this.semantics.estimateRequest?.(req) ?? {
        inputTokens: Math.ceil(this.requestBytes(req) / 3),
        outputTokens: req.maxTokens ?? 8192,
        totalTokens: Math.ceil(this.requestBytes(req) / 3) + (req.maxTokens ?? 8192),
      }
    );
  }
  async *stream(req: ChatRequest, signal: AbortSignal, trace?: ProviderTrace) {
    this.normalizeRequest(req);
    const callId = randomUUID();
    const cancel = () => {
      void this.channel.request('model.cancel', { callId }, 5000).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    let completed = false;
    try {
      if (signal.aborted) throw new Error('ABORTED');
      await this.channel.request(
        'model.open',
        {
          callId,
          handle: this.description.handle,
          revision: this.description.revision ?? 0,
          request: req,
        },
        120000,
      );
      let expected = 0,
        stopped = false;
      while (true) {
        if (signal.aborted) throw new Error('ABORTED');
        const batch = await this.channel.request<{
          events: Array<{
            seq: number;
            event?: unknown;
            trace?: import('../core/protocol/transport.js').ApiTransport;
          }>;
          done: boolean;
          error?: string;
          cacheControl?: boolean;
          revision?: number;
        }>('model.next', { callId }, 120000);
        if (!Array.isArray(batch.events) || batch.events.length > 128)
          throw new Error('INVALID_MODEL_BATCH');
        for (const item of batch.events) {
          if (item.seq !== expected++) throw new Error('MODEL_SEQUENCE');
          if (item.trace) trace?.onTransport(item.trace);
          if (item.event) {
            const event = streamSchema.parse(item.event);
            if (event.type === 'message_stop') stopped = true;
            yield event;
          }
        }
        if (batch.error) throw new Error(batch.error);
        if (
          batch.cacheControl !== undefined &&
          batch.cacheControl !== this.description.cacheControl
        ) {
          this.description = {
            ...this.description,
            cacheControl: batch.cacheControl,
            revision: batch.revision ?? this.description.revision,
          };
          this.semantics = providerSemantics(this.description);
        }
        if (batch.done) {
          if (!stopped) throw new Error('INCOMPLETE_MODEL_STREAM');
          completed = true;
          return;
        }
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!completed) cancel();
    }
  }
}
