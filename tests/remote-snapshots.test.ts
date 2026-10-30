import { describe, expect, it } from 'vitest';
import { snapshotDelta, applySnapshotDelta } from '../desktop/remote/snapshots.js';
import type { RuntimeSnapshot } from '../desktop/shared/protocol.js';
describe('远程展示增量', () => {
  it('追加正文、更新工具、裁剪展示窗口可重建权威快照', () => {
    const before = {
      seq: 1,
      generation: 'g',
      sessionId: 's',
      rows: [
        { id: 'old', kind: 'notice', text: 'old' },
        { id: 'a', kind: 'assistant', text: 'hello' },
      ],
    } as RuntimeSnapshot;
    const after = {
      ...before,
      seq: 2,
      phase: '执行',
      rows: [
        { id: 'a', kind: 'assistant', text: 'hello world' },
        { id: 't', kind: 'tool', text: 'result', status: 'completed' },
      ],
    } as RuntimeSnapshot;
    const delta = snapshotDelta(before, after);
    expect(delta.append).toEqual([{ id: 'a', text: ' world' }]);
    expect(applySnapshotDelta(before, delta)).toEqual(after);
    expect(() => applySnapshotDelta({ ...before, seq: 3 }, delta)).toThrow('SNAPSHOT_SEQUENCE');
  });
});
