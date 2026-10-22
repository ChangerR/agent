/** 固定配置文件的 MCP 图形编辑；凭据句柄只在宿主内还原，保存不启动服务器。 */
import { isAbsolute, relative, resolve } from 'node:path';
import { loadConfigWithSources } from '../core/config.js';
import { resolveAgentPaths } from '../core/paths.js';
import { McpConfigSchema } from '../mcp/config.js';
import {
  PluginConfigStore,
  createScopedConfigStores,
  type ConfigSnapshot,
} from '../runtime/config-store.js';
import type { SettingsSection, SettingsScope } from '../sdk/index.js';
import { SettingsSecrets } from './settings-secrets.js';
import { assertManagedSettingsPath, commitSettingsReference } from './settings-paths.js';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = ['command', 'args', 'env', 'url', 'headers'];
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const text = { type: 'string' };
const secret = { type: 'string', writeOnly: true };
export function mcpSettingsSection(cwd: string, activePath?: string): SettingsSection {
  const paths = resolveAgentPaths(cwd);
  const references = createScopedConfigStores(cwd);
  const target = (scope: 'project' | 'global') => {
    const root = scope === 'project' ? paths.projectRoot : paths.agentHome;
    const configured = loadConfigWithSources(cwd).layers[scope].mcpConfig;
    return resolve(root, typeof configured === 'string' ? configured : 'mcp.json');
  };
  const bases = new Map<
    SettingsScope,
    {
      base: ConfigSnapshot;
      reference: ConfigSnapshot;
      secrets: SettingsSecrets;
      entries: Map<string, Record<string, unknown>>;
    }
  >();
  const drafts = new WeakMap<
    object,
    { scope: 'project' | 'global'; base: ConfigSnapshot; reference: ConfigSnapshot; value: unknown }
  >();
  const store = (scope: SettingsScope) => {
    if (scope !== 'project' && scope !== 'global') throw new Error('不支持此作用域。');
    const selected = new PluginConfigStore(target(scope));
    const r = relative(
      scope === 'project' ? paths.projectRoot : paths.agentHome,
      selected.path,
    );
    if (
      isAbsolute(r) ||
      r === '..' ||
      r.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    )
      throw new Error(
        '此 MCP 文件在受管目录之外；请在图形路径设置选择项目或用户配置目录中的位置后重启。',
      );
    assertManagedSettingsPath(
      scope === 'project' ? paths.projectRoot : paths.agentHome,
      selected.path,
    );
    return selected;
  };
  return {
    title: 'MCP 服务器配置',
    order: 30,
    applyMode: 'newSession',
    description: `管理服务器、stdio / HTTP、参数、环境变量与请求头。明确提交此页同时将所选层 mcpConfig 指向此文件；不会启动服务器，退出 App 后重启连接。当前运行引用：${activePath ?? '默认 mcp.json'}。`,
    schema: {
      type: 'object',
      properties: {
        mcpServers: {
          type: 'object',
          additionalProperties: {
            anyOf: [
              {
                type: 'object',
                title: '本地进程 stdio',
                required: ['command'],
                properties: {
                  command: text,
                  args: { type: 'array', items: secret },
                  env: { type: 'object', additionalProperties: secret },
                },
              },
              {
                type: 'object',
                title: '远程 HTTP（SDK 自动协商）',
                required: ['url'],
                properties: {
                  url: { ...secret, title: '服务器 URL' },
                  headers: { type: 'object', additionalProperties: secret },
                },
              },
            ],
          },
        },
      },
    },
    get scopeTargets() { return (['project', 'global'] as const).map((scope) => ({scope,path:target(scope)})); },
    read(signal, scope = 'project') {
      signal.throwIfAborted();
      const base = store(scope).readFields(['mcpServers']),
        secrets = new SettingsSecrets(),
        entries = new Map<string, Record<string, unknown>>();
      const servers = Object.fromEntries(
        Object.entries(record(base.value.mcpServers) ? base.value.mcpServers : {}).map(
          ([name, item]) => {
            if (!record(item)) throw new Error('服务器配置必须为对象。');
            const identity = secrets.keep(name).$secret;
            entries.set(identity, item);
            const result: Record<string, unknown> = { $entry: identity };
            for (const field of fields)
              if (Object.hasOwn(item, field)) {
                const value = item[field];
                result[field] =
                  field === 'env' || field === 'headers'
                    ? Object.fromEntries(
                        Object.entries(record(value) ? value : {}).map(([k, v]) => [
                          k,
                          secrets.keep(v),
                        ]),
                      )
                    : field === 'args' && Array.isArray(value)
                      ? value.map((v) => secrets.keep(v))
                      : field === 'url'
                        ? secrets.keep(value)
                        : value;
              }
            return [name, result];
          },
        ),
      );
      bases.set(scope, {
        base,
        reference: references.store(scope).readFields(['mcpConfig']),
        secrets,
        entries,
      });
      return Object.hasOwn(base.value, 'mcpServers') ? { mcpServers: servers } : {};
    },
    draft(raw, signal, scope = 'project') {
      signal.throwIfAborted();
      store(scope);
      const state = bases.get(scope);
      if (
        !state ||
        !record(raw) ||
        Object.keys(raw).some((k) => k !== 'mcpServers') ||
        (raw.mcpServers !== undefined && !record(raw.mcpServers))
      )
        throw new Error('无效 MCP 草稿。');
      const result = Object.fromEntries(
        Object.entries((raw.mcpServers ?? {}) as Record<string, unknown>).map(([name, item]) => {
          if (
            !name.trim() ||
            /[\u0000-\u001f]/.test(name) ||
            reserved.has(name) ||
            !record(item) ||
            Object.keys(item).some((k) => !fields.includes(k) && k !== '$entry')
          )
            throw new Error('无效服务器名称或字段。');
          if (
            item.$entry !== undefined &&
            (typeof item.$entry !== 'string' || !state.entries.has(item.$entry))
          )
            throw new Error('服务器草稿已失效。');
          const old =
            typeof item.$entry === 'string'
              ? state.entries.get(item.$entry)!
              : ((
                  state.base.value.mcpServers as Record<string, Record<string, unknown>> | undefined
                )?.[name] ?? {});
          const next = { ...old };
          for (const field of fields) {
            if (!Object.hasOwn(item, field)) {
              delete next[field];
              continue;
            }
            next[field] = state.secrets.restore(item[field]);
          }
          if (Object.hasOwn(next, 'command') === Object.hasOwn(next, 'url'))
            throw new Error('每个服务器必须选择一种传输。');
          if (
            typeof next.command === 'string' &&
            (!next.command.trim() || /[\u0000-\u001f]/.test(next.command))
          )
            throw new Error('无效程序路径。');
          if (next.url !== undefined) {
            const url = new URL(String(next.url));
            if (!['http:', 'https:'].includes(url.protocol))
              throw new Error('只支持 HTTP(S) MCP URL。');
          }
          if (record(next.env))
            for (const [key, value] of Object.entries(next.env))
              if (
                !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
                reserved.has(key) ||
                typeof value !== 'string' ||
                value.includes('\0')
              )
                throw new Error('无效环境变量。');
          if (record(next.headers))
            for (const [key, value] of Object.entries(next.headers))
              if (
                !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
                typeof value !== 'string' ||
                /[\r\n\0]/.test(value)
              )
                throw new Error('无效请求头。');
          return [name, next];
        }),
      );
      const value = raw.mcpServers === undefined ? undefined : result;
      McpConfigSchema.parse(value === undefined ? {} : { mcpServers: value });
      const draft = Object.freeze({});
      drafts.set(draft, {
        scope: scope as 'project' | 'global',
        base: state.base,
        reference: state.reference,
        value,
      });
      return draft;
    },
    commit(draft, signal, scope = 'project') {
      signal.throwIfAborted();
      const saved = record(draft) ? drafts.get(draft) : undefined;
      if (!saved || saved.scope !== scope) throw new Error('MCP 草稿已失效。');
      const targetStore = store(scope),
        active =
          scope === 'project'
            ? loadConfigWithSources(cwd).config.mcpConfig
            : target(scope as 'global');
      commitSettingsReference(
        references.store(scope),
        saved.reference,
        'mcpConfig',
        targetStore.path,
        active !== targetStore.path,
        () => targetStore.commitFields(saved.base, { mcpServers: saved.value }),
        (written) => {
          targetStore.commitFields(written, { mcpServers: saved.base.value.mcpServers });
        },
      );
      drafts.delete(draft as object);
    },
  };
}
