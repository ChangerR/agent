import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RuntimeSnapshot, WorkerMessage, WorkerRequest } from '../shared/protocol.js';
/** 每个项目一个独立 Node 进程，环境加载与本地原生模块不进入 Electron。 */
export class WorkerHost {
  private child: ChildProcess;
  private pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private ready: Promise<void>;
  private stopped = false;
  private shuttingDown = false;
  constructor(
    node: string,
    entry: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    onState: (state: RuntimeSnapshot) => void,
    onExit: () => void,
  ) {
    this.child = fork(entry, [], {
      execPath: node,
      execArgv: [],
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Agent 进程启动超时')), 30_000);
      this.child.on('message', (raw: WorkerMessage) => {
        if (raw.type === 'ready') {
          clearTimeout(timeout);
          resolve();
        }
        if (raw.type === 'state') onState(raw.state);
        if (raw.type === 'reply') {
          const request = this.pending.get(raw.id);
          if (request) {
            clearTimeout(request.timer);
            this.pending.delete(raw.id);
            if (raw.error) request.reject(new Error(raw.error));
            else request.resolve();
          }
        }
      });
      this.child.once('error', () => {
        clearTimeout(timeout);
        reject(new Error('无法启动随包 Node 运行时'));
      });
      this.child.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('Agent 进程已退出'));
      });
    });
    this.child.on('exit', () => {
      this.stopped = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Agent 进程中断；未自动重试工具。'));
      }
      this.pending.clear();
      if (!this.shuttingDown) onExit();
    });
    this.child.on('error', () => {
      if (!this.shuttingDown) onExit();
    });
    // 防止进程在 initialize 建立等待之前失败产生未处理拒绝。
    void this.ready.catch(() => {});
  }
  async request(action: WorkerRequest['action']): Promise<void> {
    await this.ready;
    if (this.stopped) throw new Error('Agent 进程已退出');
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Agent 应答超时，操作结果未知；请检查状态，不要重复执行。'));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, action }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('Agent 连接中断'));
        }
      });
    });
  }
  async dispose() {
    if (this.stopped) return;
    this.shuttingDown = true;
    try {
      await this.request({ type: 'dispose' });
    } catch (error) {
      this.shuttingDown = false;
      throw error;
    }
    this.child.disconnect();
    await new Promise<void>((resolve) => {
      if (this.stopped) resolve();
      else this.child.once('exit', () => resolve());
    });
  }
}
