import { useEffect, useState } from 'react';
import type { RuntimeSnapshot, SettingsDescriptor } from '../shared/protocol.js';

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  minimum?: number;
  maximum?: number;
  writeOnly?: boolean;
};
const names: Record<string, string> = {
  replayToolArguments: '原始工具参数回放（默认关闭）',
  staticTtl: '静态前缀 TTL（省略时继承会话 TTL）',
  ttlStrategy: '缓存 TTL 策略',
  strategy: '摘要策略（prefix 需显式开启）',
  maxAgeDays: 'MCP 结果保留天数（0 关闭）',
  maxStoredBytes: 'MCP 结果存储软上限（字节；0 关闭）',
  deduplicate: 'MCP 结果去重（默认关闭）',
  maxSearchChars: 'MCP 单次检索字符上限',
  models: '模型 API 能力映射（JSON）',
  provider: 'Provider',
  model: '模型 ID',
  baseURL: 'Endpoint URL',
  apiKeyEnv: 'API key 环境变量名',
  thinking: '思考等级',
  judgeModel: '审批模型（空值跟随主模型）',
  maxTurns: '最大轮数',
  compactThreshold: '上下文压缩阈值（tokens）',
  cache: '缓存',
  enabled: '启用',
  ttl: 'TTL',
  escalateAfterMs: '升级到 1h 的工具耗时阈值（毫秒；0 关闭）',
  permissionMode: '权限模式',
  permissions: '权限规则',
  allow: 'Allow 规则',
  ask: 'Ask 规则',
  deny: 'Deny 规则',
  modelsFile: '模型规格文件',
  mcpConfig: 'MCP 配置文件',
  pluginEntries: '插件入口',
  disabledPlugins: '禁用的插件',
  timeoutMs: '超时（毫秒）',
  maxRequestBytes: '请求字节上限',
  maxResponseBytes: '响应字节上限',
  maxOutputTokens: '输出 token 上限',
  prefixCache: '审批请求前缀缓存',
  maxInlineChars: 'MCP 结果内联字符上限',
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
};
function JsonInput({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setInvalid(false);
  }, [JSON.stringify(value)]);
  return (
    <>
      <textarea
        aria-label={label}
        aria-invalid={invalid}
        spellCheck={false}
        rows={5}
        value={text}
        onChange={(event) => {
          const text = event.target.value;
          setText(text);
          try {
            const parsed = JSON.parse(text);
            event.currentTarget.setCustomValidity('');
            onChange(parsed);
            setInvalid(false);
          } catch {
            event.currentTarget.setCustomValidity('请输入合法 JSON');
            setInvalid(true);
            onChange(value);
          }
        }}
      />
      {invalid && <span role="alert">请输入合法 JSON；此字段尚未提交。</span>}
    </>
  );
}
function Field({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = names[name] ?? name;
  if (schema.type === 'object' && schema.properties)
    return (
      <fieldset>
        <legend>{label}</legend>
        <Fields schema={schema} value={value as Record<string, unknown>} onChange={onChange} />
      </fieldset>
    );
  if (schema.enum)
    return (
      <select
        aria-label={label}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {schema.enum.map((item) => (
          <option key={String(item)}>{String(item)}</option>
        ))}
      </select>
    );
  if (schema.type === 'boolean')
    return (
      <select
        aria-label={label}
        value={String(value)}
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
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        value={typeof value === 'number' && Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  if (schema.type === 'string')
    return (
      <input
        aria-label={label}
        type={schema.writeOnly ? 'password' : 'text'}
        autoComplete="off"
        spellCheck={false}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return <JsonInput label={label} value={value} onChange={onChange} />;
}
function initial(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'object') return {};
  if (schema.type === 'array') return [];
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  return '';
}
function Fields({
  schema,
  value,
  onChange,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: unknown) => void;
}) {
  return (
    <>
      {Object.entries(schema.properties ?? {}).map(([name, child]) => {
        const present = Object.hasOwn(value ?? {}, name),
          label = names[name] ?? name;
        return (
          <div className="configuration-field" key={name}>
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
                <small>
                  {name} · {present ? '本层已设置' : '本层未设置 · 按 CLI 规则继承 / 默认'}
                </small>
              </span>
            </label>
            {present && (
              <Field
                name={name}
                schema={child}
                value={value[name]}
                onChange={(item) => onChange({ ...value, [name]: item })}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
export function SettingsPanel({
  runtime,
  request,
  dirtyChanged,
  theme,
  changeTheme,
}: {
  runtime?: RuntimeSnapshot;
  request: (payload: Record<string, unknown>) => Promise<void>;
  dirtyChanged: (dirty: boolean) => void;
  theme: string;
  changeTheme: (theme: string) => void;
}) {
  const sections = runtime?.settings ?? [];
  const [selected, setSelected] = useState(sections[0]?.id ?? '');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [draft, setDraft] = useState<unknown>({});
  const [resetEpoch, setResetEpoch] = useState(0);
  const [dirty, setDirty] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const descriptor = sections.find((item) => item.id === selected),
    editor = runtime?.settingsEditor;
  const loading = !editor || editor.sectionId !== selected || editor.scope !== scope;
  const markDirty = (value: boolean) => {
    setDirty(value);
    dirtyChanged(value);
  };
  useEffect(() => () => dirtyChanged(false), []);
  useEffect(() => {
    if (editor && editor.sectionId === selected && editor.scope === scope) {
      if (!editor.error) {
        setDraft(editor.value ?? {});
        markDirty(false);
      }
      setError(editor.error ?? '');
    }
  }, [editor?.id, editor?.error, editor?.feedbackRevision]);
  useEffect(() => {
    if (!selected && sections.length) setSelected(sections[0].id);
  }, [sections.length]);
  useEffect(() => {
    if (!selected || !runtime) return;
    let active = true;
    setError('');
    void request({ type: 'settings-read', sectionId: selected, scope }).catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [selected, scope, runtime?.generation, runtime?.sessionId]);
  const abandon = () => !dirty || window.confirm('此节有未保存更改，放弃后继续？');
  const select = (item: SettingsDescriptor) => {
    if (item.id === selected) return;
    if (!abandon()) return;
    markDirty(false);
    setSelected(item.id);
    setScope(
      item.scopes.some((s) => s.scope === scope) ? scope : (item.scopes[0]?.scope ?? 'project'),
    );
  };
  const update = (value: unknown) => {
    setDraft(value);
    markDirty(true);
  };
  const submit = async () => {
    if (!editor || loading || pending || runtime?.busy) return;
    setPending(true);
    setError('');
    try {
      await request({ type: 'settings-commit', editorId: editor.id, json: JSON.stringify(draft) });
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败，请重试。');
    } finally {
      setPending(false);
    }
  };
  const liveSetting = async (field: 'model' | 'mode' | 'think', value: string) => {
    if (pending || runtime?.busy || !abandon()) return;
    markDirty(false);
    setPending(true);
    setError('');
    try {
      await request({ type: 'setting', field, value });
      if (selected) await request({ type: 'settings-read', sectionId: selected, scope });
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置未保存，请重试。');
    } finally {
      setPending(false);
    }
  };
  const timing =
    descriptor?.applyMode === 'newSession'
      ? '重启 App / CLI 后生效；当前会话和已有审批保持。'
      : descriptor?.applyMode === 'nextRequest'
        ? '下一次请求生效。'
        : '按此设置的声明应用。';
  return (
    <section className="configuration-page" aria-label="应用设置">
      <aside className="configuration-nav">
        <h2>设置</h2>
        <p className="small">用户默认 &lt; 项目覆盖 &lt; 会话覆盖</p>
        {sections.map((item) => (
          <button
            key={item.id}
            className={item.id === selected ? 'active' : ''}
            onClick={() => select(item)}
          >
            {item.title}
          </button>
        ))}
        <label>
          界面外观
          <select
            aria-label="设置界面主题"
            value={theme}
            onChange={(e) => changeTheme(e.target.value)}
          >
            <option value="system">跟随系统</option>
            <option value="light">黑白灰</option>
            <option value="dark">深色石墨</option>
            <option value="blue">冷灰蓝</option>
          </select>
        </label>
        {runtime && (
          <fieldset disabled={pending || runtime.busy} className="live-settings">
            <legend>当前会话 · 选择即保存项目</legend>
            <label>
              模型
              <select
                aria-label="设置当前模型"
                value={runtime.model}
                onChange={(e) => void liveSetting('model', e.target.value)}
              >
                {runtime.models.map((model) => (
                  <option key={model}>{model}</option>
                ))}
              </select>
            </label>
            <label>
              权限模式
              <select
                aria-label="设置当前权限模式"
                value={runtime.mode}
                onChange={(e) => void liveSetting('mode', e.target.value)}
              >
                {['ask', 'auto', 'yolo'].map((mode) => (
                  <option key={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <label>
              思考
              <select
                aria-label="设置当前思考等级"
                value={runtime.thinking}
                onChange={(e) => void liveSetting('think', e.target.value)}
              >
                {['off', 'low', 'medium', 'high'].map((thinking) => (
                  <option key={thinking}>{thinking}</option>
                ))}
              </select>
            </label>
            <p className="small">
              模型 /
              思考于下一次请求采用；模式用于后续权限检查，已有审批仍须处理。连接与规则等结构化默认值使用右侧提交。
            </p>
          </fieldset>
        )}
        {!runtime && <p>打开项目后可配置 Agent；外观立即生效。</p>}
      </aside>
      <div className="configuration-editor">
        {descriptor && (
          <>
            <h2>{descriptor.title}</h2>
            <div className="configuration-scope">
              <label>
                编辑作用域{' '}
                <select
                  aria-label="配置作用域"
                  value={scope}
                  disabled={pending || !descriptor.scopes.length}
                  onChange={(e) => {
                    if (!abandon()) return;
                    markDirty(false);
                    setScope(e.target.value as typeof scope);
                  }}
                >
                  {(descriptor.scopes.length ? descriptor.scopes : [{ scope: 'project' }]).map(
                    (item) => (
                      <option key={item.scope} value={item.scope}>
                        {item.scope === 'global' ? '用户级 · 所有项目默认' : '项目级 · 当前项目'}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <span className="tag" role="status">
                {dirty ? '未保存' : editor?.saved ? '已保存' : '原始层值'}
              </span>
            </div>
            <p className="configuration-path">
              {descriptor.scopes.find((item) => item.scope === scope)?.path ?? '只读运行状态'}
            </p>
            <p className="info">{timing}</p>
            {runtime && (
              <p className="small">
                当前会话：{runtime.provider} / {runtime.model} · {runtime.mode} · 思考{' '}
                {runtime.thinking}。启动默认值不覆盖已恢复会话。
              </p>
            )}
            <button
              type="button"
              className="outline"
              disabled={pending || runtime?.busy}
              onClick={() => {
                if (!abandon()) return;
                markDirty(false);
                void request({ type: 'settings-read', sectionId: selected, scope }).catch((e) =>
                  setError(e.message),
                );
              }}
            >
              重新读取
            </button>
            <p className="small">{descriptor.description}</p>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {loading ? (
              <p>正在读取设置…</p>
            ) : descriptor.editable ? (
              <form
                key={editor.id + ':' + resetEpoch}
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && !pending) {
                    setDraft(editor.value);
                    setResetEpoch((epoch) => epoch + 1);
                    markDirty(false);
                  }
                }}
              >
                <fieldset disabled={pending || runtime?.busy}>
                  <legend className="sr-only">本层覆盖</legend>
                  {descriptor.schema.properties &&
                  Object.keys(descriptor.schema.properties as object).length ? (
                    <Fields
                      schema={descriptor.schema as JsonSchema}
                      value={draft as Record<string, unknown>}
                      onChange={update}
                    />
                  ) : (
                    <JsonInput label="配置 JSON" value={draft} onChange={update} />
                  )}
                </fieldset>
                <div className="configuration-actions">
                  <button
                    className="primary"
                    disabled={!dirty || pending || runtime?.busy}
                    type="submit"
                  >
                    {pending ? '正在验证与保存…' : '提交此节'}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setDraft(editor.value);
                      setResetEpoch((epoch) => epoch + 1);
                      markDirty(false);
                    }}
                  >
                    放弃更改
                  </button>
                  <button
                    type="button"
                    disabled={pending || runtime?.busy}
                    onClick={() => update({})}
                  >
                    清除此节的本层覆盖
                  </button>
                </div>
                <p className="small">
                  清除只修改草稿；提交后删除此节已知覆盖，保留未知字段。未勾选的字段不会被默认值回填。Esc
                  放弃未保存更改。
                </p>
              </form>
            ) : (
              <pre>{JSON.stringify(editor.value, null, 2)}</pre>
            )}
          </>
        )}
      </div>
    </section>
  );
}
