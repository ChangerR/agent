import { execFile } from 'node:child_process';
import { z } from 'zod';
import { shellQuote } from './ssh-host.js';

const requestSchema = z.object({
  target: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/),
  path: z
    .string()
    .max(4096)
    .refine((value) => value.startsWith('/') && !/[\x00-\x1f]/.test(value))
    .default('/'),
});

export async function listRemoteDirectories(
  input: unknown,
  execute: typeof execFile = execFile,
): Promise<string[]> {
  const request = requestSchema.parse(input);
  const args = [
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
    'find',
    shellQuote(request.path),
    '-maxdepth',
    '1',
    '-type',
    'd',
    '-print0',
  ];
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execute(
      'ssh',
      args,
      { windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child?.stdin?.end();
  });
  const directories = stdout
    .split('\0')
    .filter((path) => path.startsWith('/') && !/[\x00-\x1f]/.test(path))
    .slice(0, 200);
  return [...new Set([request.path, ...directories])];
}
