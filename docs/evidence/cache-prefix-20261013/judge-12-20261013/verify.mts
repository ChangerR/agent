/** 离线重算12次专项；不导入provider、不读取凭据、不联网。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const text = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
const json = (name: string) => JSON.parse(text(name));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const events = text('events.jsonl')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const budget = json('budget.json');
const summary = json('summary.json');
const requests = json('requests.json');
assert.equal(budget.limit, 12);
assert.equal(budget.attempts.length, 12);
assert.equal(requests.length, 12);
assert.equal(summary.files.eventsSha256, hash(text('events.jsonl')));
assert.equal(summary.files.budgetSha256, hash(text('budget.json')));
const select = (kind: string) => events.filter((row) => row.kind === kind);
for (const kind of ['transport_attempt', 'http_response', 'usage', 'review_result']) {
  assert.equal(select(kind).length, 12);
  assert.equal(new Set(select(kind).map((row) => row.index)).size, 12);
}
assert.equal(select('network_error').length + select('request_failed').length, 0);
const seen = new Set<string>();
for (let index = 1; index <= 12; index++) {
  const attempt = select('transport_attempt').find((row) => row.index === index);
  const ledger = budget.attempts[index - 1];
  const usage = select('usage').find((row) => row.index === index);
  const result = select('review_result').find((row) => row.index === index);
  const request = requests[index - 1];
  const block = Math.floor((index - 1) / 3);
  const phase = ['block-initial', 'exact-repeat', 'changed-operation'][(index - 1) % 3];
  assert.equal(attempt.block, block);
  assert.equal(attempt.version, ['baseline', 'candidate', 'candidate', 'baseline'][block]);
  assert.equal(attempt.phase, phase);
  assert.equal(attempt.observation.body.sha256, ledger.bodySha256);
  assert.equal(request.bodySha256, ledger.bodySha256);
  assert.equal(request.phase, phase);
  assert.equal(request.index, index);
  assert.equal(attempt.observedSameBodyBefore, seen.has(ledger.bodySha256));
  seen.add(ledger.bodySha256);
  assert.ok(Date.parse(ledger.at) >= Date.parse(summary.authorization.startUTC));
  assert.ok(Date.parse(ledger.at) < Date.parse(summary.authorization.conservativeStopUTC));
  assert.equal(select('http_response').find((row) => row.index === index).status, 200);
  assert.equal(result.valid, true);
  assert.equal(result.decision, 'allow');
  assert.match(result.reasonCodeSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, 'reasonCode'), false);
  assert.equal(Object.hasOwn(result, 'reason'), false);
  assert.equal(usage.hit + usage.miss, usage.inputTotal);
  assert.equal(usage.hit, usage.vendorHit);
  assert.equal(usage.hit, usage.genericHit);
  assert.equal(usage.miss, usage.vendorMiss);
  for (const field of ['inputTotal', 'hit', 'miss', 'output']) {
    assert.ok(Number.isSafeInteger(usage[field]) && usage[field] >= 0);
    assert.equal(request[field], usage[field]);
  }
  if (phase === 'exact-repeat') {
    assert.equal(attempt.exactRepeatVerified, true);
    assert.equal(attempt.observation.adjacent.bodyPrefixBytes, attempt.observation.body.bytes);
    assert.equal(ledger.bodySha256, budget.attempts[index - 2].bodySha256);
  }
}
for (const version of ['baseline', 'candidate']) {
  const rows = requests.filter((row) => row.version === version);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.bodySha256)).size, 2);
  for (const field of ['inputTotal', 'hit', 'miss', 'output'])
    assert.equal(
      rows.reduce((sum, row) => sum + row[field], 0),
      summary.totals[version][field],
    );
}
const frozen = select('frozen')[0];
assert.deepEqual(frozen.inputHashes.baseline, frozen.inputHashes.candidate);
assert.notEqual(frozen.systemHashes.baseline, frozen.systemHashes.candidate);
assert.equal(events.at(-1).used, 12);
assert.equal(events.at(-1).remaining, 0);
assert.equal(events.at(-1).simulated, 0);
assert.equal(events.at(-1).toolsExecuted, 0);
assert.equal(events.at(-1).approvalsReused, 0);
assert.doesNotMatch(
  text('events.jsonl'),
  /CACHE_AUDIT_OK|audit-a\.txt|audit-b\.txt|\/tmp\/|\/workspace\/|Bearer |"reason":|"reasonCode":/,
);
console.log(
  JSON.stringify({ actualTransports: 12, remaining: 0, usageUnknown: 0, totals: summary.totals }),
);
