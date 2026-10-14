/** 离线核验冻结证据；只读取本目录和版本化源码，不访问网络或加载模型。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(read(name));
const jsonl = (name: string) =>
  read(name)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const budget = json('budget.json');
const events = jsonl('events.jsonl');
const transports = events.filter((row) => row.kind === 'transport');
const usage = events.filter((row) => row.kind === 'transport_usage');
assert.equal(budget.attempts.length, 48);
assert.equal(transports.length, 48);
assert.equal(usage.length, 45);
assert.equal(new Set(usage.map((row) => row.index)).size, 45);
for (const [offset, attempt] of budget.attempts.entries()) {
  assert.equal(attempt.index, offset + 1);
  assert.ok(Date.parse(attempt.at) >= Date.parse('2026-10-13T04:05:00Z'));
  assert.ok(Date.parse(attempt.at) < Date.parse('2026-10-13T05:50:00Z'));
  const matching = transports.filter((row) => row.index === attempt.index);
  assert.equal(matching.length, 1);
  for (const key of ['version', 'scenario', 'requestId', 'runId', 'role'])
    assert.equal(matching[0][key], attempt[key]);
}
for (const row of usage) {
  assert.equal(row.hit + row.miss, row.inputTotal);
  assert.equal(row.hit, row.vendorHit);
  assert.equal(row.miss, row.vendorMiss);
}
for (const total of json('role-totals.json')) {
  const attempts = budget.attempts.filter(
    (row) => row.version === total.version && row.role === total.role,
  );
  const known = usage.filter((row) => row.version === total.version && row.role === total.role);
  assert.equal(total.transports, attempts.length);
  assert.equal(total.unknownUsage, attempts.length - known.length);
  for (const key of ['hit', 'miss', 'output'])
    assert.equal(
      total[key],
      known.reduce((sum, row) => sum + row[key], 0),
    );
  assert.equal(total.totalInput, total.hit + total.miss);
}

const root = fileURLToPath(new URL('../../../', import.meta.url));
const baseline = json('versions.json').baseline.head;
const sources = {
  baseline: execFileSync('git', ['show', `${baseline}:src/builtin/reviewer-model/model.ts`], {
    cwd: root,
    encoding: 'utf8',
  }),
  candidate: readFileSync(`${root}/src/builtin/reviewer-model/model.ts`, 'utf8'),
};
const systems: Record<string, string> = {};
for (const [version, source] of Object.entries(sources)) {
  const system = source.match(/export const STRICT_REVIEWER_SYSTEM = `([\s\S]*?)`;/)?.[1];
  assert.ok(system);
  systems[version] = system;
  for (const row of json('judge-requests.json').filter((item) => item.version === version)) {
    assert.equal(sha(system), row.systemHash);
    assert.equal(Buffer.byteLength(system), row.systemBytes);
    assert.equal(row.inputTokens, row.hitTokens + row.missTokens);
  }
}
const a = Buffer.from(systems.baseline);
const b = Buffer.from(systems.candidate);
let prefix = 0;
while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
assert.equal(prefix, 389);
const proof = json('content-mismatch-proof.json');
const writes = json('successful-write-metadata.json');
for (const match of proof.writeHashMatches) {
  // 仅有公开的合成哨兵值，不保存原任务提示；字段按执行门的规则排序。
  assert.equal(
    sha(JSON.stringify({ content: 'CACHE_AUDIT_OK\n', path: match.match.file })),
    match.inputHash,
  );
  assert.equal(
    writes.filter(
      (row) =>
        row.runId === proof.runId &&
        row.phase === 'execution' &&
        row.reasonCode === 'tool_success' &&
        row.inputHash === match.inputHash,
    ).length,
    1,
  );
}
const cost = usage.reduce(
  (sum, row) => sum + (row.hit * 0.003 + row.miss * 0.15 + row.output * 0.6) / 1e6,
  0,
);
assert.ok(Math.abs(cost - 0.016019298) < 1e-12);
console.log(
  JSON.stringify({
    transports: 48,
    knownUsage: 45,
    unknownUsage: 3,
    systemPrefixBytes: prefix,
    estimatedKnownUSD: cost,
  }),
);
