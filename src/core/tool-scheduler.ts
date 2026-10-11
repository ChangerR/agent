/** 同一工作区的公平读写门。租约直到实际 execute 结算才释放，取消只移除等待者。 */
export interface ToolLease {
  readonly mode: 'read' | 'write';
  release(): void;
}
export class ToolScheduler {
  private leases = new WeakMap<
    ToolLease,
    {
      state: { mode: 'read' | 'write'; refs: number };
      released: boolean;
      children: number;
      settle: () => void;
    }
  >();
  private readers = 0;
  private writer = false;
  private queue: Array<{
    mode: 'read' | 'write';
    signal: AbortSignal;
    grant: (lease: ToolLease) => void;
    cancel: () => void;
  }> = [];

  acquire(mode: 'read' | 'write', signal: AbortSignal, parent?: ToolLease): Promise<ToolLease> {
    signal.throwIfAborted();
    if (parent) {
      const held = this.leases.get(parent);
      if (!held || held.released || held.state.refs === 0)
        return Promise.reject(new Error('Parent workspace lease is no longer active'));
      if (parent.mode === 'read' && mode === 'write')
        return Promise.reject(new Error('Nested tool cannot upgrade a read lease to write'));
      if (parent.mode === 'write' && held.children)
        return Promise.reject(
          new Error('Nested tools under a write lease must execute sequentially'),
        );
      held.children++;
      return Promise.resolve(
        this.lease(held.state, () => {
          held.children--;
          held.settle();
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const entry = {
        mode,
        signal,
        grant: resolve,
        cancel: () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener('abort', entry.cancel);
          reject(signal.reason);
          this.drain();
        },
      };
      this.queue.push(entry);
      signal.addEventListener('abort', entry.cancel, { once: true });
      if (signal.aborted) entry.cancel();
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length && !this.writer) {
      const entry = this.queue[0];
      if (entry.mode === 'write' && this.readers) return;
      this.queue.shift();
      entry.signal.removeEventListener('abort', entry.cancel);
      if (entry.mode === 'write') this.writer = true;
      else this.readers++;
      entry.grant(this.lease({ mode: entry.mode, refs: 0 }));
      if (entry.mode === 'write') return;
    }
  }

  private lease(
    state: { mode: 'read' | 'write'; refs: number },
    releaseParent?: () => void,
  ): ToolLease {
    state.refs++;
    const held = { state, released: false, children: 0, settle: () => {} };
    let settled = false;
    held.settle = () => {
      if (!settled && held.released && !held.children) {
        settled = true;
        releaseParent?.();
      }
    };
    const lease: ToolLease = {
      mode: state.mode,
      release: () => {
        if (held.released) return;
        held.released = true;
        held.settle();
        if (--state.refs) return;
        if (state.mode === 'write') this.writer = false;
        else this.readers--;
        this.drain();
      },
    };
    this.leases.set(lease, held);
    return lease;
  }
}
