/** 用户明确提交的项目 .env 编辑；不装载进程环境、不返回已保存值、不触发账户授权。 */
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { resolveAgentPaths } from '../core/paths.js';
import { TextConfigStore } from '../runtime/text-config-store.js';
import type { SettingsSection } from '../sdk/index.js';
import { SettingsSecrets } from './settings-secrets.js';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function assignment(key: string, value: string): string {
  for (const quote of ["'", '`', '"']) {
    if (value.includes(quote)) continue;
    const candidate = key + '=' + quote + value + quote + '\n';
    if (parseEnv(candidate)[key] === value) return candidate;
  }
  const candidate = key + '=' + value + '\n';
  if (parseEnv(candidate)[key] === value) return candidate;
  throw new Error('此值无法以 Node .env 语法无损保存。');
}
/** 只替换发生变化的赋值段，未知行、注释、空行及未改动的引号保持原样。 */
export function patchEnvironment(text: string, next: Record<string, string>): string {
  const old = parseEnv(text),
    changed = new Set(
      [...Object.keys(old), ...Object.keys(next)].filter((k) => old[k] !== next[k]),
    );
  const pattern =
    /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|`[^`]*`|[^\r\n]*)[^\r\n]*(?:\r?\n|$)/gm;
  let output = text.replace(pattern, (line, key: string) => (changed.has(key) ? '' : line));
  for (const key of changed)
    if (Object.hasOwn(next, key))
      output += (output && !output.endsWith('\n') ? '\n' : '') + assignment(key, next[key]);
  const parsed = parseEnv(output);
  if (JSON.stringify(Object.entries(parsed).sort()) !== JSON.stringify(Object.entries(next).sort()))
    throw new Error('环境文件无法无损更新；未保存。');
  return output;
}
export function environmentSettingsSection(cwd: string): SettingsSection {
  const store = new TextConfigStore(join(resolveAgentPaths(cwd).projectRoot, '.env'));
  let base: object | undefined,
    secrets = new SettingsSecrets();
  const drafts = new WeakMap<object, { base: object; text: string }>();
  return {
    title: '连接密钥与项目环境',
    order: 12,
    applyMode: 'newSession',
    description:
      '仅由你手动添加、替换或清除项目 .env 值；已保存内容不会返回界面。API key 环境变量名在连接页配置。保存不会登录、请求模型或更改进程变量；退出 App 后重启采用，已存在的进程环境变量仍优先。当前 CLI 不加载用户目录 .env，因此此页只提供项目层。',
    schema: {
      type: 'object',
      properties: {
        variables: { type: 'object', additionalProperties: { type: 'string', writeOnly: true } },
      },
    },
    scopeTargets: [{ scope: 'project', path: store.path }],
    read(signal, scope = 'project') {
      signal.throwIfAborted();
      if (scope !== 'project') throw new Error('只支持项目环境变量。');
      base = store.read();
      secrets = new SettingsSecrets();
      return {
        variables: Object.fromEntries(
          Object.entries(parseEnv(store.text(base))).map(([key, value]) => [
            key,
            secrets.keep(value),
          ]),
        ),
      };
    },
    draft(raw, signal, scope = 'project') {
      signal.throwIfAborted();
      if (
        scope !== 'project' ||
        !base ||
        !record(raw) ||
        Object.keys(raw).some((k) => k !== 'variables') ||
        (raw.variables !== undefined && !record(raw.variables))
      )
        throw new Error('无效环境变量草稿。');
      const value = secrets.restore(raw.variables ?? {}) as Record<string, unknown>,
        strings: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          ['__proto__', 'prototype', 'constructor'].includes(key) ||
          typeof item !== 'string' ||
          item.includes('\0')
        )
          throw new Error('无效环境变量名称或值。');
        strings[key] = item;
      }
      const draft = Object.freeze({});
      drafts.set(draft, { base, text: patchEnvironment(store.text(base), strings) });
      return draft;
    },
    commit(draft, signal, scope = 'project') {
      signal.throwIfAborted();
      const saved = record(draft) ? drafts.get(draft) : undefined;
      if (scope !== 'project' || !saved) throw new Error('环境变量草稿已失效。');
      store.commit(saved.base, saved.text);
      drafts.delete(draft as object);
    },
  };
}
