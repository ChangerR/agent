/** 受控验收专用：在 fetch 边界观测 SDK 最终 JSON，仅返回大小、散列与公共前缀长度。 */
import { createHash } from 'node:crypto';

export type TransportRole = 'main' | 'planner' | 'child' | 'judge' | 'compact';
export interface TransportScope {
  provider: 'openai' | 'anthropic';
  role: TransportRole;
  /** 调用方对授权范围和 actor 做散列；不接受原始任务或路径作为标签。 */
  scopeHash: string;
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const metric = (value: Buffer) => ({ bytes: value.length, sha256: sha256(value) });
function parseObject(text: string, error: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // SyntaxError 可能包含正文片段；观测失败也不得泄露输入。
    throw new Error(error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}
export function commonPrefixBytes(a: Buffer, b: Buffer): number {
  let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index++;
  return index;
}
type Capture = {
  index: number;
  body: Buffer;
  parts: Record<'system' | 'messages' | 'tools' | 'settings', Buffer>;
  messages: Buffer[];
};
function comparison(previous: Capture | undefined, current: Capture) {
  if (!previous) return null;
  let equalLeadingMessages = 0;
  while (
    equalLeadingMessages < Math.min(previous.messages.length, current.messages.length) &&
    previous.messages[equalLeadingMessages].equals(current.messages[equalLeadingMessages])
  )
    equalLeadingMessages++;
  return {
    previousIndex: previous.index,
    bodyPrefixBytes: commonPrefixBytes(previous.body, current.body),
    partPrefixBytes: Object.fromEntries(
      Object.keys(current.parts).map((name) => {
        const key = name as keyof Capture['parts'];
        return [key, commonPrefixBytes(previous.parts[key], current.parts[key])];
      }),
    ),
    equalLeadingMessages,
    previousMessageCount: previous.messages.length,
  };
}

/** 最多八个范围及前一请求；原始请求上限 1MiB，另有分段副本。超限报错，不截断。 */
export function createTransportPrefixObserver() {
  let index = 0;
  let previous: Capture | undefined;
  const scopes = new Map<string, Capture>();
  return {
    observe(serializedBody: string, scope: TransportScope) {
      if (
        !scope ||
        !['openai', 'anthropic'].includes(scope.provider) ||
        !['main', 'planner', 'child', 'judge', 'compact'].includes(scope.role) ||
        typeof scope.scopeHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(scope.scopeHash)
      )
        throw new Error('Invalid redacted transport scope');
      const bytes = Buffer.from(serializedBody);
      if (bytes.length > 1024 * 1024) throw new Error('Transport observation exceeds 1MiB');
      const body = parseObject(serializedBody, 'Invalid transport JSON');
      if (
        !Array.isArray(body.messages) ||
        body.messages.some(
          (message) =>
            !message ||
            typeof message !== 'object' ||
            Array.isArray(message) ||
            !['system', 'user', 'assistant', 'tool', 'function'].includes(message.role),
        )
      )
        throw new Error('Expected JSON messages');
      const allMessages = body.messages as Array<Record<string, unknown>>;
      const messages = allMessages.filter((message) => message.role !== 'system');
      const system =
        scope.provider === 'openai'
          ? allMessages.filter((message) => message.role === 'system')
          : (body.system ?? null);
      const { system: _system, messages: _messages, tools: _tools, ...settings } = body;
      const current: Capture = {
        index: ++index,
        body: bytes,
        parts: {
          system: encode(system),
          messages: encode(messages),
          tools: encode(body.tools ?? null),
          settings: encode(settings),
        },
        messages: messages.map(encode),
      };
      const key = `${scope.provider}:${scope.role}:${scope.scopeHash}`;
      const evidence: Record<string, ReturnType<typeof metric>> = {};
      if (scope.role === 'judge') {
        const content = messages[0]?.content;
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content) && content.length === 1 && content[0]?.type === 'text'
              ? content[0].text
              : undefined;
        if (typeof text !== 'string') throw new Error('Expected complete reviewer evidence');
        const parsed = parseObject(text, 'Invalid reviewer evidence JSON');
        // 不输出不受控的对象键；基线与候选的固定证据字段都能观测。
        for (const name of [
          'currentUserRequest',
          'operation',
          'analysis',
          'policy',
          'context',
          'previousReviews',
          'omittedReviews',
          'provenance',
        ])
          if (Object.hasOwn(parsed, name)) evidence[name] = metric(encode(parsed[name]));
      }
      const row = {
        index: current.index,
        provider: scope.provider,
        role: scope.role,
        scopeHash: scope.scopeHash,
        body: metric(bytes),
        parts: Object.fromEntries(
          Object.entries(current.parts).map(([name, value]) => [name, metric(value)]),
        ),
        evidence,
        adjacent: comparison(previous, current),
        sameScope: comparison(scopes.get(key), current),
      };
      previous = current;
      scopes.delete(key);
      scopes.set(key, current);
      if (scopes.size > 8) scopes.delete(scopes.keys().next().value!);
      return row;
    },
    clear() {
      previous = undefined;
      scopes.clear();
    },
  };
}
