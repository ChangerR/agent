/** 输入队列只在上一轮 Promise 完全结束后启动下一轮，避免 loop_end 中重入。 */
export class TurnQueue {
  private pending: string[] = [];
  private active = false;

  constructor(
    private run: (text: string) => Promise<void>,
    private changed: () => void,
    private failed: (error: unknown) => void,
  ) {}

  get running(): boolean { return this.active; }
  get size(): number { return this.pending.length; }
  get next(): string | undefined { return this.pending[0]; }

  submit(text: string): void {
    this.pending.push(text);
    if (!this.active) void this.drain();
    else this.changed();
  }

  clear(): number {
    const count = this.pending.length;
    this.pending = [];
    this.changed();
    return count;
  }

  private async drain(): Promise<void> {
    this.active = true;
    try {
      while (this.pending.length) {
        const text = this.pending.shift()!;
        this.changed();
        try { await this.run(text); }
        catch (error) { this.failed(error); }
      }
    } finally {
      this.active = false;
      this.changed();
    }
  }
}
