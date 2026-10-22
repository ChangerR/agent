/** 全局设置不创建 Agent、会话、工具或 Provider；只构建同一 preset 的设置定义。 */
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getGlobalConfigPath } from '../../src/core/paths.js';
import { loadConfigWithSources, loadModelsFile } from '../../src/core/config.js';
import { defaultPreset } from '../../src/builtin/default-preset.js';
import { runtimeSettingsSections } from '../../src/builtin/runtime-settings.js';
import { safeSettingsValue } from '../../src/builtin/configuration-settings.js';
import { MODEL_PRESETS } from '../../src/builtin/model-catalog/index.js';
import { settingsErrorMessage } from '../../src/runtime/config-store.js';
import type { PresetContext } from '../../src/runtime/preset.js';
import type { Plugin, SettingsSection } from '../../src/sdk/index.js';
import type { GlobalSettingsAction, SettingsSnapshot } from '../shared/protocol.js';

export class GlobalSettingsController {
  private records: Array<{ id: string; section: SettingsSection }> = [];
  private editor?: { id: string; section: SettingsSection };
  private state!: SettingsSnapshot;
  private queue: Promise<unknown> = Promise.resolve();
  private cwd = join(dirname(getGlobalConfigPath()), '.settings-context');
  constructor(private publish: (state: SettingsSnapshot) => void) {}
  async initialize(generation: string) {
    const loaded = loadConfigWithSources(this.cwd, {}, { globalOnly: true });
    const unavailable = (): never => {
      throw new Error('全局设置没有活动会话。');
    };
    const choices = {
      policy: 'deterministic',
      reviewer: 'model',
      compactor: 'summary',
      cacheStrategy: 'prefix',
      modelCatalog: 'presets',
      sessionStore: 'file',
    };
    const input: PresetContext = {
      cwd: this.cwd,
      paths: loaded.paths,
      config: loaded.config,
      configSources: loaded.sources,
      logPath: '',
      settingsGlobalOnly: true,
      provider: unavailable,
      modelInfo: (id) => MODEL_PRESETS[id],
      capabilityChoices: () =>
        Object.fromEntries(
          Object.entries(choices).map(([kind, id]) => [
            kind,
            {
              selected:
                loaded.config.capabilities[kind as keyof typeof loaded.config.capabilities] ?? id,
              available: [id],
            },
          ]),
        ),
      services: {
        loop: unavailable,
        plan: unavailable,
        run: unavailable,
        stopPlan: unavailable,
        configurePlanning: unavailable,
        model: unavailable,
        setModel: unavailable,
        thinking: unavailable,
        setThinking: unavailable,
        models: unavailable,
        permission: unavailable,
        session: unavailable,
        agents: unavailable,
        configureAgents: unavailable,
      },
    };
    const preset = defaultPreset(input),
      definitions: Plugin[] = [...preset.plugins];
    for (const entry of loaded.config.pluginEntries) {
      if (typeof entry !== 'string' && !entry.enabled) continue;
      const imported = await import(
        pathToFileURL(typeof entry === 'string' ? entry : entry.entry).href
      );
      if (!imported.default?.manifest || typeof imported.default.setup !== 'function')
        throw new Error('全局插件定义无效。');
      definitions.push(imported.default);
    }
    this.records = runtimeSettingsSections(input, definitions).filter(({ section }) =>
      section.scopeTargets?.some((t) => t.scope === 'global'),
    );
    this.state = {
      generation,
      revision: 0,
      provider: loaded.config.provider,
      providers: ['openai', 'anthropic', 'fake'],
      models: [],
      modelDetails: [],
      tools: [],
      settings: this.records.map(({ id, section }) => ({
        id,
        title: section.title,
        description: section.description,
        schema: section.getSchema?.() ?? section.schema,
        applyMode: section.applyMode,
        scopes: (section.scopeTargets ?? []).filter((t) => t.scope === 'global') as Array<{
          scope: 'global';
          path: string;
        }>,
        editable: !!section.draft && !!section.commit,
      })),
    };
    this.refresh();
    this.emit();
  }
  private refresh() {
    const { config } = loadConfigWithSources(this.cwd, {}, { globalOnly: true });
    const connections = (config.pluginConfig['agentlab.provider-connections']?.connections ??
      {}) as Record<string, { displayName?: string; enabled?: boolean }>;
    this.state.provider = config.provider;
    this.state.providerOptions = [
      ...this.state.providers,
      ...Object.entries(connections)
        .filter(([, v]) => v.enabled !== false)
        .map(([id]) => id),
    ];
    this.state.providerLabels = Object.fromEntries(
      Object.entries(connections)
        .filter(([, v]) => typeof v.displayName === 'string')
        .map(([id, v]) => [id, v.displayName!]),
    );
    const models = { ...MODEL_PRESETS, ...loadModelsFile(config.modelsFile) };
    this.state.modelDetails = Object.entries(models).map(([id, info]) => ({ id, ...info }));
    this.state.models = [...new Set([config.model, ...Object.keys(models)])];
  }
  private emit() {
    this.state.revision++;
    this.publish(structuredClone(this.state));
  }
  async handle(action: GlobalSettingsAction) {
    const run = this.queue.then(async () => {
      if (action.generation !== this.state.generation) throw new Error('全局设置已重新加载。');
      const signal = new AbortController().signal;
      if (action.type === 'read') {
        const record = this.records.find((r) => r.id === action.sectionId);
        if (!record) throw new Error('不支持的全局设置。');
        this.editor = undefined;
        const value = await record.section.read?.(signal, 'global');
        const id = randomUUID();
        this.editor = { id, section: record.section };
        this.state.settingsEditor = {
          id,
          sectionId: record.id,
          scope: 'global',
          value: safeSettingsValue(value),
          effectiveValue: safeSettingsValue(await record.section.readEffective?.(signal, 'global')),
        };
        const meta = this.state.settings.find((s) => s.id === record.id)!;
        meta.schema = record.section.getSchema?.() ?? record.section.schema;
        meta.scopes = (record.section.scopeTargets ?? []).filter(
          (t) => t.scope === 'global',
        ) as typeof meta.scopes;
      } else {
        const editor = this.editor,
          view = this.state.settingsEditor;
        if (
          !editor ||
          !view ||
          editor.id !== action.editorId ||
          !editor.section.draft ||
          !editor.section.commit
        )
          throw new Error('全局设置草稿已过期。');
        view.error = undefined;
        view.saved = false;
        view.feedbackRevision = (view.feedbackRevision ?? 0) + 1;
        try {
          const draft = await editor.section.draft(JSON.parse(action.json), signal, 'global');
          await editor.section.commit(draft, signal, 'global');
          view.value = safeSettingsValue(await editor.section.read?.(signal, 'global'));
          view.effectiveValue = safeSettingsValue(
            await editor.section.readEffective?.(signal, 'global'),
          );
          editor.id = view.id = randomUUID();
          view.saved = true;
        } catch (error) {
          view.error = settingsErrorMessage(error);
        }
      }
      this.refresh();
      this.emit();
    });
    this.queue = run.catch(() => {});
    await run;
  }
}
