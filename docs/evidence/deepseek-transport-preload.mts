/** 本轮真实验收实际使用的 transport 闸门快照；本文件自身不发送请求。 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmdirSync,
} from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
const root = process.env.AGENT_ACCEPTANCE_ROOT!;
if (!root?.startsWith('/tmp/agent-live-acceptance-')) throw Error('Isolated fixture required');
const config = JSON.parse(readFileSync(join(root, 'project/agent.config.json'), 'utf8'));
const secret = process.env[config.apiKeyEnv];
const log = (value: unknown) =>
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify(value)
      .split(secret ?? '__no_secret__')
      .join('[REDACTED]') + '\n',
  );
const ledgerPath = join(root, 'budget.json');
const meta = new AsyncLocalStorage<{ purpose: string; model: string; logical: number }>();
let logical = 0;
const baseFetch = globalThis.fetch;
const endpoint = new URL(config.baseURL);
// 在 SDK 模块加载和客户端构建之前安装；每次实际 transport（含 SDK 重试）先持久扣减共享预算。
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.origin !== endpoint.origin || !url.pathname.endsWith('/chat/completions'))
    throw Error('Live acceptance network target blocked');
  const lock = ledgerPath + '.lock';
  mkdirSync(lock);
  let index = 0;
  try {
    const ledger = existsSync(ledgerPath)
      ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
      : { limit: 20, attempts: [] };
    if (ledger.limit !== 20 || ledger.attempts.length >= 20) throw Error('LIVE_REQUEST_LIMIT_20');
    index = ledger.attempts.length + 1;
    const body = JSON.parse(String(init?.body ?? '{}'));
    ledger.attempts.push({
      index,
      scenario: process.argv[2],
      ...meta.getStore(),
      transportModel: body.model,
      time: new Date().toISOString(),
    });
    writeFileSync(ledgerPath + '.next', JSON.stringify(ledger, null, 2));
    renameSync(ledgerPath + '.next', ledgerPath);
  } finally {
    rmdirSync(lock);
  }
  log({ kind: 'transport', index, ...meta.getStore() });
  try {
    const response = await baseFetch(input, { ...init, redirect: 'error' });
    log({ kind: 'transport_response', index, status: response.status });
    return response;
  } catch {
    log({ kind: 'transport_error', index });
    throw Error('Controlled live transport failure; no credential details');
  }
};
