/** 本轮84/100验收的transport闸门快照；仅作审计，不在测试或构建中执行。 */
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmdirSync,
} from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
export const root = process.env.AGENT_ROUND100_ROOT!;
if (!root?.startsWith('/tmp/agent-round100-')) throw Error('Isolated fixture required');
const config = JSON.parse(readFileSync(join(root, 'project/agent.config.json'), 'utf8'));
const secret = process.env[config.apiKeyEnv];
export const scenario = process.env.AGENT_ROUND100_SCENARIO ?? 'unknown';
export const log = (value: unknown) =>
  appendFileSync(
    join(root, 'events.jsonl'),
    JSON.stringify({ scenario, time: new Date().toISOString(), ...(value as object) })
      .split(secret ?? '__missing_secret__')
      .join('[REDACTED]') + '\n',
  );
export const ledger = () => JSON.parse(readFileSync(join(root, 'budget.json'), 'utf8'));
const ledgerPath = join(root, 'budget.json');
const meta = new AsyncLocalStorage<{ purpose: string; model: string; logical: string }>();
let logical = 0;
const baseFetch = globalThis.fetch;
const endpoint = new URL(config.baseURL);
// 在 OpenAI SDK 的模块加载、客户端构建和任何请求之前安装。重试也先记账。
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.origin !== endpoint.origin || !url.pathname.endsWith('/chat/completions'))
    throw Error('Live acceptance network target blocked');
  const lock = ledgerPath + '.lock';
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() > deadline)
        throw Error('Budget lock unavailable');
      await delay(10);
    }
  }
  let index = 0;
  try {
    const state = ledger();
    if (state.limit !== 100 || state.attempts.length >= 100) throw Error('LIVE_REQUEST_LIMIT_100');
    index = state.attempts.length + 1;
    const body = JSON.parse(String(init?.body ?? '{}'));
    state.attempts.push({
      index,
      scenario,
      ...meta.getStore(),
      transportModel: body.model,
      maxTokens: body.max_tokens,
      time: new Date().toISOString(),
    });
    writeFileSync(ledgerPath + '.next', JSON.stringify(state, null, 2));
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
    throw Error('Controlled live transport failure');
  }
};
const codeRoot = process.env.AGENT_ROUND100_CODE_ROOT ?? '/workspace/agent';
await import(codeRoot + '/node_modules/openai/shims/web.mjs');
const { OpenAIProvider } = await import(codeRoot + '/src/providers/openai.ts');
const original = OpenAIProvider.prototype.stream;
OpenAIProvider.prototype.stream = async function* (request, signal) {
  const entry = {
    purpose: request.system.startsWith('[agentlab planning:auto]')
      ? 'planning'
      : !request.tools.length
        ? 'reviewer'
        : 'main_or_child',
    model: request.model,
    logical: `${process.pid}-${++logical}`,
  };
  log({ kind: 'provider_start', ...entry, request });
  const iterator = original.call(this, request, signal)[Symbol.asyncIterator]();
  try {
    while (true) {
      const row = await meta.run(entry, () => iterator.next());
      if (row.done) break;
      log({ kind: 'provider_event', logical: entry.logical, event: row.value });
      yield row.value;
    }
  } finally {
    log({ kind: 'provider_end', ...entry });
    await iterator.return?.();
  }
};
