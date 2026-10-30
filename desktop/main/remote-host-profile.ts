/** 添加主机只验证 SSH 身份和环境，不打开项目、不部署 agent、不读取模型凭据。 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sshHostInputSchema } from '../remote/protocol.js';
import { sshErrorCode } from './ssh-host.js';
export async function inspectRemoteHost(input: unknown, execute: typeof execFile = execFile) {
  const request = sshHostInputSchema.parse(input);
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = execute(
        'ssh',
        args,
        { windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024 },
        (error, stdout, stderr) =>
          error ? reject(new Error(sshErrorCode(error, stderr))) : resolve(stdout),
      );
      child?.stdin?.end();
    });
  const config = await run(['-G', request.target]);
  const identity = createHash('sha256')
    .update(
      config
        .split(/\r?\n/)
        .filter((line) => /^(hostname|port|user|proxyjump|proxycommand) /.test(line))
        .join('\n'),
    )
    .digest('hex');
  const output = await run([
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
    request.target,
    'uname -s; uname -m; printf "%s\\n" "$HOME"',
  ]);
  const [platform, arch, home] = output.trimEnd().split(/\r?\n/);
  if (platform !== 'Linux' || arch !== 'x86_64') throw new Error('UNSUPPORTED_PLATFORM');
  if (!home?.startsWith('/') || /[\x00-\x1f]/.test(home)) throw new Error('INVALID_HOME');
  return { target: request.target, name: request.name ?? request.target, identity, home };
}
