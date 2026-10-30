import type { Row, RuntimeSnapshot } from '../shared/protocol.js';

export interface SnapshotDelta {
  baseSeq: number;
  seq: number;
  generation: string;
  sessionId: string;
  changes: Partial<Omit<RuntimeSnapshot, 'rows'>>;
  ids: string[];
  upsert: Row[];
  append: Array<{ id: string; text: string }>;
}
export function snapshotDelta(previous: RuntimeSnapshot, next: RuntimeSnapshot): SnapshotDelta {
  const changes: SnapshotDelta['changes'] = {};
  for (const k of Object.keys(next) as Array<keyof RuntimeSnapshot>) {
    if (k !== 'rows' && JSON.stringify(previous[k]) !== JSON.stringify(next[k]))
      (changes as Record<string, unknown>)[k] = next[k];
  }
  const old = new Map(previous.rows.map((row) => [row.id, row]));
  const upsert: Row[] = [],
    append: SnapshotDelta['append'] = [];
  for (const row of next.rows) {
    const before = old.get(row.id);
    if (JSON.stringify(before) === JSON.stringify(row)) continue;
    if (
      before &&
      row.text.startsWith(before.text) &&
      JSON.stringify({ ...before, text: '' }) === JSON.stringify({ ...row, text: '' })
    )
      append.push({ id: row.id, text: row.text.slice(before.text.length) });
    else upsert.push(row);
  }
  return {
    baseSeq: previous.seq,
    seq: next.seq,
    generation: next.generation,
    sessionId: next.sessionId,
    changes,
    ids: next.rows.map((r) => r.id),
    upsert,
    append,
  };
}
export function applySnapshotDelta(
  previous: RuntimeSnapshot,
  delta: SnapshotDelta,
): RuntimeSnapshot {
  if (
    delta.baseSeq !== previous.seq ||
    delta.generation !== previous.generation ||
    delta.sessionId !== previous.sessionId ||
    delta.seq <= previous.seq
  )
    throw new Error('SNAPSHOT_SEQUENCE');
  const rows = new Map(previous.rows.map((r) => [r.id, { ...r }]));
  for (const r of delta.upsert) rows.set(r.id, r);
  for (const a of delta.append) {
    const row = rows.get(a.id);
    if (!row) throw new Error('SNAPSHOT_ROW');
    row.text += a.text;
  }
  return {
    ...previous,
    ...delta.changes,
    seq: delta.seq,
    rows: delta.ids.map((id) => {
      const row = rows.get(id);
      if (!row) throw new Error('SNAPSHOT_ROW');
      return row;
    }),
  };
}
