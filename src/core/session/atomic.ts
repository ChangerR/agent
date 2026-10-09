/**
 * 同目录临时文件 + rename 覆盖。失败只删临时文件，不先 unlink 目标。
 * 同一路径的写入串行，避免两个 save 互相踩。
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errnoCode, SessionError } from './errors.js';

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const queues = new Map<string, Promise<unknown>>();
const failures = new Map<string, unknown>();

function queueKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    let attempt = 0;
    for (;;) {
      try {
        await fs.rename(tmp, path);
        return;
      } catch (err) {
        const code = errnoCode(err);
        const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
        if (retryable && attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt]);
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    if (err instanceof SessionError) throw err;
    const code = errnoCode(err);
    throw new SessionError(
      'io',
      `写入会话失败: ${path}（${code}）。原文件未被改动，可重试 /save。`,
      { cause: err, path },
    );
  }
}

/** 同一路径串行。前一个失败不挡住后一个。队尾完成后从 Map 删掉。 */
export function enqueueWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = queueKey(path);
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(task);
  queues.set(key, run);
  // finally 会把原拒绝再抛出去；这里没有等待方，必须自己接住，避免 unhandled rejection。
  void run.then(
    () => { failures.delete(key); },
    (error) => { failures.set(key, error); },
  ).finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  }).catch(() => undefined);
  return run;
}

/** 等到该路径（或全部路径）上已入队的写入结束，并报告尚未观察的失败。 */
export async function flushWrites(path?: string): Promise<void> {
  const key = path === undefined ? undefined : queueKey(path);
  const pending = key === undefined ? [...queues.values()] : [queues.get(key)].filter((item): item is Promise<unknown> => item !== undefined);
  await Promise.allSettled(pending);
  const keys = key === undefined ? [...failures.keys()] : [key];
  const errors: unknown[] = [];
  for (const failedKey of keys) {
    if (failures.has(failedKey)) { errors.push(failures.get(failedKey)); failures.delete(failedKey); }
  }
  if (errors.length) throw new AggregateError(errors, '会话写入失败');
}
