/** 项目级运行锁：只清理可证实已退出的 owner，PID 重用不视为同一进程。 */
import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

async function processStart(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
export async function acquireProjectLock(stateDir: string) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'desktop-runtime.lock');
  const token = randomUUID();
  const guard = path + '.guard';
  try {
    await mkdir(guard, { mode: 0o700 });
  } catch {
    throw new Error('PROJECT_BUSY');
  }
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(
          join(path, 'owner.json'),
          JSON.stringify({ token, pid: process.pid, start: await processStart(process.pid) }),
          { flag: 'wx', mode: 0o600 },
        );
        return async () => {
          try {
            await mkdir(guard, { mode: 0o700 });
          } catch {
            throw new Error('PROJECT_BUSY');
          }
          try {
            const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
            if (owner.token !== token) throw new Error('LOCK_CHANGED');
            await rm(path, { recursive: true });
          } finally {
            await rm(guard, { recursive: true });
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PROJECT_BUSY');
        let owner: { pid: number; start: string };
        try {
          owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
        } catch {
          throw new Error('PROJECT_BUSY');
        }
        if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.start !== 'string')
          throw new Error('PROJECT_BUSY');
        const start = await processStart(owner.pid);
        if (start === owner.start) throw new Error('PROJECT_BUSY');
        await rm(path, { recursive: true });
      }
    }
    throw new Error('PROJECT_BUSY');
  } finally {
    await rm(guard, { recursive: true });
  }
}
