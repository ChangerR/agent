/** 父输入与启动任务的命令共用同一 FIFO，上一轮完全结算后才启动下一轮。 */
export class TurnQueue {
  private pending: Array<{ text: string; settled: () => void }> = [];
  private active = false;
  constructor(
    private run: (text: string) => Promise<void>,
    private changed: () => void,
    private failed: (error: unknown) => void,
  ) {}
  get running(): boolean {
    return this.active;
  }
  get size(): number {
    return this.pending.length;
  }
  get next(): string | undefined {
    return this.pending[0]?.text;
  }
  submit(text: string): Promise<void> {
    const done = new Promise<void>((settled) => {
      this.pending.push({ text, settled });
    });
    if (!this.active) void this.drain();
    else this.changed();
    return done;
  }
  clear(): number {
    const pending = this.pending.splice(0);
    for (const entry of pending) entry.settled();
    this.changed();
    return pending.length;
  }
  private async drain(): Promise<void> {
    this.active = true;
    try {
      while (this.pending.length) {
        const entry = this.pending.shift()!;
        this.changed();
        try {
          await this.run(entry.text);
        } catch (error) {
          this.failed(error);
        } finally {
          entry.settled();
        }
      }
    } finally {
      this.active = false;
      this.changed();
    }
  }
}
