/** SSH/管道共用的有界分帧通道；不把日志或任意异常透传到业务边界。 */
import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

const frameLimit = 64 * 1024;
const messageLimit = 16 * 1024 * 1024;
const schema = z
  .object({
    version: z.literal(1),
    epoch: z.string().max(64),
    kind: z.enum(['request', 'reply', 'event']),
    id: z.string().uuid(),
    method: z.string().min(1).max(80),
    payload: z.unknown(),
    error: z.string().max(200).optional(),
  })
  .strict();
export type WireMessage = z.infer<typeof schema>;
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class RemoteChannel extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private transfers = new Map<
    string,
    { chunks: Buffer[]; index: number; size: number; timer: ReturnType<typeof setTimeout> }
  >();
  private queue: Array<{ bytes: Buffer; resolve: () => void; reject: (e: Error) => void }> = [];
  private queuedBytes = 0;
  private writing = false;
  private closed = false;
  private receiver?: (method: string, payload: unknown, id: string) => Promise<unknown>;
  constructor(
    private input: Readable,
    private output: Writable,
    readonly epoch: string,
  ) {
    super();
    input.on('data', (b: Buffer) => {
      try {
        this.consume(b);
      } catch {
        this.close('PROTOCOL_ERROR');
      }
    });
    input.on('end', () => this.close('CONNECTION_LOST'));
    input.on('error', () => this.close('CONNECTION_LOST'));
    output.on('error', () => this.close('CONNECTION_LOST'));
  }
  handle(receiver: NonNullable<RemoteChannel['receiver']>) {
    this.receiver = receiver;
  }
  private consume(chunk: Buffer) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (!length || length > frameLimit) throw new Error('FRAME_LIMIT');
      if (this.buffer.length < length + 4) return;
      const value = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
      this.buffer = this.buffer.subarray(length + 4);
      if (value.part === true) {
        const part = z
          .object({
            part: z.literal(true),
            id: z.string().uuid(),
            index: z.number().int().nonnegative(),
            data: z.string().max(56000),
            end: z.boolean(),
            hash: z.string().length(64).optional(),
          })
          .strict()
          .parse(value);
        let transfer = this.transfers.get(part.id);
        if (!transfer) {
          if (part.index !== 0 || this.transfers.size >= 4) throw new Error('TRANSFER_LIMIT');
          transfer = {
            chunks: [],
            index: 0,
            size: 0,
            timer: setTimeout(() => this.close('TRANSFER_TIMEOUT'), 30000),
          };
          this.transfers.set(part.id, transfer);
        }
        if (part.index !== transfer.index++) throw new Error('TRANSFER_ORDER');
        const bytes = Buffer.from(part.data, 'base64');
        transfer.size += bytes.length;
        if (
          transfer.size > messageLimit ||
          [...this.transfers.values()].reduce((n, t) => n + t.size, 0) > 32 * 1024 * 1024
        )
          throw new Error('MESSAGE_LIMIT');
        clearTimeout(transfer.timer);
        transfer.timer = setTimeout(() => this.close('TRANSFER_TIMEOUT'), 30000);
        transfer.chunks.push(bytes);
        if (part.end) {
          clearTimeout(transfer.timer);
          this.transfers.delete(part.id);
          const all = Buffer.concat(transfer.chunks);
          if (createHash('sha256').update(all).digest('hex') !== part.hash)
            throw new Error('TRANSFER_HASH');
          this.deliver(JSON.parse(all.toString('utf8')));
        }
      } else this.deliver(value);
    }
  }
  private deliver(raw: unknown) {
    const m = schema.parse(raw);
    if (m.epoch !== this.epoch) throw new Error('STALE_CONNECTION');
    if (m.kind === 'reply') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.payload);
    } else if (m.kind === 'event') this.emit('event', m.method, m.payload);
    else {
      void Promise.resolve()
        .then(() => {
          if (!this.receiver) throw new Error('METHOD_UNAVAILABLE');
          return this.receiver(m.method, m.payload, m.id);
        })
        .then(
          (payload) => this.send({ ...m, kind: 'reply', payload: payload ?? null }),
          (e) =>
            this.send({
              ...m,
              kind: 'reply',
              payload: null,
              error:
                e instanceof Error && /^[A-Z_]{2,80}$/.test(e.message)
                  ? e.message
                  : 'REMOTE_OPERATION_FAILED',
            }),
        )
        .catch(() => this.close('CONNECTION_LOST'));
    }
  }
  private async write(value: unknown, priority: boolean) {
    if (this.closed) throw new Error('CONNECTION_LOST');
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > frameLimit) throw new Error('FRAME_LIMIT');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    const bytes = Buffer.concat([header, data]);
    if (this.queuedBytes + bytes.length > 8 * 1024 * 1024) throw new Error('QUEUE_LIMIT');
    await new Promise<void>((resolve, reject) => {
      const item = { bytes, resolve, reject };
      if (priority) this.queue.unshift(item);
      else this.queue.push(item);
      this.queuedBytes += bytes.length;
      void this.flush();
    });
  }
  private async flush() {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.queue.length && !this.closed) {
        const item = this.queue.shift()!;
        this.queuedBytes -= item.bytes.length;
        try {
          await new Promise<void>((resolve, reject) =>
            this.output.write(item.bytes, (e) => (e ? reject(e) : resolve())),
          );
          item.resolve();
        } catch (e) {
          item.reject(new Error('CONNECTION_LOST'));
          throw e;
        }
      }
    } catch {
      this.close('CONNECTION_LOST');
    } finally {
      this.writing = false;
    }
  }
  async send(m: WireMessage) {
    const bytes = Buffer.from(JSON.stringify(m));
    if (bytes.length > messageLimit) throw new Error('MESSAGE_LIMIT');
    const priority = /cancel|heartbeat|stop|dispose/.test(m.method);
    if (bytes.length <= frameLimit) return this.write(m, priority);
    const id = randomUUID(),
      hash = createHash('sha256').update(bytes).digest('hex');
    for (let offset = 0, index = 0; offset < bytes.length; offset += 40000, index++) {
      const end = offset + 40000 >= bytes.length;
      await this.write(
        {
          part: true,
          id,
          index,
          data: bytes.subarray(offset, offset + 40000).toString('base64'),
          end,
          ...(end ? { hash } : {}),
        },
        false,
      );
    }
  }
  async request<T = unknown>(method: string, payload: unknown, timeout = 30000): Promise<T> {
    if (this.pending.size >= 256) throw new Error('REQUEST_LIMIT');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('OUTCOME_UNKNOWN'));
      }, timeout);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      void this.send({ version: 1, epoch: this.epoch, kind: 'request', id, method, payload }).catch(
        (e) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        },
      );
    });
  }
  notify(method: string, payload: unknown) {
    return this.send({
      version: 1,
      epoch: this.epoch,
      kind: 'event',
      id: randomUUID(),
      method,
      payload,
    });
  }
  close(code = 'CONNECTION_LOST') {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(code));
    }
    this.pending.clear();
    for (const t of this.transfers.values()) clearTimeout(t.timer);
    this.transfers.clear();
    this.buffer = Buffer.alloc(0);
    for (const item of this.queue) item.reject(new Error(code));
    this.queue = [];
    this.queuedBytes = 0;
    this.emit('closed', code);
  }
}
