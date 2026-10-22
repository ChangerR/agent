/** MCP 项目内不可变正文 + Unicode 偏移索引；所有元数据操作在项目锁下完成。 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalPath, resolveAgentPaths } from '../core/paths.js';

export const RESULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRIDE = 2048;
interface ResultIndex {
  version: 1;
  characters: number;
  bytes: number;
  digest: string;
  createdAt: number;
  accessedAt: number;
  mtimeMs: number;
  checkpoints: Array<[number, number]>;
}
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
export async function privateDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_result_directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await privateDirectory(dirname(path));
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  if (!samePath(await realpath(path), path)) throw new Error('unsafe_result_directory');
}
async function safeOpen(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stat = await file.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    await file.close();
    throw new Error('unsafe_result_file');
  }
  return file;
}
async function readJson(path: string, maxBytes = 32 * 1024 * 1024): Promise<any> {
  const file = await safeOpen(path);
  try {
    if ((await file.stat()).size > maxBytes) throw new Error('result_metadata_too_large');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
async function atomicJson(path: string, data: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(data));
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function validateIndex(value: any, bytes: number, mtimeMs: number): ResultIndex {
  if (
    value?.version !== 1 ||
    value.bytes !== bytes ||
    value.mtimeMs !== mtimeMs ||
    !Number.isSafeInteger(value.characters) ||
    value.characters < 0 ||
    value.characters > bytes ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isFinite(value.createdAt) ||
    !Number.isFinite(value.accessedAt) ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length !== Math.floor(value.characters / STRIDE) + 1
  )
    throw new Error('invalid_mcp_result_index');
  for (let i = 0; i < value.checkpoints.length; i++) {
    const point = value.checkpoints[i];
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      point[0] !== i * STRIDE ||
      !Number.isSafeInteger(point[1]) ||
      point[1] < 0 ||
      point[1] > bytes ||
      (i === 0 ? point[1] !== 0 : point[1] <= value.checkpoints[i - 1][1])
    )
      throw new Error('invalid_mcp_result_index');
  }
  return value;
}

export class IndexedResult {
  constructor(
    private file: FileHandle,
    readonly index: ResultIndex,
  ) {}
  async page(offset: number, limit: number, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const before = await this.file.stat();
    if (
      before.size !== this.index.bytes ||
      before.mtimeMs !== this.index.mtimeMs ||
      before.nlink !== 1
    )
      throw new Error('mcp_result_changed');
    if (offset > this.index.characters) throw new Error('mcp_result_offset_out_of_range');
    if (offset === this.index.characters) return '';
    const start = this.index.checkpoints[Math.floor(offset / STRIDE)];
    const endChar = Math.min(this.index.characters, offset + limit);
    const endPoint = this.index.checkpoints[Math.ceil(endChar / STRIDE)];
    const endByte = endPoint?.[1] ?? this.index.bytes;
    const buffer = Buffer.alloc(endByte - start[1]);
    let consumed = 0;
    while (consumed < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await this.file.read(
        buffer,
        consumed,
        buffer.length - consumed,
        start[1] + consumed,
      );
      if (!bytesRead) throw new Error('mcp_result_changed');
      consumed += bytesRead;
    }
    const after = await this.file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1)
      throw new Error('mcp_result_changed');
    return Array.from(buffer.toString('utf8'))
      .slice(offset - start[0], endChar - start[0])
      .join('');
  }
  close() {
    return this.file.close();
  }
}

export interface MaintenanceOptions {
  maxAgeDays: number;
  maxStoredBytes: number;
  graceMs?: number;
}
export interface MaintenanceResult {
  removed: number;
  bytes?: number;
  protectedBytes?: number;
  overCapacity?: boolean;
  blocked?: string;
}
export class ResultFiles {
  readonly directory: string;
  private readonly paths;
  private readonly leaseName = `${process.pid}-${randomUUID()}.json`;
  private pins = new Set<string>();
  constructor(cwd: string) {
    this.paths = resolveAgentPaths(cwd);
    this.directory = join(
      canonicalPath(this.paths.agentHome),
      'state',
      'projects',
      this.paths.projectId,
      'mcp-results',
    );
  }
  private async locked<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    await privateDirectory(this.directory);
    const path = join(this.directory, '.lock');
    let lock: FileHandle | undefined;
    for (let i = 0; i < 100; i++) {
      signal.throwIfAborted();
      try {
        lock = await open(path, 'wx', 0o600);
        await lock.writeFile(JSON.stringify({ pid: process.pid }));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (lock) {
            await lock.close();
            await unlink(path).catch(() => undefined);
            lock = undefined;
          }
          throw error;
        }
        try {
          const owner = await readJson(path, 1024);
          if (!alive(owner.pid)) {
            await unlink(path);
            continue;
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    if (!lock) throw new Error('mcp_result_store_busy');
    try {
      return await fn();
    } finally {
      await lock.close();
      await unlink(path);
    }
  }
  private async pin(id: string) {
    this.pins.add(id);
    const directory = join(this.directory, '.leases');
    await privateDirectory(directory);
    await atomicJson(join(directory, this.leaseName), { pid: process.pid, ids: [...this.pins] });
  }
  private async index(file: FileHandle, id: string): Promise<ResultIndex> {
    const stat = await file.stat();
    try {
      return validateIndex(
        await readJson(join(this.directory, `${id}.index.json`)),
        stat.size,
        stat.mtimeMs,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // 兼容 #46 已保存的正文：第一次续读流式建立索引，不把全文读入内存。
    const checkpoints: Array<[number, number]> = [[0, 0]];
    let characters = 0;
    let bytes = 0;
    const digest = createHash('sha256');
    const stream = file.createReadStream({ encoding: 'utf8', autoClose: false, start: 0 });
    for await (const chunk of stream) {
      digest.update(chunk);
      for (const point of String(chunk)) {
        characters++;
        bytes += Buffer.byteLength(point);
        if (characters % STRIDE === 0) checkpoints.push([characters, bytes]);
      }
    }
    if (bytes !== stat.size) throw new Error('mcp_result_changed');
    const value: ResultIndex = {
      version: 1,
      bytes,
      characters,
      checkpoints,
      digest: digest.digest('hex'),
      mtimeMs: stat.mtimeMs,
      createdAt: stat.mtimeMs,
      accessedAt: Date.now(),
    };
    await atomicJson(join(this.directory, `${id}.index.json`), value);
    return value;
  }
  async save(content: string, signal: AbortSignal, deduplicate = false): Promise<string> {
    return this.locked(signal, async () => {
      const digest = createHash('sha256').update(content).digest('hex');
      if (deduplicate) {
        for (const name of await readdir(this.directory)) {
          const id = name.replace(/\.index\.json$/, '');
          if (!RESULT_ID.test(id) || name === id) continue;
          const value = await readJson(join(this.directory, name));
          if (value.digest !== digest || value.bytes !== Buffer.byteLength(content)) continue;
          const file = await safeOpen(join(this.directory, `${id}.txt`));
          try {
            const stat = await file.stat();
            validateIndex(value, stat.size, stat.mtimeMs);
          } finally {
            await file.close();
          }
          await this.pin(id);
          return id;
        }
      }
      const id = randomUUID();
      const file = await open(join(this.directory, `${id}.txt`), 'wx', 0o600);
      let stat;
      try {
        signal.throwIfAborted();
        await file.writeFile(content, { encoding: 'utf8', signal });
        stat = await file.stat();
      } finally {
        await file.close();
      }
      const checkpoints: Array<[number, number]> = [[0, 0]];
      let characters = 0;
      let bytes = 0;
      for (const point of content) {
        characters++;
        bytes += Buffer.byteLength(point);
        if (characters % STRIDE === 0) checkpoints.push([characters, bytes]);
      }
      await atomicJson(join(this.directory, `${id}.index.json`), {
        version: 1,
        bytes,
        characters,
        checkpoints,
        digest,
        mtimeMs: stat.mtimeMs,
        createdAt: Date.now(),
        accessedAt: Date.now(),
      });
      await this.pin(id);
      return id;
    });
  }
  async open(id: string, signal: AbortSignal): Promise<IndexedResult> {
    if (!RESULT_ID.test(id)) throw new Error('invalid_mcp_result_page');
    if (!samePath(await realpath(this.directory), this.directory))
      throw new Error('unsafe_result_directory');
    return this.locked(signal, async () => {
      const file = await safeOpen(join(this.directory, `${id}.txt`));
      try {
        const index = await this.index(file, id);
        await this.pin(id);
        index.accessedAt = Date.now();
        await atomicJson(join(this.directory, `${id}.index.json`), index);
        return new IndexedResult(file, index);
      } catch (error) {
        await file.close();
        throw error;
      }
    });
  }
  async cleanup(
    options: MaintenanceOptions,
    signal: AbortSignal,
    now = Date.now(),
  ): Promise<MaintenanceResult> {
    try {
      if (!samePath(await realpath(this.directory), this.directory))
        return { removed: 0, blocked: 'unsafe_result_directory' };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return { removed: 0, bytes: 0, protectedBytes: 0, overCapacity: false };
      throw e;
    }
    return this.locked(signal, async () => {
      const protectedIds = new Set(this.pins);
      const result = { removed: 0, bytes: 0, protectedBytes: 0, overCapacity: false };
      try {
        const sessions = this.paths.sessionsDir;
        const names = await readdir(sessions).catch((e) => {
          if (e.code === 'ENOENT') return undefined;
          throw e;
        });
        if (names) {
          if (!samePath(await realpath(sessions), sessions))
            throw new Error('unsafe_session_directory');
          for (const name of names) {
            signal.throwIfAborted();
            if (!name.endsWith('.json')) continue;
            const text = JSON.stringify(await readJson(join(sessions, name)));
            for (const id of text.match(
              /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g,
            ) ?? [])
              protectedIds.add(id);
          }
        }
        const leases = join(this.directory, '.leases');
        const leaseNames = await readdir(leases).catch((e) => {
          if (e.code === 'ENOENT') return undefined;
          throw e;
        });
        if (leaseNames) {
          if (!samePath(await realpath(leases), leases)) throw new Error('unsafe_lease_directory');
          for (const name of leaseNames) {
            const lease = await readJson(join(leases, name));
            if (!Array.isArray(lease.ids)) throw new Error('invalid_result_lease');
            if (alive(lease.pid))
              for (const id of lease.ids) {
                if (typeof id !== 'string' || !RESULT_ID.test(id))
                  throw new Error('invalid_result_lease');
                protectedIds.add(id);
              }
            else await unlink(join(leases, name));
          }
        }
      } catch {
        return { removed: 0, blocked: 'reference_scan_incomplete' };
      }
      const candidates: Array<{ id: string; bytes: number; accessedAt: number }> = [];
      for (const name of await readdir(this.directory)) {
        const id = name.replace(/\.txt$/, '');
        if (!RESULT_ID.test(id) || name === id) continue;
        const file = await safeOpen(join(this.directory, name));
        try {
          const index = await this.index(file, id);
          const bytes = index.bytes + Buffer.byteLength(JSON.stringify(index));
          result.bytes += bytes;
          if (protectedIds.has(id)) result.protectedBytes += bytes;
          else candidates.push({ id, bytes, accessedAt: index.accessedAt });
        } finally {
          await file.close();
        }
      }
      candidates.sort((a, b) => a.accessedAt - b.accessedAt);
      for (const entry of candidates) {
        signal.throwIfAborted();
        const age = now - entry.accessedAt;
        if (age < (options.graceMs ?? 600000)) continue;
        if (
          !(options.maxAgeDays > 0 && age > options.maxAgeDays * 86400000) &&
          !(options.maxStoredBytes > 0 && result.bytes > options.maxStoredBytes)
        )
          continue;
        await unlink(join(this.directory, `${entry.id}.txt`));
        await unlink(join(this.directory, `${entry.id}.index.json`)).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
        });
        result.removed++;
        result.bytes -= entry.bytes;
      }
      result.overCapacity = options.maxStoredBytes > 0 && result.bytes > options.maxStoredBytes;
      return result;
    });
  }
  async close(): Promise<void> {
    try {
      if (
        !samePath(await realpath(this.directory), this.directory) ||
        !samePath(await realpath(join(this.directory, '.leases')), join(this.directory, '.leases'))
      )
        throw new Error('unsafe_result_directory');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.pins.clear();
        return;
      }
      throw e;
    }
    const path = join(this.directory, '.leases', this.leaseName);
    await unlink(path).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    this.pins.clear();
  }
  async hasResults(): Promise<boolean> {
    try {
      if (!samePath(await realpath(this.directory), this.directory)) return false;
      return (await readdir(this.directory)).some(
        (name) => name.endsWith('.txt') && RESULT_ID.test(name.slice(0, -4)),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }
}
