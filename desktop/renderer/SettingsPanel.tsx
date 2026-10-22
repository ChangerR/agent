import { useEffect, useState } from 'react';
import type { RuntimeSnapshot, SettingsDescriptor, SettingsSnapshot } from '../shared/protocol.js';

import { Field, Fields, ValueView, type FormSchema } from './SchemaForm.js';
import { getBridge } from './bridge.js';
import { CredentialPanel } from './CredentialPanel.js';

const category = (id: string) =>
  /connection|catalog|provider-openai|provider-anthropic|environment/.test(id)
    ? '连接与模型'
    : /budgets|additional|planning|summary|subagents/.test(id)
      ? '运行与上下文'
      : /mcp|local-tools/.test(id)
        ? '工具与 MCP'
        : /permissions|policy|capability/.test(id)
          ? '权限与安全'
          : /configuration/.test(id)
            ? '插件与装配'
            : '运行状态';

export function SettingsPanel({
  runtime,
  globalSettings,
  globalRequest,
  request,
  dirtyChanged,
  theme,
  changeTheme,
}: {
  runtime?: RuntimeSnapshot;
  globalSettings?: SettingsSnapshot;
  globalRequest: (payload: Record<string, unknown>) => Promise<void>;
  request: (payload: Record<string, unknown>) => Promise<void>;
  dirtyChanged: (dirty: boolean) => void;
  theme: string;
  changeTheme: (theme: string) => void;
}) {
  const [scope, setScope] = useState<'project' | 'global'>('global');
  const context = scope === 'global' ? globalSettings : runtime;
  const sections = context?.settings ?? [];
  const settingsRequest = (payload: Record<string, unknown>) =>
    scope === 'global' ? globalRequest(payload) : request(payload);
  const [selected, setSelected] = useState(
    sections.find((s) => s.id === 'configuration-connection')?.id ?? sections[0]?.id ?? '',
  );
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<unknown>({});
  const [resetEpoch, setResetEpoch] = useState(0);
  const [dirty, setDirty] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const descriptor = sections.find((item) => item.id === selected),
    editor = context?.settingsEditor;
  const settingsBusy = scope === 'project' && !!runtime?.busy;
  const loading = !editor || editor.sectionId !== selected || editor.scope !== scope;
  const [credentialDirty, setCredentialDirty] = useState(false);
  const markDirty = (value: boolean) => {
    setDirty(value);
    dirtyChanged(value || credentialDirty);
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
    if (sections.length && !sections.some((item) => item.id === selected))
      setSelected(sections.find((s) => s.id === 'configuration-connection')?.id ?? sections[0].id);
  }, [sections.length, scope, selected, context?.generation]);
  useEffect(() => {
    if (!selected || !context || (scope === 'project' && runtime?.busy)) return;
    let active = true;
    setError('');
    void settingsRequest({ type: 'settings-read', sectionId: selected, scope }).catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [
    selected,
    scope,
    context?.generation,
    scope === 'project' ? runtime?.sessionId : undefined,
    scope === 'project' ? runtime?.busy : undefined,
  ]);
  const abandon = () =>
    !(dirty || credentialDirty) || window.confirm('此节有未保存更改，放弃后继续？');
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
    if (!editor || loading || pending || settingsBusy) return;
    setPending(true);
    setError('');
    try {
      await settingsRequest({
        type: 'settings-commit',
        editorId: editor.id,
        json: JSON.stringify(draft),
      });
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
      if (selected) await settingsRequest({ type: 'settings-read', sectionId: selected, scope });
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置未保存，请重试。');
    } finally {
      setPending(false);
    }
  };
  const timing =
    descriptor?.applyMode === 'newSession'
      ? '新打开项目、重新装配并新建会话或重启 App 后采用；CLI 需重启。保存不改变当前会话或已有审批。'
      : descriptor?.applyMode === 'nextRequest'
        ? '下一次请求生效。'
        : '按此设置的声明应用。';
  const resetLabel =
    selected === 'configuration-model-catalog'
      ? '清空此文件的自定义模型'
      : selected === 'configuration-mcp-servers'
        ? '清空此文件的服务器'
        : selected === 'configuration-project-environment'
          ? '清空项目环境变量'
          : '清除此节的本层覆盖';
  const resetHelp =
    selected === 'configuration-model-catalog'
      ? '清空只改草稿；提交后删除此文件的模型条目及其附加元数据，恢复内置规格，保留 modelsFile 引用。要恢复另一层文件引用，请在“配置文件与插件装配”取消 modelsFile 覆盖。'
      : selected === 'configuration-mcp-servers'
        ? '清空只改草稿；提交后删除此文件的服务器条目及其附加元数据，保留文件其他字段和 mcpConfig 引用。要恢复另一层引用，请在“配置文件与插件装配”取消 mcpConfig 覆盖。'
        : selected === 'configuration-project-environment'
          ? '清空只改草稿；提交后移除已识别变量（含凭据），保留注释与未识别行。当前进程环境不变，重新装配后采用。'
          : '清除只修改草稿；提交后删除此节已知覆盖，保留未知字段。未勾选的字段不会被默认值回填。Esc 放弃未保存更改。';
  return (
    <section className="configuration-page" aria-label="应用设置">
      <aside className="configuration-nav">
        <div className="settings-nav-heading">
          <span className="settings-eyebrow">agentlab</span>
          <h2>设置</h2>
          <p className="small">全局默认值，所有项目共享。</p>
        </div>
        <input
          aria-label="查找设置页面"
          placeholder="查找设置页面"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <nav className="settings-categories" aria-label="设置分类">
          {['连接与模型', '运行与上下文', '工具与 MCP', '权限与安全', '插件与装配', '运行状态'].map(
            (group) => {
              const items = sections.filter(
                (item) =>
                  category(item.id) === group &&
                  (item.title + ' ' + Object.keys(item.schema.properties ?? {}).join(' '))
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              );
              return items.length ? (
                <div key={group} className="settings-category">
                  <h3>{group}</h3>
                  {items.map((item) => (
                    <button
                      key={item.id}
                      className={item.id === selected ? 'active' : ''}
                      aria-current={item.id === selected ? 'page' : undefined}
                      onClick={() => select(item)}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              ) : null;
            },
          )}
          {search &&
            !sections.some((item) =>
              (item.title + ' ' + Object.keys(item.schema.properties ?? {}).join(' '))
                .toLowerCase()
                .includes(search.toLowerCase()),
            ) && <p className="empty-settings">没有找到设置，试试模型、MCP 或 cache。</p>}
        </nav>
        <details className="settings-quick">
          <summary>外观与当前会话</summary>
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
                    <option key={model} value={model}>
                      {runtime.modelDetails?.find((m) => m.id === model)?.displayName ?? model}
                    </option>
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
        </details>
        {!runtime && <p className="small">无需打开项目即可完成全局设置。</p>}
        {runtime && (
          <details className="settings-quick">
            <summary>项目与会话管理</summary>
            <fieldset disabled={pending || runtime.busy} className="live-settings">
              <legend>项目与会话</legend>
              <p className="small">
                当前项目：{runtime.projectName}。项目路径与会话 ID
                由后端管理，不作为可任意写入的配置字段。
              </p>
              <button
                type="button"
                onClick={() => {
                  if (abandon()) {
                    markDirty(false);
                    void getBridge()
                      .newSession()
                      .catch((e) => setError(e.message));
                  }
                }}
              >
                重新装配并新建会话
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!abandon()) return;
                  markDirty(false);
                  setPending(true);
                  void request({ type: 'session-save' })
                    .then(() =>
                      settingsRequest({ type: 'settings-read', sectionId: selected, scope }),
                    )
                    .catch((e) => setError(e.message))
                    .finally(() => setPending(false));
                }}
              >
                保存当前会话
              </button>
              <p className="small">
                已保存 {runtime.sessions.length}{' '}
                个会话；恢复时由后端保护权限边界。当前会话的内存内容不会因删除保存记录自动清空。
              </p>
              {runtime.sessions.map((session) => (
                <div key={session.id} data-session-id={session.id} className="session-setting-row">
                  <span>{session.title}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (abandon()) {
                        markDirty(false);
                        void request({ type: 'resume', id: session.id }).catch((e) =>
                          setError(e.message),
                        );
                      }
                    }}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !abandon() ||
                        !window.confirm(
                          '删除这个已保存会话记录？当前内存会话可能在之后保存时重建记录。',
                        )
                      )
                        return;
                      markDirty(false);
                      setPending(true);
                      void request({ type: 'session-delete', id: session.id })
                        .then(() =>
                          settingsRequest({ type: 'settings-read', sectionId: selected, scope }),
                        )
                        .catch((e) => setError(e.message))
                        .finally(() => setPending(false));
                    }}
                  >
                    删除记录
                  </button>
                </div>
              ))}
            </fieldset>
          </details>
        )}
      </aside>
      <div className="configuration-editor">
        {descriptor && (
          <>
            <header className="settings-page-heading">
              <div>
                <span className="settings-eyebrow">{category(selected)}</span>
                <h2>{descriptor.title}</h2>
              </div>
              <div className="settings-header-actions">
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
                      {[{ scope: 'global' }, { scope: 'project' }].map((item) => (
                        <option
                          key={item.scope}
                          value={item.scope}
                          disabled={
                            item.scope === 'project' &&
                            (!runtime ||
                              !runtime.settings.some(
                                (s) =>
                                  s.id === selected && s.scopes.some((t) => t.scope === 'project'),
                              ))
                          }
                        >
                          {item.scope === 'global'
                            ? '全局配置 · 所有项目默认'
                            : '高级 · 仅覆盖当前项目'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="tag" role="status">
                    {dirty ? '未保存' : editor?.saved ? '已保存' : '原始层值'}
                  </span>
                </div>{' '}
                <button
                  type="button"
                  className="outline settings-reload"
                  disabled={pending || settingsBusy}
                  onClick={() => {
                    if (!abandon()) return;
                    markDirty(false);
                    void settingsRequest({
                      type: 'settings-read',
                      sectionId: selected,
                      scope,
                    }).catch((e) => setError(e.message));
                  }}
                >
                  重新读取
                </button>
              </div>
            </header>
            <details className="settings-location">
              <summary>保存位置与生效方式</summary>
              <p className="configuration-path">
                {descriptor.scopes.find((item) => item.scope === scope)?.path ?? '只读运行状态'}
              </p>
              <p className="small">{descriptor.description}</p>
            </details>
            <p className="info">{timing}</p>
            {runtime && (
              <p className="small settings-current-runtime">
                当前会话：{runtime.provider} / {runtime.model} · {runtime.mode} · 思考{' '}
                {runtime.thinking}。启动默认值不覆盖已恢复会话。
              </p>
            )}

            {selected === 'configuration-connection' && context && (
              <section className="provider-manager" aria-label="Provider 管理">
                <h3>已注册 Provider</h3>
                <p className="small save-help">
                  选择 Provider 与模型，一次提交启动默认值。内置 openai / anthropic 使用下方
                  Endpoint；API key
                  在下方直接输入并加密保存。环境变量是可选高级方式。命名连接在“Provider
                  连接”管理。保存后重新装配采用。
                </p>
                <div className="provider-cards">
                  {(context.providerOptions ?? context.providers).map((id) => (
                    <button
                      key={id}
                      type="button"
                      disabled={pending || settingsBusy}
                      aria-pressed={(draft as { provider?: string })?.provider === id}
                      onClick={() => update({ ...(draft as object), provider: id })}
                    >
                      <strong>{context.providerLabels?.[id] ?? id}</strong>
                      <small>
                        {id} ·{' '}
                        {scope === 'global'
                          ? context.provider === id
                            ? '全局默认'
                            : '可用连接'
                          : context.provider === id
                            ? '当前会话使用'
                            : context.providers.includes(id)
                              ? '已加载'
                              : '保存后待装配'}
                      </small>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const target = sections.find(
                      (s) => s.id === 'configuration-agentlab.provider-connections',
                    );
                    if (target) select(target);
                  }}
                >
                  添加或管理 Provider 连接
                </button>
              </section>
            )}
            {scope === 'global' &&
              ['configuration-connection', 'configuration-agentlab.provider-connections'].includes(
                selected,
              ) &&
              globalSettings && (
                <CredentialPanel
                  key={selected}
                  settings={globalSettings}
                  blocked={dirty}
                  dirtyChanged={(v) => {
                    setCredentialDirty(v);
                    dirtyChanged(dirty || v);
                  }}
                  refresh={async () => {
                    await globalRequest({
                      type: 'settings-read',
                      sectionId: selected,
                      scope: 'global',
                    });
                  }}
                />
              )}
            <p className="scope-explanation">
              {scope === 'global'
                ? '保存到用户目录，作为所有项目的默认值；不会创建项目配置或会话。'
                : '仅覆盖当前项目；未勾选字段继承全局配置。权限规则按既有合并规则生效。'}
            </p>
            {editor?.effectiveError && (
              <p role="status" className="info">
                其他层的有效值暂时无法合成：{editor.effectiveError}。本层值仍可审阅。
              </p>
            )}
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
            {loading ? (
              <p role="status">
                {runtime?.busy
                  ? '任务或审批仍在处理中；结算后自动读取设置，当前审批保持待处理。'
                  : '正在读取设置…'}
              </p>
            ) : descriptor.editable ? (
              <form
                key={selected + ':' + scope + ':' + context?.generation + ':' + resetEpoch}
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
                <fieldset disabled={pending || settingsBusy}>
                  <legend className="sr-only">本层覆盖</legend>
                  {descriptor.schema.properties &&
                  Object.keys(descriptor.schema.properties as object).length ? (
                    <Fields
                      schema={descriptor.schema as FormSchema}
                      value={draft as Record<string, unknown>}
                      onChange={update}
                      runtime={context}
                      effective={editor.effectiveValue}
                    />
                  ) : (
                    <Field
                      name={descriptor.title}
                      schema={descriptor.schema as FormSchema}
                      value={draft}
                      onChange={update}
                      runtime={runtime}
                    />
                  )}
                </fieldset>
                <div className="configuration-actions">
                  <button
                    className="primary"
                    disabled={!dirty || pending || settingsBusy}
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
                    disabled={pending || settingsBusy}
                    onClick={() => update({})}
                  >
                    {resetLabel}
                  </button>
                </div>
                <p className="small">{resetHelp}</p>
              </form>
            ) : (
              <ValueView value={editor.value} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
