import { randomBytes } from 'node:crypto';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
  return ID_RE.test(id);
}

export function newSessionId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `s-${stamp}-${randomBytes(2).toString('hex')}`;
}

