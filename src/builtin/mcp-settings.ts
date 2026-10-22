/** MCP 配置只编辑固定用户 / 项目文件；凭据保留在宿主，不提供任意路径写入。 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAgentPaths } from '../core/paths.js';
import { McpConfigSchema } from '../mcp/config.js';
import { PluginConfigStore, type ConfigSnapshot } from '../runtime/config-store.js';
import type { SettingsSection, SettingsScope } from '../sdk/index.js';
import { MASKED_SETTING, safeSettingsValue } from './configuration-settings.js';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = ['command', 'args', 'env', 'url', 'headers'];
const protectedNames = new Set(['__proto__', 'prototype', 'constructor']);
export function mcpSettingsSection(cwd: string, activePath?: string): SettingsSection {
  const paths = resolveAgentPaths(cwd);
  const stores = {
    project: new PluginConfigStore(join(paths.projectRoot, 'mcp.json')),
    global: new PluginConfigStore(join(paths.agentHome, 'mcp.json')),
  };
  const bases = new Map<SettingsScope, ConfigSnapshot>();
  const drafts = new WeakMap<
    object,
    { base: ConfigSnapshot; scope: 'project' | 'global'; value: unknown }
  >();
  const store = (scope: SettingsScope) => {
    if (scope !== 'project' && scope !== 'global') throw new Error('不支持此作用域。');
    return stores[scope];
  };
  const project = (value: unknown) =>
    Object.fromEntries(
      Object.entries(record(value) ? value : {}).map(([name, server]) => [
        name,
        Object.fromEntries(
          fields
            .filter((field) => record(server) && Object.hasOwn(server, field))
            .map((field) => [
              field,
              ['args', 'env', 'headers'].includes(field)
                ? MASKED_SETTING
                : safeSettingsValue((server as Record<string, unknown>)[field], field),
            ]),
        ),
      ]),
    );
  return {
    title: 'MCP 服务器配置',
    order: 30,
    applyMode: 'newSession',
    description: `编辑固定用户 / 项目目录中的 mcp.json；不会自动切换 mcpConfig。当前运行文件：${activePath ?? '未声明'}。保存后重启连接。args / env / headers 已掩码；现有值可保留或删除，新增凭据请在 CLI 文件中维护。此页不会启动服务器。`,
    schema: {
      type: 'object',
      properties: {
        mcpServers: {
          type: 'object',
          description: '服务器名称到 command/args 或 url 的 JSON 映射',
        },
      },
    },
    scopeTargets: (['project', 'global'] as const).map((scope) => ({
      scope,
      path: stores[scope].path,
    })),
    read(signal, scope = 'project') {
      signal.throwIfAborted();
      const base = store(scope).readFields(['mcpServers']);
      bases.set(scope, base);
      return Object.hasOwn(base.value, 'mcpServers')
        ? { mcpServers: project(base.value.mcpServers) }
        : {};
    },
    draft(raw, signal, scope = 'project') {
      signal.throwIfAborted();
      store(scope);
      const base = bases.get(scope);
      if (!base || !record(raw) || Object.keys(raw).some((key) => key !== 'mcpServers'))
        throw new Error('无效 MCP 草稿。');
      const configured = raw.mcpServers;
      if (configured !== undefined && !record(configured))
        throw new Error('服务器配置必须为对象。');
      const previous = record(base.value.mcpServers) ? base.value.mcpServers : {};
      const servers = Object.fromEntries(
        Object.entries(configured ?? {}).map(([name, server]) => {
          if (
            protectedNames.has(name) ||
            !record(server) ||
            Object.keys(server).some((key) => !fields.includes(key))
          )
            throw new Error('无效服务器字段。');
          const old = record(previous[name]) ? previous[name] : {};
          const next = { ...old };
          for (const field of fields) {
            const value = server[field];
            if (value === MASKED_SETTING) {
              if (!Object.hasOwn(old, field)) throw new Error('无效掩码。');
              continue;
            }
            if (value === undefined) {
              delete next[field];
              continue;
            }
            if (field === 'env' || field === 'headers')
              throw new Error('请在 CLI 文件中维护 MCP 凭据。');
            if (field === 'url') {
              const url = new URL(String(value));
              if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.search ||
                url.hash
              )
                throw new Error('MCP URL 不允许嵌入凭据。');
            }
            if (
              field === 'command' &&
              (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/.test(value))
            )
              throw new Error('无效 MCP 程序路径。');
            next[field] = value;
          }
          return [name, next];
        }),
      );
      const value = configured === undefined ? undefined : servers;
      McpConfigSchema.parse(value === undefined ? {} : { mcpServers: value });
      const draft = Object.freeze({ id: randomUUID() });
      drafts.set(draft, {
        base,
        scope: scope as 'project' | 'global',
        value: structuredClone(value),
      });
      return draft;
    },
    commit(draft, signal, scope = 'project') {
      signal.throwIfAborted();
      const saved = record(draft) ? drafts.get(draft) : undefined;
      if (!saved || saved.scope !== scope) throw new Error('MCP 草稿已过期或作用域不匹配。');
      bases.set(scope, store(scope).commitFields(saved.base, { mcpServers: saved.value }));
      drafts.delete(draft as object);
    },
  };
}
