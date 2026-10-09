/** 通用 runtime 装配；默认实现由入口传入 preset，不导入 builtin/CLI。 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, GLOBAL_CONFIG, PROJECT_CONFIG, type AgentConfig } from '../core/config.js';
import { EventBus } from '../core/events.js';
import { HookRunner } from '../core/hooks.js';
import { AgentLoop } from '../core/loop.js';
import { ProviderRegistry, ToolRegistry } from '../core/registry.js';
import { ContextManager } from '../core/context/coordinator.js';
import { collectContext, contextText } from '../core/context/sources.js';
import { SessionManager } from '../core/session/coordinator.js';
import { adaptLegacyPlugin } from '../compat/legacy-plugin.js';
import type { Plugin as LegacyPlugin } from '../core/plugin.js';
import type { CapabilitySelections, PermissionController, Plugin, SkillSource } from '../sdk/index.js';
import type { Preset, PresetContext } from './preset.js';
import { PluginHost, observationSnapshot } from './plugin-host.js';
import { inspectPlugins } from './plugin-inspection.js';
import { CommandRegistry, settingsRecords } from './commands.js';
import type { Agent } from './agent.js';
export interface CreateAgentOptions { lifecycleTimeoutMs?: number; autoSaveSessions?: boolean; plugins?: readonly Plugin[]; preset?: (input: PresetContext) => Preset; config?: Partial<AgentConfig> }
function unavailableController(config: AgentConfig): PermissionController {
  const unavailable = () => { throw new Error('当前权限策略没有提供可编辑的权限控制器。'); };
  return { mode: config.permissionMode, validateSessionRules: rules => { if (Object.values(rules).some(v => v?.length)) unavailable(); }, validateMode: mode => { if (mode !== config.permissionMode) unavailable(); }, setMode: mode => { if (mode !== config.permissionMode) unavailable(); }, addSessionRule: unavailable, getSessionRules: () => ({ allow: [], ask: [], deny: [] }), setSessionRules: rules => { if (Object.values(rules).some(v => v?.length)) unavailable(); }, clearSessionRules() {}, getAuditLog: () => [], recordDecision() {} };
}
export async function createRuntime(cwd: string, presetFactory: (input: PresetContext) => Preset, options: CreateAgentOptions = {}): Promise<Agent> {
  if (options.lifecycleTimeoutMs !== undefined && (!Number.isFinite(options.lifecycleTimeoutMs) || options.lifecycleTimeoutMs <= 0)) throw new Error('lifecycleTimeoutMs must be a positive finite number');
  try { process.loadEnvFile(join(cwd, '.env')); } catch { /* 兼容现有缺省环境行为 */ }
  const config = { ...loadConfig(cwd), ...options.config } as AgentConfig;
  const endpoint = config.baseURL ?? (config.provider === 'openai' ? process.env.OPENAI_BASE_URL : undefined);
  const endpointURL = config.provider === 'openai' ? endpoint || undefined : endpoint;
  const providerConfig = config.provider === 'openai' ? { ...config, baseURL: endpointURL ?? 'https://api.openai.com/v1' } : config;
  const configRevision = () => {
    const hash = createHash('sha256').update(JSON.stringify(config));
    for (const path of [GLOBAL_CONFIG, join(cwd, PROJECT_CONFIG)]) hash.update(existsSync(path) ? readFileSync(path) : '<missing>');
    return hash.digest('hex');
  };
  const events = new EventBus(); const hooks = new HookRunner();
  const providers = new ProviderRegistry(); const tools = new ToolRegistry();
  const logPath = join(cwd, '.agentlab', 'logs', `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  let agent: Agent | undefined;
  let host: PluginHost;
  const services: PresetContext['services'] = {
    model: () => agent?.loop.model ?? config.model,
    setModel: model => agent!.loop.setModel(model),
    thinking: () => agent?.loop.thinking ?? config.thinking,
    setThinking: thinking => agent!.loop.setThinking(thinking),
    models: () => agent!.knownModels,
    permission: () => agent!.permission,
    session: () => agent!.session,
  };
  const preset = (options.preset ?? presetFactory)({ cwd, config: providerConfig, logPath, services,
    provider: name => providers.get(name ?? config.provider), capabilityChoices: () => Object.fromEntries((['policy', 'reviewer', 'compactor', 'cacheStrategy', 'modelCatalog', 'sessionStore'] as const).map(kind => { const current = host.selectedRecord(kind); return [kind, { selected: current?.capabilityId ?? false, available: host.list(kind).map(r => r.capabilityId) }]; })), modelInfo: model => host?.selected('modelCatalog')?.get(model) });
  const plugins = [...preset.plugins, ...(options.plugins ?? [])].filter(plugin => !config.disabledPlugins.includes(plugin.manifest.id));
  for (const entry of [...config.plugins, ...config.pluginEntries]) {
    if (typeof entry !== 'string' && !entry.enabled) continue;
    const path = typeof entry === 'string' ? entry : entry.entry;
    const imported = (await import(pathToFileURL(resolve(cwd, path)).href)) as { default: Plugin | LegacyPlugin };
    const plugin = 'manifest' in imported.default ? imported.default : adaptLegacyPlugin(imported.default, { config, requires: Object.fromEntries(plugins.map(p => [p.manifest.id, p.manifest.version])) });
    if (!config.disabledPlugins.includes(plugin.manifest.id)) plugins.push(plugin);
  }
  const selections = { ...preset.selections, ...config.capabilities } as CapabilitySelections;
  const layer = (path: string) => existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { pluginConfig?: Record<string, Record<string, unknown>> }).pluginConfig ?? {} : {};
  host = new PluginHost({ config, pluginConfig: config.pluginConfig, pluginConfigLayers: { global: layer(GLOBAL_CONFIG), project: layer(join(cwd, PROJECT_CONFIG)), session: options.config?.pluginConfig }, selections, events, configRevision: configRevision() });
  await host.load(plugins);
  const detach: Array<() => void> = [];
  try {
    host.installHooks(hooks);
    for (const record of host.list('provider')) providers.register(record.implementation);
    for (const record of host.list('tool')) {
      const implementation = record.implementation;
      const tool = Object.freeze({ ...implementation, version: record.version, ownerPlugin: record.ownerPlugin, inputSchema: observationSnapshot(implementation.inputSchema) });
      tools.register(tool);
      for (const alias of new Set([...(record.capabilityId !== tool.name ? [record.capabilityId] : []), ...record.aliases])) tools.alias(alias, tool.name);
    }
    providers.freeze(); tools.freeze();
    const policyRecord = host.selectedRecord('policy');
    const policy = policyRecord?.implementation; if (!policy || !policyRecord) throw new Error('A permission policy must be selected');
    const compactor = host.selected('compactor'); if (!compactor) throw new Error('A compactor must be selected');
    const store = host.selected('sessionStore'); if (!store) throw new Error('A session store must be selected');
    const catalog = host.selected('modelCatalog'); if (!catalog) throw new Error('A model catalog must be selected');
    const reviewer = host.selected('reviewer');
    // 选中的模型实现须在开始接收请求前解析实际 provider/model；未选能力不被探测。
    reviewer?.getStatus?.();
    const permission = policy.controller ?? unavailableController(config);
    const skillSources = host.list('skillSource').map(r => r.implementation);
    const skillLoader: SkillSource = { list: () => skillSources.flatMap(s => s.list()), get: name => skillSources.map(s => s.get(name)).find(Boolean) };
    const segments = await collectContext(host.list('contextSource').map(r => r.implementation), { cwd, tools: tools.list(), skills: skillLoader.list() }, new AbortController().signal);
    const modelInfo = (model: string) => catalog.get(model);
    const knownModels = [...new Set([...Object.keys(catalog.list()), config.model])].map(name => ({ name, info: modelInfo(name) }));
    const loop = new AgentLoop({ provider: providers.get(config.provider), model: config.model, tools, permission: undefined,
      policy, policyIdentity: { id: policyRecord.capabilityId, version: policyRecord.version }, reviewer, analyzer: policy.analyzer, reviewTimeoutMs: selections.reviewer === 'model-v2' && typeof config.pluginConfig['agentlab.reviewer-strict']?.timeoutMs === 'number' ? config.pluginConfig['agentlab.reviewer-strict'].timeoutMs as number : undefined,
      hooks, events, context: new ContextManager({ compactThreshold: config.compactThreshold, compactor }), systemPrompt: contextText(segments),
      maxTurns: config.maxTurns, cwd, shutdownTimeoutMs: options.lifecycleTimeoutMs, modelInfo, thinking: config.thinking, cache: config.cache, cacheStrategy: host.selected('cacheStrategy') ?? null,
      toolIdentity: name => { const record = host.getRecord('tool', name) ?? host.list('tool').find(r => r.implementation.name === name); return record && { capabilityId: record.capabilityId, ownerPlugin: record.ownerPlugin, version: record.version }; },
      configRevision, sessionId: () => agent?.session.id ?? 'initializing' });
    const session = new SessionManager({ cwd, loop, permission, events, store,
      restoreRequirements: { policy: { id: policy.id ?? policyRecord.capabilityId, version: policy.version ?? policyRecord.version, stateSchemaVersion: 1 } },
      autoSave: options.autoSaveSessions ?? true, persistenceTimeoutMs: options.lifecycleTimeoutMs, endpointKey: endpointURL ? createHash('sha256').update(endpointURL).digest('hex') : 'default' });
    detach.push(session.attach());
    for (const { implementation: sink } of host.list('telemetry')) detach.push(events.onAll(event => {
      try { void Promise.resolve(sink.onEvent(observationSnapshot(event))).catch(error => console.error('[telemetry]', error instanceof Error ? error.message : String(error))); }
      catch (error) { console.error('[telemetry]', error instanceof Error ? error.message : String(error)); }
    }));
    const commands = new CommandRegistry(host.list('command'));
    const settings = settingsRecords(host.list('settings')).map(record => ({ ...record, sources: host.configSources(record.ownerPlugin), implementations: host.capabilities.filter(c => c.ownerPlugin === record.ownerPlugin).map(c => `${c.kind}:${c.capabilityId}@${c.version}`) }));
    let disposal: Promise<void> | undefined;
    let closing = false;
    const commandAbort = new AbortController();
    const dispose = () => { closing = true; commandAbort.abort(); return disposal ??= (async () => {
      const errors: unknown[] = [];
      try { await loop.dispose(); } catch (error) { errors.push(error); }
      if (loop.hasPendingActivity) {
        // 工具没有响应取消时，执行结果尚未确定；不保存过早快照或释放它仍在使用的插件。
        void loop.whenSettled().then(async () => {
          try { await session.finalize(); } finally {
            await session.whenPersistenceSettled();
            for (const fn of detach.splice(0)) fn();
            await host.dispose();
          }
        }).catch(error => console.error('[cleanup]', error instanceof Error ? error.message : String(error)));
        throw new AggregateError(errors, 'Agent execution has not settled; resources retained until completion');
      }
      try { await session.finalize(); } catch (error) { errors.push(error); }
      if (session.hasPendingPersistence) {
        // 未确认的写入可能仍在使用 store；报告故障后等它真正结束才释放资源。
        void session.whenPersistenceSettled().then(async () => {
          for (const fn of detach.splice(0)) fn();
          await host.dispose();
        }).catch(error => console.error('[cleanup]', error instanceof Error ? error.message : String(error)));
      } else {
        for (const fn of detach.splice(0)) fn();
        try { await host.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Agent cleanup failed');
    })(); };
    const descriptor = (tool: ReturnType<ToolRegistry['get']>) => { if (!tool) return undefined; const { execute: _execute, ...rest } = tool; return Object.freeze(rest); };
    const toolCatalog: Agent['tools'] = Object.freeze({ get: (name: string) => descriptor(tools.get(name)), list: () => tools.list().map(tool => descriptor(tool)!), definitions: () => tools.definitions() });
    agent = { cwd, loop, events, permission, session, config, tools: toolCatalog, invokeTool: (name, input, signal) => loop.invokeTool(name, input, signal), providers, skillLoader, modelInfo, knownModels, logPath, plugins: inspectPlugins(host), commands, settings,
      dispatchCommand: (line, options = {}) => { if (closing) return Promise.reject(new Error('Agent runtime is disposing or disposed')); const signal = options.signal ? AbortSignal.any([options.signal, commandAbort.signal]) : commandAbort.signal; return commands.dispatch(line, { cwd, signal, interact: options.interact, inspect: () => observationSnapshot({ commands: commands.list(), settings: settings.map(s => ({ id: s.id, ownerPlugin: s.ownerPlugin, title: s.section.title, description: s.section.description, applyMode: s.section.applyMode })), plugins: host.manifests.map(p => ({ id: p.id, version: p.version })), tools: tools.list().map(t => ({ name: t.name, risk: t.risk })) }), invokeTool: (name, input) => loop.invokeTool(name, input, signal) }); }, dispose };
    return agent;
  } catch (error) {
    for (const fn of detach) fn();
    try { await host.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Agent initialization and cleanup failed'); }
    throw error;
  }
}
