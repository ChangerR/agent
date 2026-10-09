import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/core/session/atomic.js';
import { createJsonlTelemetry } from '../src/builtin/telemetry-jsonl/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('用户状态默认私有文件权限', () => {
  it.skipIf(process.platform === 'win32')('新会话与日志文件为 0600，新目录为 0700', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentlab-state-mode-')); roots.push(root);
    const session = join(root, 'sessions', 'session.json');
    await writeFileAtomic(session, '{}');
    const log = join(root, 'logs', 'session.jsonl');
    const sink = createJsonlTelemetry({ path: log });
    await sink.onEvent({ type: 'notice', text: 'fixture' });
    await sink.dispose?.();
    for (const path of [session, log]) {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
  });
});
