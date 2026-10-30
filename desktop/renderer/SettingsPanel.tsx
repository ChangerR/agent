import { useEffect, useState, useId } from 'react';
import type { RuntimeSnapshot, SettingsDescriptor, SettingsSnapshot } from '../shared/protocol.js';

import { Field, Fields, ValueView, type FormSchema } from './SchemaForm.js';
import { getBridge } from './bridge.js';
import { CredentialPanel } from './CredentialPanel.js';
import { ModelDefaultsForm } from './ModelDefaultsForm.js';
import { ModelSetupForm } from './ModelSetupForm.js';
import { Icon } from './Icon.js';

const pageName = (id: string, title: string) =>
  ({
    'configuration-connection': '模型配置',
    'configuration-agentlab.provider-connections': '服务连接',
    'configuration-model-catalog': '模型目录',
    'configuration-budgets': '上下文与缓存',
    'configuration-permissions': '权限与审批',
    'configuration-agentlab.provider-anthropic': 'Anthropic 模型能力',
    'configuration-agentlab.provider-openai': 'OpenAI 模型能力',
  })[id] ?? title;

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
  onBack,
  appError,
  runtime,
  globalSettings,
  globalRequest,
  dirtyChanged,
  theme,
  changeTheme,
  onStartDemo,
  onOpenDebug,
}: {
  onBack: () => void;
  appError?: string;
  runtime?: RuntimeSnapshot;
  globalSettings?: SettingsSnapshot;
  globalRequest: (payload: Record<string, unknown>) => Promise<void>;
  request: (payload: Record<string, unknown>) => Promise<void>;
  dirtyChanged: (dirty: boolean) => void;
  theme: string;
  changeTheme: (theme: string) => void;
  onStartDemo: () => void;
  onOpenDebug: () => void;
}) {
  const [advancedModel, setAdvancedModel] = useState(false);
  const context = globalSettings;
  const sections = context?.settings ?? [];
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
  const loading = !editor || editor.sectionId !== selected || editor.scope !== 'global';
  const [credentialDirty, setCredentialDirty] = useState(false);
  const markDirty = (value: boolean) => {
    setDirty(value);
    dirtyChanged(value || credentialDirty);
  };
  useEffect(() => () => dirtyChanged(false), []);
  useEffect(() => {
    if (editor && editor.sectionId === selected && editor.scope === 'global') {
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
  }, [sections.length, selected, context?.generation]);
  useEffect(() => {
    if (!selected || !context) return;
    let active = true;
    setError('');
    void globalRequest({ type: 'settings-read', sectionId: selected, scope: 'global' }).catch(
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [selected, context?.generation]);
  const abandon = () =>
    !(dirty || credentialDirty) || window.confirm('此节有未保存更改，放弃后继续？');
  const select = (item: SettingsDescriptor) => {
    if (item.id === selected) return;
    if (!abandon()) return;
    markDirty(false);
    setSelected(item.id);
  };
  const update = (value: unknown) => {
    setDraft(value);
    markDirty(true);
  };
  const submit = async () => {
    if (!editor || loading || pending) return;
    setPending(true);
    setError('');
    try {
      await globalRequest({
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
  const formId = useId();
  const supportsQuickModel = !!getBridge().readModelSetup;
  const quickModel =
    selected === 'configuration-connection' && !advancedModel && supportsQuickModel;
  const chooseSection = (id: string) => {
    const item = sections.find((s) => s.id === id);
    if (item) select(item);
  };
  const value = (draft ?? {}) as Record<string, unknown>;
  const credential = (providerId?: string) => (
    <CredentialPanel
      settings={globalSettings!}
      providerId={providerId}
      blocked={dirty}
      dirtyChanged={(v) => {
        setCredentialDirty(v);
        dirtyChanged(dirty || v);
      }}
      refresh={async () => {
        await globalRequest({ type: 'settings-read', sectionId: selected, scope: 'global' });
      }}
    />
  );
  const domain = (
    {
      'configuration-agentlab.provider-connections': 'connections',
      'configuration-model-catalog': 'catalog',
      'configuration-mcp-servers': 'mcpServers',
    } as Record<string, string>
  )[selected];
  const commonIds = [
    'configuration-connection',
    'configuration-permissions',
    'configuration-mcp-servers',
  ];
  const normalizedSearch = search.trim().toLowerCase();
  const visibleSections = sections.filter((item) =>
    (
      pageName(item.id, item.title) +
      ' ' +
      item.title +
      ' ' +
      Object.keys(item.schema.properties ?? {}).join(' ')
    )
      .toLowerCase()
      .includes(normalizedSearch),
  );
  const commonSections = visibleSections.filter((item) => commonIds.includes(item.id));
  const advancedSections = visibleSections.filter((item) => !commonIds.includes(item.id));
  const navButtons = (items: SettingsDescriptor[]) =>
    items.map((item) => (
      <button
        type="button"
        key={item.id}
        aria-label={item.title}
        className={item.id === selected ? 'active' : ''}
        aria-current={item.id === selected ? 'page' : undefined}
        disabled={pending}
        onClick={() => select(item)}
      >
        {pageName(item.id, item.title)}
      </button>
    ));
  const content = (
    <section className="configuration-page" aria-label="应用设置">
      <aside className="configuration-nav">
        <input
          aria-label="查找设置页面"
          placeholder="搜索设置"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="settings-page-select"
          aria-label="设置页面"
          value={selected}
          disabled={pending}
          onChange={(e) => chooseSection(e.target.value)}
        >
          {commonSections.length > 0 && (
            <optgroup label="常用设置">
              {commonSections.map((item) => (
                <option key={item.id} value={item.id}>
                  {pageName(item.id, item.title)}
                </option>
              ))}
            </optgroup>
          )}
          {advancedSections.length > 0 && (
            <optgroup label="高级设置">
              {advancedSections.map((item) => (
                <option key={item.id} value={item.id}>
                  {pageName(item.id, item.title)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <nav className="settings-categories" aria-label="设置分类">
          {normalizedSearch ? (
            <div className="settings-category">
              <h3>搜索结果</h3>
              {navButtons(visibleSections)}
            </div>
          ) : (
            <>
              <div className="settings-category settings-common-nav">
                <h3>常用设置</h3>
                {navButtons(commonSections)}
              </div>
              {advancedSections.length > 0 && (
                <details
                  className="settings-category settings-advanced-nav"
                  open={advancedSections.some((item) => item.id === selected)}
                >
                  <summary>高级设置</summary>
                  <div>{navButtons(advancedSections)}</div>
                </details>
              )}
            </>
          )}
          {normalizedSearch && visibleSections.length === 0 && (
            <p className="empty-settings">没有匹配的设置</p>
          )}
        </nav>
      </aside>
      <div className="configuration-editor">
        {descriptor && (
          <>
            <header className="settings-page-heading">
              <div className="settings-heading-copy">
                <span className="settings-eyebrow">{category(selected)}</span>
                <h2 aria-label={descriptor.title}>{pageName(selected, descriptor.title)}</h2>
              </div>
              <div className="settings-header-actions">
                <button
                  className="icon-button settings-reload"
                  type="button"
                  aria-label="重新读取"
                  title="重新读取"
                  disabled={pending}
                  onClick={() => {
                    if (!abandon()) return;
                    markDirty(false);
                    if (quickModel) setResetEpoch((v) => v + 1);
                    void globalRequest({
                      type: 'settings-read',
                      sectionId: selected,
                      scope: 'global',
                    }).catch((e) => setError(e.message));
                  }}
                >
                  <Icon name="refresh" size={16} />
                </button>
              </div>
            </header>
            <div className="configuration-scroll">
              <div className="settings-content">
                <section className="settings-appearance" aria-label="通用设置">
                  <label htmlFor={`${formId}-theme`}>界面外观</label>
                  <select
                    id={`${formId}-theme`}
                    aria-label="设置界面主题"
                    value={theme}
                    onChange={(e) => changeTheme(e.target.value)}
                  >
                    <option value="system">跟随系统</option>
                    <option value="light">黑白灰</option>
                    <option value="dark">深色石墨</option>
                    <option value="blue">冷灰蓝</option>
                  </select>
                </section>
                <section className="settings-developer-tools" aria-label="开发工具">
                  <span>开发工具</span>
                  <div>
                    <button type="button" onClick={onStartDemo} disabled={runtime?.busy}>
                      <Icon name="terminal" size={14} /> 离线演示
                    </button>
                    <button
                      type="button"
                      aria-label="打开会话调试"
                      onClick={onOpenDebug}
                      disabled={!runtime}
                    >
                      <Icon name="monitor" size={14} /> 会话调试
                    </button>
                  </div>
                </section>
                {editor?.effectiveError && (
                  <p role="status" className="info">
                    有效值暂时无法合成：{editor.effectiveError}
                  </p>
                )}
                {error && (
                  <div role="alert" className="error-banner">
                    {error}
                  </div>
                )}
                {selected === 'configuration-connection' && supportsQuickModel && (
                  <button
                    type="button"
                    className="field-link model-settings-toggle"
                    disabled={pending}
                    onClick={() => {
                      if (!abandon()) return;
                      markDirty(false);
                      setAdvancedModel((v) => !v);
                    }}
                  >
                    {advancedModel ? '← 返回简单配置' : '高级设置：连接、模型目录与环境变量'}
                  </button>
                )}
                {quickModel ? (
                  <ModelSetupForm
                    key={resetEpoch}
                    pendingChanged={setPending}
                    dirtyChanged={(v) => {
                      setCredentialDirty(v);
                      dirtyChanged(dirty || v);
                    }}
                    refresh={() =>
                      globalRequest({ type: 'settings-read', sectionId: selected, scope: 'global' })
                    }
                  />
                ) : loading ? (
                  <p className="settings-loading" role="status">
                    正在读取设置…
                  </p>
                ) : descriptor.editable ? (
                  <>
                    <form
                      id={formId}
                      key={selected + ':global:' + context?.generation + ':' + resetEpoch}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submit();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && !pending) {
                          setDraft(editor.value);
                          setResetEpoch((v) => v + 1);
                          markDirty(false);
                        }
                      }}
                    >
                      <fieldset disabled={pending}>
                        <legend className="sr-only">本层覆盖</legend>
                        {selected === 'configuration-connection' ? (
                          <ModelDefaultsForm
                            schema={descriptor.schema as FormSchema}
                            value={value}
                            effective={editor.effectiveValue}
                            context={context}
                            scope="global"
                            onChange={update}
                            manageModels={() => chooseSection('configuration-model-catalog')}
                            manageProviders={() =>
                              chooseSection('configuration-agentlab.provider-connections')
                            }
                          />
                        ) : domain ? (
                          <div className="configuration-field domain-map" data-field={domain}>
                            <Field
                              name={domain}
                              schema={(descriptor.schema as FormSchema).properties![domain]}
                              value={value[domain] ?? {}}
                              effective={
                                (editor.effectiveValue as Record<string, unknown>)?.[domain]
                              }
                              runtime={context}
                              onChange={(item) => update({ ...value, [domain]: item })}
                              renderRecordFooter={
                                domain === 'connections'
                                  ? (id, item) =>
                                      (item as { type?: string })?.type === 'fake'
                                        ? null
                                        : credential(id)
                                  : undefined
                              }
                            />
                          </div>
                        ) : descriptor.schema.properties ? (
                          <Fields
                            schema={descriptor.schema as FormSchema}
                            value={value}
                            effective={editor.effectiveValue}
                            runtime={context}
                            onChange={update}
                          />
                        ) : (
                          <Field
                            name={descriptor.title}
                            schema={descriptor.schema as FormSchema}
                            value={draft}
                            runtime={context}
                            onChange={update}
                          />
                        )}
                      </fieldset>
                    </form>
                    {globalSettings &&
                      (selected === 'configuration-connection'
                        ? String(
                            value.provider ??
                              (editor.effectiveValue as Record<string, unknown>)?.provider ??
                              globalSettings.provider,
                          ) !== 'fake' &&
                          credential(
                            String(
                              value.provider ??
                                (editor.effectiveValue as Record<string, unknown>)?.provider ??
                                globalSettings.provider,
                            ),
                          )
                        : selected === 'configuration-agentlab.provider-openai'
                          ? credential('openai')
                          : selected === 'configuration-agentlab.provider-anthropic'
                            ? credential('anthropic')
                            : null)}
                    <details className="settings-advanced">
                      <summary>生效方式与高级操作</summary>
                      <p>{timing}</p>
                      <p className="configuration-path">
                        {descriptor.scopes.find((t) => t.scope === 'global')?.path}
                      </p>
                      <p>{descriptor.description}</p>
                      <button
                        type="button"
                        className="danger-link"
                        disabled={pending}
                        onClick={() => update({})}
                      >
                        {resetLabel}
                      </button>
                      <p className="field-hint">{resetHelp}</p>
                    </details>
                  </>
                ) : (
                  <ValueView value={editor.value} />
                )}
              </div>
            </div>
            {descriptor.editable && !quickModel && (
              <footer className="configuration-actions">
                <div className="save-state" role="status">
                  <span className={dirty ? 'dirty-dot' : 'saved-dot'} />
                  <span>{dirty ? '未保存' : editor?.saved ? '已保存' : '已同步'}</span>
                  <span className="save-timing">新打开项目或重新装配后采用</span>
                </div>
                <div className="button-group">
                  <button
                    type="button"
                    disabled={pending || loading || !dirty}
                    onClick={() => {
                      setDraft(editor?.value ?? {});
                      setResetEpoch((v) => v + 1);
                      markDirty(false);
                    }}
                  >
                    放弃更改
                  </button>
                  <button
                    type="submit"
                    form={formId}
                    className="primary"
                    disabled={!dirty || pending || loading}
                  >
                    {pending ? '正在保存…' : '保存更改'}
                  </button>
                </div>
              </footer>
            )}
          </>
        )}
      </div>
    </section>
  );
  return (
    <main className="settings-screen" aria-label="独立设置页面">
      <header className="settings-window-bar">
        <button
          type="button"
          className="settings-back"
          aria-label="返回工作区"
          onClick={onBack}
          disabled={pending}
          autoFocus
        >
          <Icon name="close" size={16} />
        </button>
        <h1>设置</h1>
      </header>
      {appError && (
        <div className="error-banner settings-app-error" role="alert">
          {appError}
        </div>
      )}
      {content}
    </main>
  );
}
