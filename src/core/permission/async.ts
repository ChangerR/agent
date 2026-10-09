/** 异步 capability 的统一取消/超时边界；迟到结果不能重新激活调用。 */
export class CapabilityTimeout extends Error {}
/** 不合作的异步 capability 也不能阻止取消/超时；迟到结果被丢弃。 */
export async function bounded<T>(handler: (signal: AbortSignal) => T | Promise<T>, parent: AbortSignal, timeoutMs: number): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(parent.reason); reject(parent.reason ?? new Error('Cancelled')); };
    parent.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { const error = new CapabilityTimeout('Capability timed out'); controller.abort(error); reject(error); }, Math.max(1, timeoutMs));
  });
  try { return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return handler(controller.signal); }), stop]); }
  finally { if (timer) clearTimeout(timer); if (abort) parent.removeEventListener('abort', abort); }
}
