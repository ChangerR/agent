import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** main 与模型进程的受限本地 IPC，不经过 renderer 或 SSH。 */
export class BrokerHost {
  private child: ChildProcess;
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  constructor(node: string, entry: string) {
    this.child = fork(entry, [], {
      execPath: node,
      execArgv: [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.child.on('message', (m: { id: string; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(/^[A-Z_]+$/.test(m.error) ? m.error : 'BROKER_FAILED'));
      else p.resolve(m.result);
    });
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
  }
  request<T = unknown>(method: string, payload: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('BROKER_CLOSED'));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('BROKER_TIMEOUT'));
      }, 125000);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.child.send({ id, method, payload }, (e) => {
        if (e) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error('BROKER_CLOSED'));
        }
      });
    });
  }
  handle(method: string, payload: unknown) {
    return this.request(method, payload);
  }
  activate() {
    return this.request('activate', null);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.child.connected) this.child.disconnect();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('BROKER_CLOSED'));
    }
    this.pending.clear();
  }
}
