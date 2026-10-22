/** 固定领域文本配置的 CAS / 文件身份 / 锁 / 原子替换，原文永不跨宿主协议。 */
import * as fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigConflictError } from './config-store.js';
type State = { bytes?: Buffer; dev?: number; ino?: number; mode?: number };
export class TextConfigStore {
  readonly path: string;
  private snapshots = new WeakMap<object, State>();
  constructor(path: string) {
    this.path = resolve(path);
  }
  private state(): State {
    let fd: number | undefined;
    try {
      const before = fs.lstatSync(this.path);
      if (!before.isFile() || before.isSymbolicLink()) throw new ConfigConflictError();
      fd = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd);
      if (stat.dev !== before.dev || stat.ino !== before.ino) throw new ConfigConflictError();
      const bytes = fs.readFileSync(fd),
        after = fs.lstatSync(this.path);
      if (after.dev !== stat.dev || after.ino !== stat.ino || after.isSymbolicLink())
        throw new ConfigConflictError();
      return { bytes, dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 };
    } catch (error) {
      if (fd === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  read(): object {
    const token = Object.freeze({});
    this.snapshots.set(token, this.state());
    return token;
  }
  text(token: object): string {
    if (!this.snapshots.has(token)) throw new Error('无效快照。');
    return this.snapshots.get(token)!.bytes?.toString('utf8') ?? '';
  }
  commit(token: object, text: string): void {
    const old = this.snapshots.get(token);
    if (!old) throw new Error('无效快照。');
    const unchanged = () => {
      const now = this.state();
      if (
        now.dev !== old.dev ||
        now.ino !== old.ino ||
        now.mode !== old.mode ||
        Boolean(now.bytes) !== Boolean(old.bytes) ||
        (now.bytes && old.bytes && !now.bytes.equals(old.bytes))
      )
        throw new ConfigConflictError();
    };
    const temporary = this.path + '.' + randomUUID() + '.tmp',
      lock = this.path + '.settings.lock';
    let lockFd: number | undefined,
      fd: number | undefined,
      created = false;
    try {
      fs.mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        lockFd = fs.openSync(lock, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigConflictError();
        throw error;
      }
      unchanged();
      fd = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      fs.writeFileSync(fd, text);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      unchanged();
      fs.renameSync(temporary, this.path);
      created = false;
      this.snapshots.delete(token);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) fs.unlinkSync(temporary);
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        fs.unlinkSync(lock);
      }
    }
  }
}
