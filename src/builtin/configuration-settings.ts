/** 面向各前端的配置编辑器；只提交固定配置层，绝不接受调用者提供的写入路径。 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AgentConfigSchema, loadConfigWithSources } from '../core/config.js';
import type { Plugin, SettingsScope, SettingsSection } from '../sdk/index.js';
import { createScopedConfigStores, type ConfigSnapshot } from '../runtime/config-store.js';
import { validatePermissionRule } from './policy/config.js';

type Shape = Record<string, z.ZodTypeAny>;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const sensitive = /(?:^|_)(?:api_?key|token|password|secret|authorization|cookie|headers|env)$/i;
export const MASKED_SETTING = '••••••••';

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  while (true) {
    if (schema instanceof z.ZodDefault) schema = schema._def.innerType;
    else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
      schema = schema.unwrap();
    else if (schema instanceof z.ZodEffects) schema = schema.innerType();
    else return schema;
  }
}
/** 提供纯 JSON 元数据；运行时校验仍由原始 schema 执行。 */
export function settingsJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodDefault) return settingsJsonSchema(schema._def.innerType);
  if (schema instanceof z.ZodOptional) return settingsJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodNullable)
    return { anyOf: [settingsJsonSchema(schema.unwrap()), { type: 'null' }] };
  if (schema instanceof z.ZodEffects) return settingsJsonSchema(schema.innerType());
  const value = unwrap(schema);
  if (value instanceof z.ZodObject)
    return {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(value.shape as Shape).map(([key, child]) => [
          key,
          settingsJsonSchema(child),
        ]),
      ),
      additionalProperties: false,
      required: Object.entries(value.shape as Shape)
        .filter(([, s]) => !s.isOptional())
        .map(([key]) => key),
    };
  if (value instanceof z.ZodEnum) return { type: 'string', enum: value.options };
  if (value instanceof z.ZodLiteral) return { const: value.value, type: typeof value.value };
  if (value instanceof z.ZodBoolean) return { type: 'boolean' };
  if (value instanceof z.ZodNumber)
    return {
      type: value.isInt ? 'integer' : 'number',
      ...(value.minValue !== null
        ? {
            minimum:
              value.isInt && value._def.checks.some((c) => c.kind === 'min' && !c.inclusive)
                ? Math.floor(value.minValue) + 1
                : value.minValue,
          }
        : {}),
      ...(value.maxValue !== null ? { maximum: value.maxValue } : {}),
    };
  if (value instanceof z.ZodString)
    return {
      type: 'string',
      ...(value.minLength !== null ? { minLength: value.minLength } : {}),
      ...(value.maxLength !== null ? { maxLength: value.maxLength } : {}),
    };
  if (value instanceof z.ZodArray)
    return { type: 'array', items: settingsJsonSchema(value.element) };
  if (value instanceof z.ZodRecord)
    return { type: 'object', additionalProperties: settingsJsonSchema(value.valueSchema) };
  if (value instanceof z.ZodUnion || value instanceof z.ZodDiscriminatedUnion)
    return {
      anyOf: (value.options as z.ZodTypeAny[]).map((s) => ({
        ...settingsJsonSchema(s),
        ...(s.description ? { title: s.description } : {}),
      })),
    };
  return { 'x-any': true };
}
export function safeSettingsValue(value: unknown, key = ''): unknown {
  if (record(value) && Object.keys(value).length === 1 && typeof value.$secret === 'string')
    return { $secret: value.$secret };
  if ((key === 'env' || key === 'headers') && record(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        record(item) && typeof item.$secret === 'string'
          ? { $secret: item.$secret }
          : MASKED_SETTING,
      ]),
    );
  if (sensitive.test(key) && key !== 'apiKeyEnv') return MASKED_SETTING;
  if (key === 'apiKeyEnv' && (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)))
    return MASKED_SETTING;
  if (typeof value === 'string' && /^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password || url.search || url.hash) return MASKED_SETTING;
    } catch {
      return MASKED_SETTING;
    }
  }
  if (Array.isArray(value)) return value.map((item) => safeSettingsValue(item));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !dangerous.has(key))
        .map(([key, item]) => [key, safeSettingsValue(item, key)]),
    );
  return value;
}
function projectKnown(
  value: Record<string, unknown>,
  shape: Shape,
  identities?: Map<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(shape)
      .filter(([key]) => Object.hasOwn(value, key))
      .map(([key, schema]) => [key, projectSchema(value[key], schema, key, identities)]),
  );
}
function projectSchema(
  value: unknown,
  schema: z.ZodTypeAny,
  key = '',
  identities?: Map<string, unknown>,
  identify = false,
): unknown {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject && record(value)) {
    const projected = projectKnown(value, inner.shape as Shape, identities);
    if (identify && identities) {
      const id = randomUUID();
      identities.set(id, value);
      return { ...projected, $entry: id };
    }
    return projected;
  }
  if (inner instanceof z.ZodRecord && record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !dangerous.has(name))
        .map(([name, item]) => [
          name,
          projectSchema(item, inner.valueSchema, name, identities, true),
        ]),
    );
  if (inner instanceof z.ZodArray && Array.isArray(value))
    return value.map((item) => projectSchema(item, inner.element, '', identities, true));
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    const selected = (inner.options as z.ZodTypeAny[]).find(
      (option) => option.safeParse(value).success,
    );
    if (selected) return projectSchema(value, selected, key, identities, identify);
  }
  return safeSettingsValue(value, key);
}
/** 只删除 schema 拥有的字段；未识别的嵌套字段也必须留下。 */
function preserveUnknown(
  previous: unknown,
  next: unknown,
  schema: z.ZodTypeAny,
  identities?: WeakMap<object, unknown>,
): unknown {
  if (record(next) && identities?.has(next)) previous = identities.get(next);
  if (next === MASKED_SETTING) return previous;
  const inner = unwrap(schema);
  if (inner instanceof z.ZodRecord && record(next))
    return Object.fromEntries(
      Object.entries(next).map(([key, item]) => [
        key,
        preserveUnknown(
          record(previous) ? previous[key] : undefined,
          item,
          inner.valueSchema,
          identities,
        ),
      ]),
    );
  if (inner instanceof z.ZodArray && Array.isArray(next))
    return next.map((item, index) => {
      // 插件入口重排时，未知元数据必须跟随同一 entry，不能附到另一个插件上。
      const old = Array.isArray(previous)
        ? record(item) && typeof item.entry === 'string'
          ? previous.find((candidate) => record(candidate) && candidate.entry === item.entry)
          : previous[index]
        : undefined;
      return preserveUnknown(old, item, inner.element, identities);
    });
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    const selected = (inner.options as z.ZodTypeAny[]).find(
      (option) => option.safeParse(next).success,
    );
    if (selected) return preserveUnknown(previous, next, selected, identities);
  }
  if (!(inner instanceof z.ZodObject) || !record(previous)) return restoreMasked(previous, next);
  const result = { ...previous };
  for (const [key, child] of Object.entries(inner.shape as Shape)) {
    if (record(next) && Object.hasOwn(next, key))
      result[key] = preserveUnknown(previous[key], next[key], child, identities);
    else {
      const unknown = preserveUnknown(previous[key], undefined, child, identities);
      if (record(unknown) && Object.keys(unknown).length) result[key] = unknown;
      else delete result[key];
    }
  }
  return next === undefined && Object.keys(result).length === 0 ? undefined : result;
}
function restoreMasked(previous: unknown, next: unknown): unknown {
  if (next === MASKED_SETTING) return previous;
  if (Array.isArray(next))
    return next.map((item, index) =>
      restoreMasked(Array.isArray(previous) ? previous[index] : undefined, item),
    );
  if (record(next))
    return Object.fromEntries(
      Object.entries(next).map(([key, item]) => [
        key,
        restoreMasked(record(previous) ? previous[key] : undefined, item),
      ]),
    );
  return next;
}
function assertSafeInput(value: unknown, key = ''): void {
  if (value === MASKED_SETTING) return;
  if (
    sensitive.test(key) &&
    key !== 'apiKeyEnv' &&
    value !== undefined &&
    (typeof value !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value))
  )
    throw new Error('敏感字段只接受环境变量引用。');
  if (record(value))
    for (const [key, item] of Object.entries(value)) {
      if (dangerous.has(key)) throw new Error('不允许此配置字段。');
      assertSafeInput(item, key);
    }
  if (Array.isArray(value)) value.forEach((item) => assertSafeInput(item));
}
function assertKnownFields(value: unknown, schema: z.ZodTypeAny): void {
  if (value === MASKED_SETTING) return;
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject && record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(inner.shape, key)) throw new Error('未知配置字段。');
      assertKnownFields(item, inner.shape[key]);
    }
  } else if (inner instanceof z.ZodArray && Array.isArray(value)) {
    value.forEach((item) => assertKnownFields(item, inner.element));
  } else if (inner instanceof z.ZodRecord && record(value)) {
    Object.values(value).forEach((item) => assertKnownFields(item, inner.valueSchema));
  } else if (inner instanceof z.ZodUnion || inner instanceof z.ZodDiscriminatedUnion) {
    const selected = (inner.options as z.ZodTypeAny[]).find(
      (option) => option.safeParse(value).success,
    );
    if (selected) assertKnownFields(value, selected);
  }
}

const baseGroups = [
  [
    'connection',
    '主任务与模型连接（启动默认值）',
    ['provider', 'model', 'baseURL', 'apiKeyEnv', 'thinking', 'judgeModel'],
  ],
  ['budgets', '上下文与缓存预算', ['maxTurns', 'compactThreshold', 'cache']],
  ['permissions', '权限与审批默认值', ['permissionMode', 'permissions']],
  ['files', '配置文件与插件装配', ['modelsFile', 'mcpConfig', 'pluginEntries', 'disabledPlugins']],
] as const;

export function configurationSections(
  cwd: string,
  plugins: readonly Plugin[] = [],
): Array<{ id: string; section: SettingsSection }> {
  const stores = createScopedConfigStores(cwd);
  const result: Array<{ id: string; section: SettingsSection }> = [];
  const add = (id: string, title: string, shape: Shape, plugin?: Plugin) => {
    const fields = Object.keys(shape);
    const definition = plugin?.config;
    const bases = new Map<SettingsScope, ConfigSnapshot>();
    const entryTokens = new WeakMap<ConfigSnapshot, Map<string, unknown>>();
    const drafts = new WeakMap<
      object,
      { base: ConfigSnapshot; scope: SettingsScope; patch: Record<string, unknown> }
    >();
    const targets = stores.scopeTargets.filter(
      (target) => !definition?.scopes || definition.scopes.includes(target.scope),
    );
    const section: SettingsSection = {
      title,
      order: 20 + result.length,
      applyMode: 'newSession',
      description:
        '只编辑所选层的原始覆盖值，省略字段恢复继承。Enter 一次提交；Esc 放弃未提交草稿。保存后需重启 App/CLI，已有会话与审批不改变。密钥仅使用环境变量引用，不读取 .env。',
      schema: settingsJsonSchema(z.object(shape)),
      scopeTargets: targets,
      readEffective(signal) {
        signal.throwIfAborted();
        const config = loadConfigWithSources(cwd).config;
        const raw = plugin ? (config.pluginConfig[plugin.manifest.id] ?? {}) : config;
        const parsed = definition?.schema
          ? definition.schema.parse({ ...definition.defaults, ...raw })
          : raw;
        const value = projectKnown(parsed as Record<string, unknown>, shape);
        for (const key of definition?.sensitiveFields ?? [])
          if (Object.hasOwn(value, key)) value[key] = MASKED_SETTING;
        return value;
      },
      read(signal, scope = 'project') {
        signal.throwIfAborted();
        if (!targets.some((target) => target.scope === scope)) throw new Error('不支持此作用域。');
        const store = stores.store(scope);
        const base = plugin ? store.read(plugin.manifest.id) : store.readFields(fields);
        bases.set(scope, base);
        const tokens = new Map<string, unknown>();
        entryTokens.set(base, tokens);
        const value = projectKnown(base.value, shape, tokens);
        for (const key of definition?.sensitiveFields ?? [])
          if (Object.hasOwn(value, key)) value[key] = MASKED_SETTING;
        return value;
      },
      draft(value, signal, scope = 'project') {
        signal.throwIfAborted();
        const base = bases.get(scope);
        if (!base || !targets.some((target) => target.scope === scope))
          throw new Error('请重新打开此作用域设置。');
        if (!record(value) || Object.keys(value).some((key) => !fields.includes(key)))
          throw new Error('未知配置字段。');
        const identities = new WeakMap<object, unknown>(),
          tokens = entryTokens.get(base);
        const normalize = (item: unknown): unknown => {
          if (Array.isArray(item)) return item.map(normalize);
          if (record(item)) {
            const next = Object.fromEntries(
              Object.entries(item)
                .filter(
                  ([key]) =>
                    key !== '$entry' ||
                    typeof item.$entry !== 'string' ||
                    !tokens?.has(item.$entry),
                )
                .map(([key, v]) => [key, normalize(v)]),
            );
            if (typeof item.$entry === 'string' && tokens?.has(item.$entry))
              identities.set(next, tokens.get(item.$entry));
            return next;
          }
          return item;
        };
        const input = normalize(value) as Record<string, unknown>;
        assertSafeInput(input);
        for (const [key, item] of Object.entries(input)) assertKnownFields(item, shape[key]);
        for (const key of definition?.sensitiveFields ?? []) {
          const item = input[key];
          if (
            item !== undefined &&
            item !== MASKED_SETTING &&
            (typeof item !== 'string' || !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(item))
          )
            throw new Error('敏感字段只接受环境变量引用。');
        }
        const patch = Object.fromEntries(
          fields.map((key) => [
            key,
            preserveUnknown(base.value[key], input[key], shape[key], identities),
          ]),
        );
        // 校验完整有效值，但不保存 parse() 补齐的默认值。
        const present = Object.fromEntries(
          Object.entries(patch).filter(([, item]) => item !== undefined),
        );
        if (scope === 'global' || scope === 'project')
          definition?.validateSettings?.(present, scope);
        z.object(shape).partial().parse(present);
        const other = stores.store('global');
        const otherValue =
          scope === 'global'
            ? {}
            : plugin
              ? other.read(plugin.manifest.id).value
              : other.readFields(fields).value;
        const merged = { ...otherValue, ...present };
        if (definition?.schema) definition.schema.parse({ ...definition.defaults, ...merged });
        else AgentConfigSchema.parse(merged);
        for (const [key, item] of Object.entries(patch)) {
          if (item === undefined) continue;
          if (input[key] === MASKED_SETTING) continue;
          if (
            key === 'apiKeyEnv' &&
            (typeof item !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item))
          )
            throw new Error('apiKeyEnv 必须是环境变量名。');
          if (key === 'baseURL') {
            const url = new URL(String(item));
            if (
              !['http:', 'https:'].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            )
              throw new Error('端点必须是无凭据或查询参数的 HTTP(S) URL。');
          }
          if (
            (key === 'model' || key === 'provider') &&
            (typeof item !== 'string' || !item.trim() || /\s|[\u0000-\u001f]/u.test(item))
          )
            throw new Error('模型和 provider 必须是非空 ID。');
          if (key === 'permissions' && record(item))
            for (const kind of ['allow', 'ask', 'deny']) {
              const rules = item[kind];
              if (Array.isArray(rules))
                for (const rule of rules)
                  if (typeof rule !== 'string' || validatePermissionRule(rule))
                    throw new Error('权限规则无效。');
            }
        }
        const draft = Object.freeze({ valid: true });
        drafts.set(draft, { base, scope, patch: structuredClone(patch) });
        return draft;
      },
      commit(draft, signal, scope = 'project') {
        signal.throwIfAborted();
        const saved = record(draft) ? drafts.get(draft) : undefined;
        if (!saved || saved.scope !== scope) throw new Error('草稿作用域不匹配或已经提交。');
        const store = stores.store(scope);
        const next = plugin
          ? store.commit(plugin.manifest.id, saved.base, saved.patch, {
              ownedFields: fields,
              sensitiveFields: definition?.sensitiveFields,
            })
          : store.commitFields(saved.base, saved.patch);
        drafts.delete(draft as object);
        bases.set(scope, next);
      },
    };
    const properties = section.schema.properties as Record<string, Record<string, unknown>>;
    if (id === 'configuration-permissions') {
      const rules = (
        properties.permissions as { properties: Record<string, { items: Record<string, unknown> }> }
      ).properties;
      for (const kind of ['allow', 'ask', 'deny']) rules[kind].items['x-rule'] = true;
    }
    for (const key of definition?.sensitiveFields ?? [])
      if (properties[key]) properties[key].writeOnly = true;
    result.push({ id, section });
  };
  for (const [id, title, fields] of baseGroups)
    add(
      `configuration-${id}`,
      title,
      Object.fromEntries(fields.map((key) => [key, AgentConfigSchema.shape[key]])),
    );
  const grouped = new Set<string>([
    ...baseGroups.flatMap(([, , fields]) => [...fields]),
    'capabilities',
    'pluginConfig',
  ]);
  const additional = Object.fromEntries(
    Object.entries(AgentConfigSchema.shape).filter(([key]) => !grouped.has(key)),
  );
  if (Object.keys(additional).length) add('configuration-additional', '其他运行配置', additional);
  for (const plugin of plugins) {
    // 目录授权有额外的真实路径验证，必须使用策略插件原有的受控设置入口。
    if (plugin.manifest.id === 'agentlab.policy') continue;
    if (!plugin.config?.ownedFields?.length || !plugin.config.schema) continue;
    const schema = plugin.config.schema;
    const inner = schema instanceof z.ZodType ? unwrap(schema) : undefined;
    const shape: Shape = Object.fromEntries(
      plugin.config.ownedFields.map((key) => [
        key,
        inner instanceof z.ZodObject ? (inner.shape[key] ?? z.unknown()) : z.unknown(),
      ]),
    );
    const titles: Record<string, string> = {
      'agentlab.provider-openai': 'OpenAI 兼容协议',
      'agentlab.provider-anthropic': 'Anthropic 模型能力',
      'agentlab.provider-connections': 'Provider 连接',
      'agentlab.local-tools': '本地工具',
      'agentlab.mcp': 'MCP 结果预算',
      'agentlab.reviewer-model': '审批模型与预算',
      'agentlab.telemetry-jsonl': '会话日志',
      'agentlab.subagents': '辅助任务与并发',
      'agentlab.planning': '主任务规划',
      'agentlab.compaction-summary': '摘要模型与预算',
    };
    add(
      `configuration-${plugin.manifest.id}`,
      titles[plugin.manifest.id] ?? `插件参数 · ${plugin.manifest.id}`,
      shape,
      plugin,
    );
  }
  return result;
}
