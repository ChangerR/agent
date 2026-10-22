import { useEffect, useId, useRef, useState } from 'react';
import type { RuntimeSnapshot, SettingsSnapshot } from '../shared/protocol.js';
import { getBridge } from './bridge.js';

export type FormSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, FormSchema>;
  required?: string[];
  additionalProperties?: boolean | FormSchema;
  items?: FormSchema;
  anyOf?: FormSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  writeOnly?: boolean;
  'x-any'?: boolean;
  'x-rule'?: boolean;
};
export const labels: Record<string, string> = {
  provider: 'Provider',
  connections: '命名连接',
  type: '适配器类型',
  model: '模型 ID',
  displayName: '显示名称',
  contextWindow: '上下文窗口（tokens）',
  maxOutputTokens: '输出 token 上限',
  baseURL: 'Endpoint URL',
  apiKeyEnv: '高级：API key 环境变量名（可选）',
  apiKeyRef: '安全存储引用（由保存 API key 管理）',
  thinking: '思考等级',
  judgeModel: '审批模型（空值跟随主模型）',
  models: '模型 API 能力',
  maxTurns: '最大轮数',
  compactThreshold: '上下文压缩阈值（tokens）',
  cache: '缓存',
  enabled: '启用',
  ttl: 'TTL',
  staticTtl: '静态前缀 TTL（省略时继承会话 TTL）',
  ttlStrategy: '缓存 TTL 策略',
  escalateAfterMs: '升级到 1h 的工具耗时阈值（毫秒；0 关闭）',
  replayToolArguments: '原始工具参数回放（默认关闭）',
  strategy: '摘要策略（prefix 需显式开启）',
  permissionMode: '权限模式',
  permissions: '权限规则',
  allow: 'Allow 规则',
  ask: 'Ask 规则',
  deny: 'Deny 规则',
  modelsFile: '模型规格文件',
  mcpConfig: 'MCP 配置文件',
  pluginEntries: '插件入口',
  disabledPlugins: '禁用的插件',
  entry: '模块入口',
  timeoutMs: '超时（毫秒）',
  maxRequestBytes: '请求字节上限',
  maxResponseBytes: '响应字节上限',
  prefixCache: '审批请求前缀缓存',
  maxInlineChars: 'MCP 结果内联字符上限',
  maxAgeDays: 'MCP 结果保留天数（0 关闭）',
  maxStoredBytes: 'MCP 结果存储软上限（字节；0 关闭）',
  deduplicate: 'MCP 结果去重（默认关闭）',
  maxSearchChars: 'MCP 单次检索字符上限',
  maxRunning: '并行子任务上限',
  maxDepth: '子任务深度',
  maxInbox: '收件箱上限',
  maxOutputChars: '子任务输出字符上限',
  previewChars: '预览字符上限',
  maxAgents: '子任务数量上限',
  maxRuns: '子任务运行次数上限',
  mode: '规划方式',
  disabled: '禁用的工具',
  dialect: '兼容协议',
  includeBodies: '记录消息正文（可能包含敏感内容）',
  writeRoots: '明确授权的写入目录',
  api: 'API 类型',
  thinkingLevels: '支持的思考等级',
  rawToolArguments: '支持原始参数回放',
  prefixCompaction: '支持前缀摘要',
  outputParameter: '输出预算参数',
  thinkingMode: '思考协议',
  offEffort: '关闭思考值',
  mcpServers: 'MCP 服务器',
  command: '启动程序',
  args: '命令参数',
  env: '环境变量',
  headers: '请求头',
  url: '服务器 URL',
  variables: '项目环境变量',
  catalog: '模型目录',
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const secret = (v: unknown) => v === '••••••••' || (record(v) && typeof v.$secret === 'string');
let rowId = 0;
export function initial(s: FormSchema): unknown {
  if (s['x-rule']) return 'read_file(="")';
  if (s.const !== undefined) return s.const;
  if (s.anyOf) return initial(s.anyOf[0]);
  if (s.enum) return s.enum[0];
  if (s.type === 'object')
    return Object.fromEntries((s.required ?? []).map((k) => [k, initial(s.properties?.[k] ?? {})]));
  if (s.type === 'array') return [];
  if (s.type === 'boolean') return false;
  if (s.type === 'null') return null;
  if (s.type === 'number' || s.type === 'integer') return s.minimum ?? 1;
  return '';
}
function matches(s: FormSchema, v: unknown): boolean {
  if (s.type === 'null') return v === null;
  if (s.const !== undefined) return v === s.const;
  if (s.type === 'object')
    return (
      record(v) &&
      (s.required ?? []).every((k) => Object.hasOwn(v, k)) &&
      Object.entries(s.properties ?? {}).every(
        ([key, child]) => child.const === undefined || v[key] === child.const,
      )
    );
  if (s.type === 'array') return Array.isArray(v);
  if (s.type === 'integer' || s.type === 'number') return typeof v === 'number';
  return typeof v === s.type;
}
export function ValueView({ value }: { value: unknown }) {
  if (secret(value)) return <span className="secret-status">已设置 · 内容不返回界面</span>;
  if (Array.isArray(value))
    return value.length ? (
      <ol className="value-list">
        {value.map((v, i) => (
          <li key={i}>
            <ValueView value={v} />
          </li>
        ))}
      </ol>
    ) : (
      <span>空列表</span>
    );
  if (record(value))
    return (
      <dl className="value-record">
        {Object.entries(value).map(([k, v]) => (
          <div key={k}>
            <dt>{labels[k] ?? k}</dt>
            <dd>
              <ValueView value={v} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{value === undefined ? '未设置' : value === null ? '空值' : String(value)}</span>;
}
function SecretInput({
  value,
  label,
  onChange,
}: {
  value: unknown;
  label: string;
  onChange: (v: unknown) => void;
}) {
  const [editing, setEditing] = useState(!secret(value));
  const original = useRef(value);
  useEffect(() => {
    if (secret(value)) {
      original.current = value;
      setEditing(false);
    }
  }, [JSON.stringify(value)]);
  return (
    <div className="secret-field">
      {secret(value) && <span className="secret-status">已设置 · 保留原值</span>}
      {!editing ? (
        <button type="button" onClick={() => setEditing(true)}>
          替换 {label}
        </button>
      ) : (
        <input
          aria-label={label}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={secret(value) ? '' : String(value ?? '')}
          placeholder="输入新值，不读取已保存内容"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <button type="button" onClick={() => onChange(undefined)}>
        清除 {label}
      </button>
      {editing && secret(original.current) && (
        <button
          type="button"
          onClick={() => {
            onChange(original.current);
            setEditing(false);
          }}
        >
          保留已设置的 {label}
        </button>
      )}
    </div>
  );
}
type Props = {
  name: string;
  schema: FormSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  runtime?: RuntimeSnapshot | SettingsSnapshot;
  effective?: unknown;
};
function RuleInput({ value, onChange, name, runtime }: Props) {
  const raw = String(value ?? ''),
    match = /^([a-zA-Z0-9_:*-]+)(?:\((.*)\))?$/s.exec(raw.trim());
  let tool = match?.[1] ?? runtime?.tools[0]?.name ?? 'read_file',
    kind = 'all',
    target = '';
  if (match?.[2] !== undefined) {
    kind = match[2].startsWith('="') ? 'exact' : 'pattern';
    try {
      target = kind === 'exact' ? JSON.parse(match[2].slice(1)) : match[2];
    } catch {
      target = match[2];
    }
  }
  const set = (t: string, k: string, v: string) =>
    onChange(k === 'all' ? t : k === 'exact' ? `${t}(=${JSON.stringify(v)})` : `${t}(${v})`);
  return (
    <div className="rule-editor">
      <label>
        工具
        <select
          aria-label={`${name} 工具`}
          value={tool}
          onChange={(e) => set(e.target.value, kind, target)}
        >
          {[...new Set([tool, ...(runtime?.tools ?? []).map((t) => t.name)])].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        匹配方式
        <select
          aria-label={`${name} 匹配方式`}
          value={kind}
          onChange={(e) => set(tool, e.target.value, target)}
        >
          <option value="exact">精确目标</option>
          <option value="pattern">Glob 模式</option>
          <option value="all">全部调用（明确选择）</option>
        </select>
      </label>
      {kind !== 'all' && (
        <label>
          目标
          <input
            aria-label={`${name} 目标`}
            required
            value={target}
            onChange={(e) => set(tool, kind, e.target.value)}
          />
        </label>
      )}
      <small>仍执行后端危险检测、deny/ask 优先及实际工具审批。</small>
    </div>
  );
}
function MapInput({ schema, value, onChange, name, runtime, effective }: Props) {
  type Row = { id: number; key: string; value: unknown };
  const from = () =>
    Object.entries(record(value) ? value : {}).map(([key, value]) => ({ id: ++rowId, key, value }));
  const [rows, setRows] = useState<Row[]>(from),
    emitted = useRef(JSON.stringify(value));
  const [active, setActive] = useState<number>();
  const masterDetail = ['catalog', 'connections', 'mcpServers', 'models'].includes(name);
  useEffect(() => {
    if (JSON.stringify(value) !== emitted.current) {
      const key = rows.find((row) => row.id === active)?.key;
      const next = from();
      setRows(next);
      setActive(next.find((row) => row.key === key)?.id ?? next[0]?.id);
      emitted.current = JSON.stringify(value);
    }
  }, [JSON.stringify(value)]);
  const item =
    typeof schema.additionalProperties === 'object'
      ? schema.additionalProperties
      : { 'x-any': true };
  const change = (next: Row[]) => {
    setRows(next);
    const object = Object.fromEntries(next.map((r) => [r.key, r.value]));
    emitted.current = JSON.stringify(object);
    onChange(object);
  };
  const label = labels[name] ?? name;
  const invalidKey = (row: Row, index: number) =>
    !row.key.trim() ||
    ['__proto__', 'prototype', 'constructor'].includes(row.key) ||
    rows.some((r, i) => i !== index && r.key === row.key);
  const selected = rows.some((r) => r.id === active) ? active : rows[0]?.id;
  const showAll = rows.some(invalidKey);
  return (
    <fieldset
      className={'map-editor ' + (masterDetail ? 'record-workspace' : '')}
      aria-label={label}
    >
      <legend>{label}</legend>
      {masterDetail && (
        <div className="record-list" aria-label={label + ' 列表'}>
          <div className="record-list-heading">
            <span>{rows.length} 项自定义配置</span>
          </div>
          {rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              aria-pressed={selected === row.id}
              onClick={() => setActive(row.id)}
            >
              <span className="record-mark">
                {name === 'catalog' || name === 'models' ? 'M' : name === 'connections' ? 'P' : '↗'}
              </span>
              <span>
                <strong>
                  {record(row.value) && typeof row.value.displayName === 'string'
                    ? row.value.displayName
                    : row.key || '未命名 ' + (index + 1)}
                </strong>
                <small>
                  {row.key || '填写唯一 ID'}
                  {record(row.value) && typeof row.value.type === 'string'
                    ? ' · ' + row.value.type
                    : ''}
                </small>
              </span>
            </button>
          ))}
          {!rows.length && (
            <p className="empty-settings">
              尚未添加。新增自定义项后在右侧编辑；打开本页不会写入默认值。
            </p>
          )}
        </div>
      )}
      <div className="record-details">
        {rows.map((row, index) => {
          const invalid = invalidKey(row, index);
          if (masterDetail && !showAll && row.id !== selected) return null;
          return (
            <div className="map-row" key={row.id}>
              <label>
                {name === 'catalog' || name === 'models'
                  ? '模型 ID'
                  : name === 'connections'
                    ? '连接 ID'
                    : '名称'}
                <input
                  aria-label={`${label} 名称 ${index + 1}`}
                  required
                  value={row.key}
                  aria-invalid={invalid}
                  ref={(node) => {
                    node?.setCustomValidity(invalid ? '名称不能为空、重复或使用保留名称' : '');
                  }}
                  onChange={(e) => {
                    e.currentTarget.setCustomValidity(
                      !e.target.value.trim() ||
                        rows.some((r, i) => i !== index && r.key === e.target.value)
                        ? '名称不能为空或重复'
                        : '',
                    );
                    change(rows.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)));
                  }}
                />
              </label>
              {invalid && <span role="alert">名称不能为空、重复或使用保留名称</span>}
              <Field
                name={`${name} · ${row.key || index + 1}`}
                effective={record(effective) ? effective[row.key] : undefined}
                schema={item}
                value={row.value}
                runtime={runtime}
                onChange={(v) =>
                  change(
                    v === undefined
                      ? rows.filter((r) => r.id !== row.id)
                      : rows.map((r) => (r.id === row.id ? { ...r, value: v } : r)),
                  )
                }
              />
              <button
                type="button"
                aria-label={`删除 ${label} ${row.key || index + 1}`}
                onClick={() => change(rows.filter((r) => r.id !== row.id))}
              >
                删除
              </button>
            </div>
          );
        })}
        {masterDetail && !rows.length && (
          <div className="settings-empty-detail">
            <strong>{label}</strong>
            <p>在这里管理你的自定义配置</p>
            <span>保留继承值，按需创建覆盖。</span>
          </div>
        )}
      </div>
      <button
        type="button"
        className="add-record"
        onClick={() => {
          const id = ++rowId;
          setActive(id);
          change([...rows, { id, key: '', value: initial(item) }]);
        }}
      >
        新增 {label}
      </button>
    </fieldset>
  );
}
function ArrayInput({ schema, value, onChange, name, runtime }: Props) {
  const values = Array.isArray(value) ? value : [],
    item = schema.items ?? { 'x-any': true },
    label = labels[name] ?? name;
  const move = (from: number, to: number) => {
    const next = [...values];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  return (
    <fieldset className="array-editor" aria-label={label}>
      <legend>
        {label} · {values.length} 项
      </legend>
      {values.map((v, index) => (
        <div className="array-row" key={index}>
          <span className="item-number">{index + 1}</span>
          {name === 'pluginEntries' ? (
            <div className="plugin-entry">
              <label>
                插件模块
                <input
                  aria-label={`插件入口 ${index + 1} 模块`}
                  required
                  value={typeof v === 'string' ? v : String(record(v) ? (v.entry ?? '') : '')}
                  onChange={(e) =>
                    onChange(
                      values.map((old, i) =>
                        i === index
                          ? record(v)
                            ? { ...v, entry: e.target.value }
                            : e.target.value
                          : old,
                      ),
                    )
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  aria-label={`插件入口 ${index + 1} 启用`}
                  checked={typeof v === 'string' || (record(v) && v.enabled !== false)}
                  onChange={(e) =>
                    onChange(
                      values.map((old, i) =>
                        i === index
                          ? {
                              ...(record(v) ? v : {}),
                              entry: typeof v === 'string' ? v : record(v) ? v.entry : '',
                              enabled: e.target.checked,
                            }
                          : old,
                      ),
                    )
                  }
                />
                重启后启用
              </label>
            </div>
          ) : (
            <Field
              name={`${name} ${index + 1}`}
              schema={item}
              value={v}
              runtime={runtime}
              onChange={(next) =>
                onChange(
                  next === undefined
                    ? values.filter((_, i) => i !== index)
                    : values.map((old, i) => (i === index ? next : old)),
                )
              }
            />
          )}
          <div className="row-actions">
            <button
              type="button"
              aria-label={`上移 ${label} ${index + 1}`}
              disabled={!index}
              onClick={() => move(index, index - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`下移 ${label} ${index + 1}`}
              disabled={index === values.length - 1}
              onClick={() => move(index, index + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`删除 ${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              删除
            </button>
          </div>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...values, initial(item)])}>
        新增 {label}
      </button>
    </fieldset>
  );
}
export function Field(props: Props) {
  const { name, schema, value, onChange, runtime } = props,
    label = schema.title ?? labels[name] ?? name,
    id = useId();
  if (name === 'apiKeyRef')
    return (
      <span className="managed-reference">
        {value ? '已由全局 API key 安全保存；使用上方入口替换或清除。' : '尚未保存 API key。'}
      </span>
    );
  if (schema['x-rule']) return <RuleInput {...props} />;
  if (schema.writeOnly || secret(value))
    return <SecretInput label={label} value={value} onChange={onChange} />;
  const alternatives: FormSchema[] | undefined =
    schema.anyOf ??
    (Array.isArray(schema.type) ? schema.type.map((type) => ({ type })) : undefined);
  if (alternatives) {
    const index = Math.max(
      0,
      alternatives.findIndex((s) => matches(s, value)),
    );
    return (
      <div className="union-editor">
        <label>
          配置类型
          <select
            aria-label={`${label} 类型`}
            value={index}
            onChange={(e) => {
              const next = alternatives[Number(e.target.value)];
              let v = initial(next);
              if (record(v) && record(value) && value.$entry) v = { ...v, $entry: value.$entry };
              onChange(
                record(v) && typeof value === 'string' && next.properties?.entry
                  ? { ...v, entry: value }
                  : v,
              );
            }}
          >
            {alternatives.map((s, i) => (
              <option key={i} value={i}>
                {s.title ??
                  (s.properties?.command
                    ? '本地进程 stdio'
                    : s.properties?.url
                      ? '远程 HTTP'
                      : s.const !== undefined
                        ? String(s.const)
                        : (s.type ?? '值'))}
              </option>
            ))}
          </select>
        </label>
        <Field {...props} schema={alternatives[index]} />
      </div>
    );
  }
  if (schema.type === 'object')
    return schema.properties ? (
      <fieldset>
        <legend>{label}</legend>
        <Fields
          schema={schema}
          value={record(value) ? value : {}}
          onChange={onChange}
          runtime={runtime}
          effective={props.effective}
        />
      </fieldset>
    ) : (
      <MapInput {...props} />
    );
  if (schema.type === 'array') return <ArrayInput {...props} />;
  if (schema.type === 'null') return <span>空值（null）</span>;
  if (schema.enum || schema.const !== undefined) {
    const choices = schema.enum ?? [schema.const];
    return (
      <select
        aria-label={label}
        value={String(value ?? '')}
        onChange={(e) => onChange(choices.find((v) => String(v) === e.target.value))}
      >
        {choices.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  }
  if (schema.type === 'boolean')
    return (
      <select
        aria-label={label}
        value={String(value ?? false)}
        onChange={(e) => onChange(e.target.value === 'true')}
      >
        <option value="true">启用</option>
        <option value="false">关闭</option>
      </select>
    );
  if (schema.type === 'number' || schema.type === 'integer')
    return (
      <input
        aria-label={label}
        type="number"
        required
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  if (schema.type === 'string') {
    if (name === 'provider' && runtime)
      return (
        <select
          aria-label={label}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">选择 Provider</option>
          {[
            ...new Set([
              ...(runtime.providerOptions ?? runtime.providers ?? []),
              ...(typeof value === 'string' && value ? [value] : []),
            ]),
          ].map((v) => (
            <option key={v} value={v}>
              {runtime.providerLabels?.[v] ?? v}
            </option>
          ))}
        </select>
      );
    const choices = name === 'model' || name === 'judgeModel' ? runtime?.models : undefined;
    return (
      <>
        <input
          aria-label={label}
          type="text"
          autoComplete="off"
          spellCheck={false}
          minLength={schema.minLength}
          maxLength={schema.maxLength}
          list={choices ? id : undefined}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
        {choices && (
          <datalist id={id}>
            {choices.map((v) => (
              <option key={v} value={v}>
                {runtime?.modelDetails?.find((m) => m.id === v)?.displayName ?? v}
              </option>
            ))}
          </datalist>
        )}
        {name.startsWith('writeRoots ') && (
          <button
            type="button"
            onClick={() => {
              void getBridge()
                .pickDirectory()
                .then((path) => {
                  if (path) onChange(path);
                })
                .catch(() => window.alert('目录选择失败，请重试。'));
            }}
          >
            选择目录
          </button>
        )}
      </>
    );
  }
  // parse-only 外部插件也能使用明确类型的结构化控件；后端原 schema 最终校验。
  const inferred =
    value === null
      ? 'null'
      : record(value)
        ? 'object'
        : Array.isArray(value)
          ? 'array'
          : typeof value === 'number'
            ? 'number'
            : typeof value === 'boolean'
              ? 'boolean'
              : 'string';
  return (
    <div>
      <label>
        值类型
        <select
          aria-label={`${label} 值类型`}
          value={inferred}
          onChange={(e) => onChange(initial({ type: e.target.value }))}
        >
          {['string', 'number', 'boolean', 'array', 'object', 'null'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <Field
        {...props}
        schema={{
          type: inferred,
          ...(inferred === 'object' ? { additionalProperties: { 'x-any': true } } : {}),
        }}
      />
    </div>
  );
}
export function Fields({
  schema,
  value,
  onChange,
  runtime,
  effective,
}: {
  schema: FormSchema;
  value: Record<string, unknown>;
  onChange: (v: unknown) => void;
  runtime?: RuntimeSnapshot | SettingsSnapshot;
  effective?: unknown;
}) {
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([name, child]) => {
        if (name === 'apiKeyRef')
          return (
            <div className="configuration-field managed-reference-row" data-field={name} key={name}>
              <span>保存的 API key</span>
              <Field name={name} schema={child} value={value[name]} onChange={() => {}} />
            </div>
          );
        const present = Object.hasOwn(value ?? {}, name),
          label = child.title ?? labels[name] ?? name;
        return (
          <div
            className={
              'configuration-field ' +
              (['object', 'array'].includes(String(child.type)) || child.anyOf || child['x-any']
                ? 'field-complex'
                : 'field-scalar')
            }
            data-field={name}
            key={name}
          >
            <label className="override-label">
              <input
                type="checkbox"
                aria-label={'覆盖 ' + label}
                checked={present}
                onChange={(e) => {
                  const next = { ...value };
                  if (e.target.checked) next[name] = initial(child);
                  else delete next[name];
                  onChange(next);
                }}
              />
              <span>
                {label}
                <small>{present ? '本层覆盖' : '继承 / 默认'}</small>
              </span>
            </label>
            {(present ||
              (runtime &&
                'revision' in runtime &&
                record(effective) &&
                Object.hasOwn(effective, name) &&
                !['object', 'array'].includes(String(child.type)) &&
                !child.anyOf)) && (
              <Field
                name={name}
                schema={child}
                effective={record(effective) ? effective[name] : undefined}
                value={
                  present
                    ? value[name]
                    : record(effective) && Object.hasOwn(effective, name)
                      ? effective[name]
                      : initial(child)
                }
                runtime={runtime}
                onChange={(item) => {
                  const next = { ...value };
                  if (item === undefined) delete next[name];
                  else next[name] = item;
                  onChange(next);
                }}
              />
            )}
            {record(effective) && Object.hasOwn(effective, name) && (
              <details className="effective-value">
                <summary>合成有效值（不自动写入本层）</summary>
                <ValueView value={effective[name]} />
              </details>
            )}
            {child.description && <p className="small">{child.description}</p>}
            {(child.minimum !== undefined || child.maximum !== undefined) && (
              <small className="field-constraint">
                {child.minimum !== undefined ? `最小 ${child.minimum}` : ''}
                {child.minimum !== undefined && child.maximum !== undefined ? ' · ' : ''}
                {child.maximum !== undefined ? `最大 ${child.maximum}` : ''}
              </small>
            )}
          </div>
        );
      })}
    </>
  );
}
