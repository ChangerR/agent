/** Linux 只读 Shell 的描述符绑定。打开后先核验身份，任何内容读取都在核验成功以后。 */
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import type { ReadOnlyShellBinding } from './shell-readonly.js';

export async function openShellBindings(bindings: readonly ReadOnlyShellBinding[], cwd: string) {
  if (process.platform !== 'linux' || !bindings.length || bindings[0].kind !== 'directory')
    throw new Error('approval_stale: descriptor binding is unavailable');
  const handles: FileHandle[] = [];
  try {
    for (const binding of bindings) {
      // NONBLOCK 避免竞态把普通文件换成 FIFO 后阻塞；NOFOLLOW 不跟随最后一个链接。
      const handle = await open(
        binding.path,
        (binding.kind === 'discard' ? constants.O_WRONLY : constants.O_RDONLY) |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (binding.kind === 'directory' ? constants.O_DIRECTORY : 0),
      );
      handles.push(handle);
      const stat = await handle.stat({ bigint: true });
      if (
        `${stat.dev}:${stat.ino}:${stat.mode}:${stat.nlink}` !== binding.identity ||
        (binding.kind === 'directory'
          ? !stat.isDirectory()
          : binding.kind === 'discard'
            ? !stat.isCharacterDevice() || stat.rdev !== 259n
            : !stat.isFile() || stat.nlink !== 1n)
      )
        throw new Error('approval_stale: bound file identity changed');
    }
    return {
      // chdir 使用父进程仍持有的目录；子进程文件描述符编号从 stdio[3] 开始。
      cwd: `/proc/${process.pid}/fd/${handles[0].fd}`,
      env: Object.fromEntries([
        ['PWD', cwd],
        ...handles.map((_handle, i) => [`AGENTLAB_BOUND_${i}`, `/proc/self/fd/${i + 3}`]),
      ]),
      stdio: ['ignore', 'pipe', 'pipe', ...handles.map((handle) => handle.fd)] as Array<
        'ignore' | 'pipe' | number
      >,
      close: async () => {
        await Promise.all(handles.map((handle) => handle.close()));
      },
    };
  } catch {
    await Promise.all(handles.map((handle) => handle.close()));
    throw new Error('approval_stale: could not bind the approved shell files');
  }
}
