import { describe, expect, it } from 'vitest';
import { ToolScheduler } from '../src/core/tool-scheduler.js';

describe('共享工作区实际租约', () => {
  it('读并发，写公平串行，取消排队操作不打断实际执行', async () => {
    const scheduler = new ToolScheduler();
    const signal = new AbortController().signal;
    const a = await scheduler.acquire('read', signal);
    const b = await scheduler.acquire('read', signal);
    let started = false;
    const write = scheduler.acquire('write', signal).then((lease) => {
      started = true;
      return lease;
    });
    const abort = new AbortController();
    const late = scheduler.acquire('read', abort.signal);
    abort.abort();
    await expect(late).rejects.toBeDefined();
    a.release();
    await Promise.resolve();
    expect(started).toBe(false);
    b.release();
    const writer = await write;
    let reader = false;
    const after = scheduler.acquire('read', signal).then((lease) => {
      reader = true;
      return lease;
    });
    await Promise.resolve();
    expect(reader).toBe(false);
    writer.release();
    (await after).release();
  });
  it('nested 实际执行保留外层写锁直到所有借用结算；旧上下文不能重新借用', async () => {
    const scheduler = new ToolScheduler();
    const signal = new AbortController().signal;
    const outer = await scheduler.acquire('write', signal);
    const nested = await scheduler.acquire('write', signal, outer);
    let overlap = false;
    const competing = scheduler.acquire('write', signal).then((lease) => {
      overlap = true;
      return lease;
    });
    outer.release();
    await Promise.resolve();
    expect(overlap).toBe(false);
    await expect(scheduler.acquire('read', signal, outer)).rejects.toThrow('no longer active');
    nested.release();
    (await competing).release();
    nested.release();
  });
  it('nested 读不能升级为写，不等待自身制造死锁', async () => {
    const scheduler = new ToolScheduler();
    const signal = new AbortController().signal;
    const read = await scheduler.acquire('read', signal);
    await expect(scheduler.acquire('write', signal, read)).rejects.toThrow('upgrade');
    read.release();
  });
  it('同一写租约的 sibling 调用必须串行，祖孙顺序调用可借用', async () => {
    const scheduler = new ToolScheduler();
    const signal = new AbortController().signal;
    const outer = await scheduler.acquire('write', signal);
    const child = await scheduler.acquire('write', signal, outer);
    await expect(scheduler.acquire('write', signal, outer)).rejects.toThrow('sequentially');
    const grandchild = await scheduler.acquire('write', signal, child);
    grandchild.release();
    child.release();
    const next = await scheduler.acquire('write', signal, outer);
    next.release();
    outer.release();
  });
  it('中间 child 提前返回仍保留孙调用对祖先 sibling 的串行保护', async () => {
    const scheduler = new ToolScheduler();
    const signal = new AbortController().signal;
    const outer = await scheduler.acquire('write', signal);
    const child = await scheduler.acquire('write', signal, outer);
    const grandchild = await scheduler.acquire('write', signal, child);
    child.release();
    await expect(scheduler.acquire('write', signal, outer)).rejects.toThrow('sequentially');
    grandchild.release();
    (await scheduler.acquire('write', signal, outer)).release();
    outer.release();
  });
});
