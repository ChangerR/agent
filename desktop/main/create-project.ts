/** 用户主动创建工作区的宿主操作；只创建一个新目录和空项目标记，不接受模型调用。 */
import { execFile } from 'node:child_process';
import { mkdir, realpath, stat, writeFile, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { newProjectSchema, type NewProjectInput } from '../remote/protocol.js';
import { shellQuote, sshErrorCode } from './ssh-host.js';

export async function createLocalProjectDirectory(raw: NewProjectInput) {
  const input = newProjectSchema.parse(raw);
  if (input.location !== 'local' || !isAbsolute(input.parentPath))
    throw new Error('INVALID_PROJECT_PATH');
  const parent = await realpath(input.parentPath);
  if (!(await stat(parent)).isDirectory()) throw new Error('INVALID_PROJECT_PATH');
  const path = join(parent, input.name);
  await mkdir(path, { mode: 0o700 }); // 不递归、不覆盖已有目录。
  try {
    await writeFile(join(path, 'agent.config.json'), '{}\n', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    await rmdir(path).catch(() => {});
    throw e;
  }
  return path;
}
export async function createRemoteProjectDirectory(
  target: string,
  raw: NewProjectInput,
  execute: typeof execFile = execFile,
) {
  const input = newProjectSchema.parse(raw);
  if (
    input.location !== 'ssh' ||
    !input.parentPath.startsWith('/') ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(target)
  )
    throw new Error('INVALID_PROJECT_PATH');
  const script = `set -eu\nparent=$(realpath -e -- ${shellQuote(input.parentPath)})\ntest -d "$parent"\ndirectory="$parent"/${shellQuote(input.name)}\numask 077\nmkdir -m 700 -- "$directory"\n(set -C; printf '{}\\n' > "$directory/agent.config.json") || { rmdir -- "$directory" 2>/dev/null || :; exit 1; }\nprintf '%s\\0' "$directory"\n`;
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execute(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ConnectTimeout=15',
        target,
        'sh -s',
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 16384 },
      (error, out, err) =>
        error
          ? reject(
              new Error(
                /File exists/.test(err) ? 'PROJECT_ALREADY_EXISTS' : sshErrorCode(error, err),
              ),
            )
          : resolve(out),
    );
    child.stdin?.end(script);
  });
  const path = stdout.split('\0')[0];
  if (!path?.startsWith('/') || /[\x00-\x1f]/.test(path)) throw new Error('OUTCOME_UNKNOWN');
  return path;
}
