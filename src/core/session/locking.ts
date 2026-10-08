/** 跨进程互斥：检查版本与 rename / 删除必须在同一个文件锁内完成。 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { errnoCode, SessionError } from './errors.js';

export async function withSessionLock<T>(path: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const lockPath = `${path}.lock`;
  await fs.mkdir(dirname(path), { recursive: true });
  let handle;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      handle = await fs.open(lockPath, 'wx');
      break;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw new SessionError('io', `创建会话锁失败: ${lockPath}`, { cause: error, path: lockPath });
      if (attempt >= 100) throw new SessionError('busy', `会话文件正被其他进程使用: ${lockPath}。若进程已经退出，确认后可手动移除残留锁。`, { path: lockPath });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    signal?.throwIfAborted();
    await handle.writeFile(String(process.pid));
    return await task();
  } finally {
    await handle.close();
    await fs.unlink(lockPath);
  }
}
