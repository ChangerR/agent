/** 模型目录图形设置；只写配置层注册的受管 JSON 文件，不接收 renderer 路径。 */
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ModelInfoSchema, loadConfigWithSources, loadModelsFile } from '../core/config.js';
import { resolveAgentPaths } from '../core/paths.js';
import {
  PluginConfigStore,
  createScopedConfigStores,
  type ConfigSnapshot,
} from '../runtime/config-store.js';
import type { SettingsScope, SettingsSection } from '../sdk/index.js';
import { MODEL_PRESETS } from './model-catalog/index.js';
import { settingsJsonSchema } from './configuration-settings.js';
import { assertManagedSettingsPath, commitSettingsReference } from './settings-paths.js';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fields = ['displayName', 'contextWindow', 'maxOutputTokens'];
export function modelSettingsSection(cwd: string): SettingsSection {
  const paths = resolveAgentPaths(cwd),
    loaded = loadConfigWithSources(cwd);
  const references = createScopedConfigStores(cwd);
  const target = (scope: SettingsScope) => {
    if (scope !== 'project' && scope !== 'global') throw new Error('不支持此作用域。');
    const root = scope === 'project' ? paths.projectRoot : paths.agentHome;
    const raw = loadConfigWithSources(cwd).layers[scope].modelsFile;
    return { root, path: resolve(root, typeof raw === 'string' ? raw : 'models.json') };
  };
  const store = (scope: SettingsScope) => {
    const t = target(scope),
      r = relative(t.root, t.path);
    if (
      isAbsolute(r) ||
      r === '..' ||
      r.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    )
      throw new Error(
        '模型文件必须位于当前项目或用户配置目录；可在图形路径设置中改为受管位置后重启。',
      );
    assertManagedSettingsPath(t.root, t.path);
    return new PluginConfigStore(t.path);
  };
  const bases = new Map<
    SettingsScope,
    {
      base: ConfigSnapshot;
      reference: ConfigSnapshot;
      entries: Map<string, Record<string, unknown>>;
    }
  >();
  const drafts = new WeakMap<
    object,
    {
      scope: SettingsScope;
      base: ConfigSnapshot;
      reference: ConfigSnapshot;
      value: Record<string, unknown>;
    }
  >();
  return {
    title: '模型目录',
    order: 10,
    applyMode: 'newSession',
    description: `增删模型、修改 ID / 显示名 / 上下文和输出能力。模型能力协议在对应 Provider 页编辑。删除自定义覆盖会恢复内置同名模型。当前运行目录引用：${loaded.config.modelsFile}。明确提交此页同时将所选层 modelsFile 指向此目录，重启采用；打开或取消不会写入。`,
    schema: {
      type: 'object',
      properties: {
        catalog: { type: 'object', additionalProperties: settingsJsonSchema(ModelInfoSchema) },
      },
    },
    get scopeTargets() {
      return (['project', 'global'] as const).map((scope) => ({ scope, path: target(scope).path }));
    },
    read(signal, scope = 'project') {
      signal.throwIfAborted();
      const base = store(scope).readDocument(),
        entries = new Map<string, Record<string, unknown>>();
      const catalog = Object.fromEntries(
        Object.entries(base.value).map(([key, item]) => {
          if (!record(item)) throw new Error('模型规格必须为对象。');
          const id = randomUUID();
          entries.set(id, item);
          return [
            key,
            {
              $entry: id,
              ...Object.fromEntries(
                fields.filter((k) => Object.hasOwn(item, k)).map((k) => [k, item[k]]),
              ),
            },
          ];
        }),
      );
      bases.set(scope, {
        base,
        reference: references.store(scope).readFields(['modelsFile']),
        entries,
      });
      return { catalog };
    },
    readEffective(signal) {
      signal.throwIfAborted();
      const current = loadConfigWithSources(cwd).config;
      return { catalog: { ...MODEL_PRESETS, ...loadModelsFile(current.modelsFile) } };
    },
    draft(raw, signal, scope = 'project') {
      signal.throwIfAborted();
      const state = bases.get(scope);
      if (
        !state ||
        !record(raw) ||
        Object.keys(raw).some((k) => k !== 'catalog') ||
        (raw.catalog !== undefined && !record(raw.catalog))
      )
        throw new Error('无效模型目录草稿。');
      const value = Object.fromEntries(
        Object.entries((raw.catalog ?? {}) as Record<string, unknown>).map(([name, item]) => {
          if (
            !name.trim() ||
            /[\u0000-\u001f]/.test(name) ||
            ['__proto__', 'prototype', 'constructor'].includes(name) ||
            !record(item) ||
            Object.keys(item).some((k) => !fields.includes(k) && k !== '$entry')
          )
            throw new Error('无效模型 ID 或字段。');
          if (
            item.$entry !== undefined &&
            (typeof item.$entry !== 'string' || !state.entries.has(item.$entry))
          )
            throw new Error('模型草稿已过期。');
          const result = {
            ...(typeof item.$entry === 'string'
              ? state.entries.get(item.$entry)
              : record(state.base.value[name])
                ? state.base.value[name]
                : {}),
          };
          for (const field of fields) {
            if (Object.hasOwn(item, field)) result[field] = item[field];
            else delete result[field];
          }
          ModelInfoSchema.parse(result);
          return [name, result];
        }),
      );
      const draft = Object.freeze({});
      drafts.set(draft, { scope, base: state.base, reference: state.reference, value });
      return draft;
    },
    commit(draft, signal, scope = 'project') {
      signal.throwIfAborted();
      const saved = record(draft) ? drafts.get(draft) : undefined;
      if (!saved || saved.scope !== scope) throw new Error('模型草稿已失效。');
      const targetStore = store(scope),
        active =
          scope === 'project' ? loadConfigWithSources(cwd).config.modelsFile : target(scope).path;
      commitSettingsReference(
        references.store(scope),
        saved.reference,
        'modelsFile',
        targetStore.path,
        active !== targetStore.path,
        () => targetStore.commitDocument(saved.base, saved.value),
        (written) => {
          targetStore.commitDocument(written, saved.base.value as Record<string, unknown>);
        },
      );
      drafts.delete(draft as object);
    },
  };
}
