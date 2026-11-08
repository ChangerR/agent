/** 装配前信任门：只读取配置数据，批准前不导入插件、不连接 MCP、不解析凭据。 */
import { readFileSync, lstatSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  loadConfigWithSources,
  type AgentConfigOverrides,
  type LoadedConfig,
} from '../core/config.js';
import { resolveAgentPaths } from '../core/paths.js';
import { permissionHash } from '../core/permission/grants.js';
import { ConfigConflictError, PluginConfigStore } from './config-store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { permissionDisplay } from '../core/permission/display.js';

export interface StartupTrustEntry {
  id: string;
  digest: string;
  summary: string;
  details?: unknown;
}
export interface StartupTrustRequest {
  cwd: string;
  fingerprint: string;
  entries: readonly StartupTrustEntry[];
}
export class StartupTrustRequired extends Error {
  readonly code = 'startup_trust_required';
  constructor(readonly request: StartupTrustRequest) {
    super(
      'startup_trust_required: 项目请求激活执行入口或扩大授权；请审查启动信任后重试（CLI: --trust）。',
    );
  }
}
const schema = z.object({ approvals: z.record(z.string()).default({}) });
const namespace = 'agentlab.startup-trust';
function storeFor(cwd: string) {
  return new PluginConfigStore(join(resolveAgentPaths(cwd).projectStateDir, 'startup-trust.json'));
}
export function startupTrustEntry(id: string, value: unknown, summary: string): StartupTrustEntry {
  return {
    id,
    digest: permissionHash({ host: hostname(), uid: process.getuid?.(), value }),
    summary,
  };
}
function displayEndpoint(value: string): string {
  if (!value.trim()) return '默认服务端点';
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '格式无效的端点（未激活）';
  }
}
/** 仅宿主的明确用户动作调用；仓库配置本身不能写入此记录。 */
export function rememberStartupApproval(cwd: string, entries: readonly StartupTrustEntry[]): void {
  const store = storeFor(cwd),
    snapshot = store.read(namespace);
  const value = schema.parse(snapshot.value);
  for (const entry of entries) value.approvals[entry.id] = entry.digest;
  store.commit(namespace, snapshot, value, { schema, ownedFields: ['approvals'] });
}
export function forgetStartupApproval(cwd: string, ids: readonly string[]): void {
  const store = storeFor(cwd),
    snapshot = store.read(namespace);
  const value = schema.parse(snapshot.value);
  for (const id of ids) delete value.approvals[id];
  store.commit(namespace, snapshot, value, { schema, ownedFields: ['approvals'] });
}
function fileDigest(path: string): string {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_startup_file');
    return permissionHash(readFileSync(path).toString('base64'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new Error('startup_config_unsafe: 启动配置或插件入口不是可安全读取的普通文件');
  }
}
export function inspectStartupTrust(
  loaded: LoadedConfig,
  includeApproved = false,
): StartupTrustRequest {
  const { config, paths, layers, sources } = loaded;
  const entries: StartupTrustEntry[] = [];
  const add = (id: string, value: unknown, summary: string) => {
    const entry = startupTrustEntry(id, value, summary);
    const previous = entries.find((candidate) => candidate.id === id);
    if (previous) throw new Error('startup_config_invalid: 启动授权 ID 重复');
    entries.push({ ...entry, details: permissionDisplay(value) });
  };
  if (sources.pluginEntries.scope === 'project')
    for (const entry of config.pluginEntries) {
      if (typeof entry !== 'string' && !entry.enabled) continue;
      const path = typeof entry === 'string' ? entry : entry.entry;
      add(
        `plugin:${path}`,
        { path, digest: fileDigest(path) },
        `加载进程内插件 ${path}（拥有 Node.js 宿主权限）`,
      );
    }
  const mcpDigest = fileDigest(config.mcpConfig);
  if (
    mcpDigest !== 'missing' &&
    sources.mcpConfig.scope !== 'session' &&
    sources.mcpConfig.scope !== 'global'
  ) {
    let data: {
      mcpServers?: Record<
        string,
        {
          command?: string;
          args?: string[];
          url?: string;
          env?: Record<string, string>;
          inheritEnv?: string[];
          headers?: Record<string, string>;
        }
      >;
    };
    try {
      data = JSON.parse(readFileSync(config.mcpConfig, 'utf8'));
    } catch {
      throw new Error('startup_config_invalid: MCP 配置无效');
    }
    for (const [name, value] of Object.entries(data.mcpServers ?? {})) {
      let endpoint = '';
      if (value.url) endpoint = displayEndpoint(value.url);
      add(
        `mcp:${name}`,
        { configPath: config.mcpConfig, value },
        `MCP ${name}: ${value.command ?? endpoint}；环境变量名: ${Object.keys(value.env ?? {}).join(', ') || '无'}；继承变量名: ${value.inheritEnv?.join(', ') || '无'}；请求头名: ${Object.keys(value.headers ?? {}).join(', ') || '无'}`,
      );
      entries.at(-1)!.details = permissionDisplay({
        command: value.command,
        args: value.args,
        endpoint,
        environmentNames: Object.keys(value.env ?? {}),
        inheritedEnvironmentNames: value.inheritEnv ?? [],
        headerNames: Object.keys(value.headers ?? {}),
      });
    }
  }
  if (
    ['provider', 'baseURL', 'apiKeyEnv'].some(
      (key) => sources[key as keyof typeof sources].scope === 'project',
    )
  ) {
    let endpoint = '默认服务端点';
    if (config.baseURL) endpoint = displayEndpoint(config.baseURL);
    add(
      'provider-routing',
      {
        provider: config.provider,
        baseURL: config.baseURL,
        apiKeyEnv: config.apiKeyEnv,
        credential: config.pluginConfig['agentlab.providers'],
      },
      `模型路由 ${config.provider} → ${endpoint}；凭据变量名: ${config.apiKeyEnv ?? 'provider 默认值'}`,
    );
  }
  const permissions = layers.project.permissions as { allow?: string[] } | undefined;
  if (permissions?.allow?.length && !layers.session.permissions)
    add(
      'permission-allow',
      permissions.allow,
      `激活 ${permissions.allow.length} 条项目 allow 规则`,
    );
  const policy = (
    layers.project.pluginConfig as Record<string, Record<string, unknown>> | undefined
  )?.['agentlab.policy'];
  if (Array.isArray(policy?.writeRoots) && policy.writeRoots.length)
    add('write-roots', policy.writeRoots, `允许项目目录写入: ${policy.writeRoots.join(', ')}`);
  if (Array.isArray(policy?.grants))
    for (const grant of policy.grants as Array<{ id: string }>) {
      add(`grant:${grant.id}`, grant, `激活已保存项目授权 ${grant.id}`);
      entries.at(-1)!.details = permissionDisplay(grant);
    }
  if (Array.isArray(policy?.resourceRules))
    for (const rule of policy.resourceRules as Array<{ id: string; action: string }>) {
      if (rule.action === 'allow') {
        add(`resource-rule:${rule.id}`, rule, `激活资源授权 ${rule.id}`);
        entries.at(-1)!.details = permissionDisplay(rule);
      }
    }
  // 项目可通过单例选择或其他插件配置执行代码/改变端点，必须在 setup 之前批准。
  for (const key of ['capabilities', 'disabledPlugins', 'permissionMode'] as const)
    if (Object.hasOwn(layers.project, key) && !Object.hasOwn(layers.session, key))
      add(`config:${key}`, layers.project[key], `应用项目 ${key} 设置`);
  const pluginConfig = layers.project.pluginConfig as Record<string, unknown> | undefined;
  for (const [id, value] of Object.entries(pluginConfig ?? {}))
    if (id !== 'agentlab.policy') {
      add(`plugin-config:${id}`, value, `应用插件配置 ${id}`);
      entries.at(-1)!.details = permissionDisplay(value);
    }
  const approved = schema.parse(storeFor(paths.projectRoot).read(namespace).value).approvals;
  const pending = includeApproved
    ? entries
    : entries.filter((entry) => approved[entry.id] !== entry.digest);
  return {
    cwd: paths.projectRoot,
    entries: pending,
    fingerprint: permissionHash({ cwd: paths.projectRoot, entries: pending }),
  };
}
export async function authorizeStartup(
  loaded: LoadedConfig,
  overrides: AgentConfigOverrides,
  approve?: (request: StartupTrustRequest) => Promise<boolean> | boolean,
): Promise<void> {
  const request = inspectStartupTrust(loaded);
  if (!request.entries.length) return;
  const activation = inspectStartupTrust(loaded, true);
  if (
    request.entries.some(
      (entry) =>
        !activation.entries.some((value) => value.id === entry.id && value.digest === entry.digest),
    )
  )
    throw new Error('startup_trust_stale: 审查启动配置时内容已变化');
  if (!approve || (await approve(structuredClone(request))) !== true)
    throw new StartupTrustRequired(request);
  for (let attempt = 0; ; attempt++) {
    const current = loadConfigWithSources(loaded.paths.projectRoot, overrides);
    // 比较完整激活内容，不把另一个进程写入相同批准误认为配置变化。
    if (inspectStartupTrust(current, true).fingerprint !== activation.fingerprint)
      throw new Error('startup_trust_stale: 等待信任期间配置已变化');
    if (!inspectStartupTrust(current).entries.length) return;
    try {
      rememberStartupApproval(request.cwd, request.entries);
      return;
    } catch (error) {
      if (!(error instanceof ConfigConflictError) || attempt >= 9) throw error;
      // 仅重试原有明确批准；每次重读并验证配置，不复用过期 CAS 快照。
      await delay(10 * (attempt + 1));
    }
  }
}
