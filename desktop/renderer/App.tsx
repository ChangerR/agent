import { useEffect, useRef, useState } from 'react';
import { MessageMarkdown } from './MessageMarkdown.js';
import { Icon } from './Icon.js';
import type {
  DesktopAction,
  DesktopState,
  RuntimeSnapshot,
  Row,
  Approval,
  Interaction,
} from '../shared/protocol.js';
import { getBridge } from './bridge.js';
import { SettingsPanel } from './SettingsPanel.js';
const bridge = getBridge();
const empty: DesktopState = { version: 1, revision: -1, connecting: false, projects: [] };
type Theme = 'system' | 'light' | 'dark' | 'blue';
const labels: Record<string, string> = {
  default: '内置',
  global: '全局',
  project: '项目',
  session: '会话',
};
function pathFrom(row: Row) {
  try {
    const input = JSON.parse(row.input ?? '{}');
    return typeof input.path === 'string' ? input.path : undefined;
  } catch {
    return undefined;
  }
}
function ApprovalCard({
  approval,
  disabled,
  respond,
}: {
  approval: Approval;
  disabled: boolean;
  respond: (allow: boolean, feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState('');
  return (
    <section className="approval" aria-label="工具审批">
      <div className="approval-head">
        <strong>需要你的确认</strong>
        <span className="tag">
          {approval.agentName ?? approval.interpreter ?? approval.toolName}
        </span>
      </div>
      <p className="small">{approval.cwd}</p>
      <pre className="command">{approval.summary}</pre>
      <p className="small">{approval.reason}</p>
      <details>
        <summary>查看完整参数</summary>
        <pre>{approval.input}</pre>
      </details>
      <input
        aria-label="拒绝反馈（可选）"
        placeholder="拒绝时可附一句反馈"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="actions">
        <button disabled={disabled} className="outline" onClick={() => respond(false, feedback)}>
          拒绝
        </button>
        <button disabled={disabled} className="primary" onClick={() => respond(true, feedback)}>
          仅允许本次
        </button>
      </div>
    </section>
  );
}
function InteractionCard({
  interaction,
  respond,
}: {
  interaction: Interaction;
  respond: (value?: string) => void;
}) {
  const [value, setValue] = useState(
    interaction.initialValue ?? interaction.choices?.[0]?.id ?? '',
  );
  return (
    <section className="approval">
      <strong>{interaction.prompt}</strong>
      {interaction.body && <pre>{interaction.body}</pre>}
      {interaction.choices?.length ? (
        <select aria-label="命令选项" value={value} onChange={(e) => setValue(e.target.value)}>
          {interaction.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      ) : (
        <input aria-label="命令输入" value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      <div className="actions">
        <button className="outline" onClick={() => respond()}>
          取消
        </button>
        <button className="primary" onClick={() => respond(value)}>
          确定
        </button>
      </div>
    </section>
  );
}
function MessageRow({
  row,
  openFile,
  disabled,
}: {
  row: Row;
  openFile: (path: string) => void;
  disabled: boolean;
}) {
  if (row.kind === 'thinking')
    return (
      <details className="thinking">
        <summary>思考过程</summary>
        <pre>{row.text}</pre>
      </details>
    );
  if (row.kind === 'tool')
    return (
      <details className="tool">
        <summary>
          <span className={'tool-status ' + row.status}>
            {row.status === 'running'
              ? '…'
              : row.status === 'completed'
                ? '✓'
                : row.status === 'cancelled'
                  ? '—'
                  : '!'}
          </span>
          <strong>{row.toolName}</strong>
          <span className="tool-path">{pathFrom(row) ?? ''}</span>
          <span className="duration">
            {row.durationMs !== undefined
              ? (row.durationMs / 1000).toFixed(1) + 's'
              : row.status === 'running'
                ? '执行中'
                : ''}
          </span>
        </summary>
        <div className="tool-body">
          <h4>参数</h4>
          <pre>{row.input}</pre>
          <h4>结果</h4>
          <pre>{row.text}</pre>
          {pathFrom(row) && (
            <button
              className="outline"
              disabled={disabled}
              onClick={() => openFile(pathFrom(row)!)}
            >
              查看文件
            </button>
          )}
        </div>
      </details>
    );
  if (row.kind === 'notice')
    return (
      <details className="notice">
        <summary>{row.text.split('\n')[0].slice(0, 150)}</summary>
        <pre>{row.text}</pre>
      </details>
    );
  return (
    <article className={'message ' + row.kind}>
      <div className="who">
        <span className="avatar">{row.kind === 'user' ? '你' : 'a'}</span>
        {row.kind === 'user' ? '你' : 'agentlab'}
      </div>
      {row.kind === 'user' ? (
        <div className="user-text">{row.text}</div>
      ) : (
        <MessageMarkdown text={row.text} />
      )}
    </article>
  );
}
export default function App() {
  const [state, setState] = useState(empty),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [view, setView] = useState<'projects' | 'chat' | 'settings'>('projects'),
    [tab, setTab] = useState<'diff' | 'files' | 'logs'>('diff');
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('agentlab-theme');
      return ['system', 'light', 'dark', 'blue'].includes(saved ?? '')
        ? (saved as Theme)
        : 'system';
    } catch {
      return 'system';
    }
  });
  const [prompt, setPrompt] = useState(''),
    [model, setModel] = useState(''),
    [files, setFiles] = useState<string[]>([]),
    [inspector, setInspector] = useState(false),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const settingsDirtyRef = useRef(false);
  const dirtyChanged = (dirty: boolean) => {
    settingsDirtyRef.current = dirty;
    void bridge.settingsDirty(dirty).catch(() => {});
  };
  const allowLeave = () => {
    if (settingsDirtyRef.current && !window.confirm('设置有未保存更改，放弃后继续？')) return false;
    dirtyChanged(false);
    return true;
  };
  const navigate = (next: typeof view) => {
    if (next === view || allowLeave()) {
      setView(next);
      if (window.innerWidth <= 650 || next === 'settings') setSidebar(false);
    }
  };
  useEffect(() => {
    const resize = () => {
      if (view === 'settings' && window.innerWidth < 1040) setSidebar(false);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [view]);
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const runtime = state.runtime,
    busy = state.connecting || !!runtime?.busy;
  const disabled = busy || pending;
  useEffect(() => {
    if (state.theme) setTheme(state.theme);
  }, [state.theme]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    media.addEventListener('change', apply);
    try {
      localStorage.setItem('agentlab-theme', theme);
    } catch {}
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    let active = true;
    const receive = (next: DesktopState) => {
      if (active) setState((old) => (next.revision > old.revision ? next : old));
    };
    const off = bridge.onState(receive);
    bridge
      .snapshot()
      .then(receive)
      .catch((e) => setError(e.message));
    return () => {
      active = false;
      off();
    };
  }, []);
  useEffect(() => {
    setModel(runtime?.model ?? '');
  }, [runtime?.model]);
  useEffect(() => {
    setFiles([]);
    setPrompt('');
    setError('');
    follow.current = true;
  }, [runtime?.generation, runtime?.sessionId]);
  useEffect(() => {
    if (runtime?.inspection.kind === 'files')
      setFiles(
        runtime.inspection.content
          .split('\n')
          .filter((p) => p && !p.startsWith('(') && !p.startsWith('点击刷新')),
      );
  }, [runtime?.inspection]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [runtime?.seq, view]);
  const perform = async (fn: () => Promise<void>) => {
    setPending(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setPending(false);
    }
  };
  const action = (
    payload: Omit<DesktopAction, 'generation' | 'sessionId'> | Record<string, unknown>,
  ) => {
    if (!runtime) return Promise.reject(new Error('请先打开项目'));
    return bridge.request({
      ...payload,
      generation: runtime.generation,
      sessionId: runtime.sessionId,
    } as DesktopAction);
  };
  const inspect = (kind: 'files' | 'read' | 'diff', path?: string) => {
    setInspector(true);
    if (kind !== 'read') setTab(kind === 'files' ? 'files' : 'diff');
    else setTab('files');
    void perform(() => action({ type: 'inspect', kind, path }));
  };
  const openFile = (path: string) => inspect('read', path);
  const choose = () => {
    if (!allowLeave()) return;
    void perform(async () => {
      await bridge.pickProject();
    });
  };
  const openProject = (id: string) => {
    if (!allowLeave()) return;
    if (runtime?.cwd === id && runtime.phase !== '进程中断') {
      setView('chat');
      return;
    }
    void perform(async () => {
      await bridge.openProject(id);
      setView('chat');
    });
  };
  useEffect(() => {
    if (runtime?.generation) setView('chat');
  }, [runtime?.generation]);
  const startDemo = () => {
    if (!allowLeave()) return;
    void perform(async () => {
      await bridge.startDemo();
      setView('chat');
    });
  };
  const newSession = () => {
    if (!allowLeave()) return;
    void perform(async () => {
      await bridge.newSession();
      setView('chat');
    });
  };
  const submit = () => {
    const text = prompt.trim();
    if (!text || !runtime || disabled) return;
    follow.current = true;
    void perform(async () => {
      await action({ type: 'submit', text, invocationId: crypto.randomUUID() });
      setPrompt('');
    });
  };
  const setting = (field: 'model' | 'mode' | 'think', value: string) =>
    void perform(() => action({ type: 'setting', field, value }));
  const changeTheme = (value: string) => {
    if (!['system', 'light', 'dark', 'blue'].includes(value)) return;
    void perform(async () => {
      await bridge.setTheme?.(value as Theme);
      setTheme(value as Theme);
    });
  };
  useEffect(() => {
    const off = bridge.onNavigate((target) => {
      if (target === 'settings') navigate('settings');
      else if (target === 'open-project') choose();
      else if (!disabled && runtime) newSession();
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (settingsDirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      off();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });
  useEffect(() => {
    document.documentElement.dataset.platform = state.platform ?? 'browser';
  }, [state.platform]);
  const allError = error || state.error || runtime?.error;
  return (
    <div
      className={
        'app ' +
        (!inspector || view !== 'chat' ? 'inspector-closed ' : '') +
        (!sidebar ? 'sidebar-closed' : '')
      }
    >
      {sidebar && (
        <aside className="sidebar">
          <div className="brand">
            <span className="logo">
              <Icon name="terminal" size={19} />
            </span>
            <span className="brand-name">agentlab</span>
            <button
              className="icon-button sidebar-toggle"
              aria-label="收起侧栏"
              onClick={() => setSidebar(false)}
            >
              <Icon name="sidebar" />
            </button>
          </div>
          <button className="nav-new" disabled={disabled || !runtime} onClick={newSession}>
            <Icon name="plus" /> 新建会话
          </button>
          <button
            className={'nav-home ' + (view === 'projects' ? 'active' : '')}
            onClick={() => navigate('projects')}
          >
            <Icon name="grid" /> 所有项目 <span>{state.projects.length}</span>
          </button>
          <div className="section-label">
            <span>项目</span>
            <button
              className="icon-button"
              aria-label="添加本地项目"
              title="添加本地项目"
              disabled={disabled}
              onClick={choose}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          <nav className="project-tree" aria-label="项目列表">
            {state.projects.map((project) => (
              <div
                className={'project-group ' + (runtime?.cwd === project.path ? 'selected' : '')}
                key={project.id}
              >
                <button
                  className="project-entry"
                  title={project.path}
                  aria-label={'打开项目 ' + project.name}
                  disabled={disabled && runtime?.cwd !== project.path}
                  onClick={() => openProject(project.id)}
                >
                  <Icon name="folder" />
                  <span className="project-entry-name">{project.name}</span>
                  {runtime?.cwd === project.path && (
                    <span className="project-indicator" title={runtime.phase}>
                      ●
                    </span>
                  )}
                </button>
                {runtime?.cwd === project.path && (
                  <div className="project-children">
                    <div className="project-shortcuts">
                      <button disabled={disabled} onClick={newSession}>
                        <Icon name="plus" size={13} /> 新建会话
                      </button>
                      <button
                        aria-label={'设置项目 ' + project.name}
                        title="项目设置"
                        onClick={() => navigate('settings')}
                      >
                        <Icon name="settings" size={14} />
                      </button>
                    </div>
                    <div className="session-list" aria-label={project.name + ' 的会话'}>
                      {runtime && !runtime.sessions.some((s) => s.id === runtime.sessionId) && (
                        <button className="active" onClick={() => navigate('chat')}>
                          <span>新会话</span>
                          <span className="session-meta">{runtime.phase}</span>
                        </button>
                      )}
                      {runtime?.sessions.map((s) => (
                        <button
                          key={s.id}
                          className={s.id === runtime.sessionId ? 'active' : ''}
                          disabled={disabled}
                          onClick={() => {
                            if (!allowLeave()) return;
                            setView('chat');
                            if (s.id !== runtime.sessionId)
                              void perform(() => action({ type: 'resume', id: s.id }));
                          }}
                        >
                          <span>{s.title || '未命名会话'}</span>
                          <span className="session-meta" title={s.messageCount + ' 条消息'}>
                            {new Date(s.updatedAt).toLocaleDateString('zh-CN', {
                              month: 'numeric',
                              day: 'numeric',
                            })}
                          </span>
                        </button>
                      ))}
                      {runtime?.brokenSessions ? (
                        <p className="small">
                          {runtime.brokenSessions} 个会话无法读取，文件已保留。
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {!state.projects.length && (
              <p className="small tree-empty">
                添加一个文件夹
                <br />
                作为你的第一个项目。
              </p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <button aria-label="打开应用设置" onClick={() => navigate('settings')}>
              <Icon name="settings" /> 设置{' '}
              <kbd>{state.platform === 'darwin' ? '⌘,' : 'Ctrl+,'}</kbd>
            </button>
            <label className="theme-control">
              <span>
                <Icon name="moon" /> 外观
              </span>
              <select
                aria-label="桌面主题"
                value={theme}
                onChange={(e) => changeTheme(e.target.value)}
              >
                <option value="system">跟随系统</option>
                <option value="light">黑白灰</option>
                <option value="dark">深色石墨</option>
                <option value="blue">冷灰蓝</option>
              </select>
            </label>
            <button disabled={disabled} onClick={startDemo}>
              <Icon name="terminal" /> 离线演示
            </button>
            <div className="local">
              <Icon name="monitor" size={14} />
              {runtime?.demo ? '离线演示 · FakeProvider' : runtime ? '本地运行' : '未打开项目'}
              <span>v0.1</span>
            </div>
          </div>
        </aside>
      )}
      <main
        className={
          'workspace ' + (view === 'chat' && runtime?.rows.length === 0 ? 'welcome-workspace' : '')
        }
      >
        <header className="heading">
          <div className="heading-main" title={runtime?.cwd}>
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="显示侧栏"
                onClick={() => setSidebar(true)}
              >
                <Icon name="sidebar" />
              </button>
            )}
            {view === 'chat' && runtime && (
              <span className="breadcrumb">
                <Icon name="folder" size={14} />
                {runtime.projectName}
                <span>/</span>
              </span>
            )}
            <h1>
              {view === 'projects'
                ? '项目'
                : view === 'settings'
                  ? '设置'
                  : (runtime?.title ?? 'agentlab')}
            </h1>
          </div>
          <div className="header-actions">
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="打开应用设置"
                title="设置"
                onClick={() => navigate('settings')}
              >
                <Icon name="settings" />
              </button>
            )}
            <span className="tag" role="status">
              {state.connecting ? '正在打开项目' : (runtime?.phase ?? '就绪')}
            </span>
            {view === 'chat' && (
              <button
                aria-label="收起或显示检查栏"
                title="收起或显示检查栏"
                onClick={() => setInspector(!inspector)}
                className={'workspace-toggle ' + (inspector ? 'active' : '')}
              >
                <Icon name="panel" /> <span>工作区</span>
              </button>
            )}
          </div>
        </header>
        {allError && (
          <div className="error-banner" role="alert">
            {allError}
          </div>
        )}
        {view === 'projects' ? (
          <section className="projects-page">
            <div className="projects-intro">
              <span className="home-mark">
                <Icon name="terminal" size={30} />
              </span>
              <h2>从项目开始。</h2>
              <p>选择一个项目继续工作，模型与连接默认使用全局设置。</p>
              <div className="project-intro-actions">
                <button className="primary" disabled={disabled} onClick={choose}>
                  <Icon name="plus" /> 添加本地项目
                </button>
                <button className="outline" onClick={() => navigate('settings')}>
                  设置模型
                </button>
              </div>
            </div>
            <div className="projects-list-heading">
              <h3>我的项目</h3>
              <span className="small">{state.projects.length} 个项目</span>
            </div>
            <div className="project-cards">
              {state.projects.map((project) => {
                const current = runtime?.cwd === project.path;
                return (
                  <button
                    key={project.id}
                    className="project-card"
                    disabled={disabled && !current}
                    onClick={() => openProject(project.id)}
                  >
                    <span className="project-card-icon">
                      <Icon name="folder" size={22} />
                    </span>
                    <span className="project-card-info">
                      <strong>{project.name}</strong>
                      <code>{project.path}</code>
                      <small>
                        {current
                          ? runtime.sessions.length + ' 个已保存会话 · ' + runtime.phase
                          : project.lastSessionId
                            ? '继续上次会话'
                            : '打开项目工作区'}
                      </small>
                    </span>
                    <span className="tag">
                      {current ? '当前项目' : project.demo ? '离线演示' : '本地'}
                    </span>
                    <Icon name="chevron" />
                  </button>
                );
              })}
            </div>
            {!state.projects.length && (
              <div className="projects-empty">
                <p>还没有添加项目。选择代码所在的文件夹即可开始。</p>
                <button className="outline" disabled={disabled} onClick={startDemo}>
                  先试离线演示项目
                </button>
              </div>
            )}
            {runtime?.busy && (
              <div className="info">
                {runtime.projectName} · {runtime.phase}。点击当前项目返回处理任务或审批。
              </div>
            )}
          </section>
        ) : view === 'settings' ? (
          <SettingsPanel
            key={runtime?.generation ?? 'preferences'}
            runtime={runtime}
            globalSettings={state.globalSettings}
            globalRequest={async (payload) => {
              if (!bridge.globalSettingsRequest || !state.globalSettings)
                throw new Error('全局设置尚未就绪，请重新打开 App。');
              const action =
                payload.type === 'settings-read'
                  ? { type: 'read', sectionId: payload.sectionId }
                  : { type: 'commit', editorId: payload.editorId, json: payload.json };
              await bridge.globalSettingsRequest({
                ...action,
                generation: state.globalSettings.generation,
              } as import('../shared/protocol.js').GlobalSettingsAction);
            }}
            request={action}
            dirtyChanged={dirtyChanged}
            theme={theme}
            changeTheme={changeTheme}
          />
        ) : (
          <>
            <div
              className="conversation"
              ref={scroll}
              onScroll={() => {
                const el = scroll.current;
                if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {!runtime ? (
                <div className="welcome">
                  <span className="eyebrow">agentlab / local workspace</span>
                  <h2>从一个具体任务开始。</h2>
                  <p>打开你的项目，让 agent 帮你阅读代码、执行任务，并检查结果。</p>
                  <div className="welcome-actions">
                    <button
                      className="primary"
                      disabled={pending || state.connecting}
                      onClick={choose}
                    >
                      打开本地项目
                    </button>
                    <button
                      className="outline"
                      disabled={pending || state.connecting}
                      onClick={() => void perform(() => bridge.startDemo())}
                    >
                      先试离线演示
                    </button>
                  </div>
                  <p className="small">离线演示使用专用目录与 FakeProvider，不使用真实模型。</p>
                </div>
              ) : runtime.rows.length === 0 ? (
                <div className="welcome">
                  <span className="home-mark">
                    <Icon name="terminal" size={30} />
                  </span>
                  <h2>一起把想法变成代码。</h2>
                  <p>
                    {runtime.demo
                      ? '在隔离项目里，试试你的第一个任务。'
                      : '从 ' + runtime.projectName + ' 开始，描述你想完成的事。'}
                  </p>
                </div>
              ) : (
                runtime.rows.map((row) => (
                  <MessageRow key={row.id} row={row} openFile={openFile} disabled={disabled} />
                ))
              )}
            </div>
            {runtime?.approvals[0] && (
              <div className="approval-dock">
                <ApprovalCard
                  key={runtime.approvals[0].id}
                  approval={runtime.approvals[0]}
                  disabled={pending}
                  respond={(allow, feedback) =>
                    void perform(() =>
                      action({
                        type: 'approve',
                        approvalId: runtime.approvals[0].id,
                        allow,
                        feedback,
                      }),
                    )
                  }
                />
                {runtime.approvals.length > 1 && (
                  <p className="small">另有 {runtime.approvals.length - 1} 个审批排队等待</p>
                )}
              </div>
            )}
            {runtime?.interaction && (
              <div className="approval-dock">
                <InteractionCard
                  key={runtime.interaction.id}
                  interaction={runtime.interaction}
                  respond={(value) =>
                    void perform(() =>
                      action({ type: 'interact', interactionId: runtime.interaction!.id, value }),
                    )
                  }
                />
              </div>
            )}
            <footer className="composer-wrap">
              <div className="composer">
                <textarea
                  aria-label="输入任务"
                  placeholder={
                    runtime ? '向 agentlab 提问，或描述一个任务…' : '先打开一个本地项目…'
                  }
                  value={prompt}
                  disabled={!runtime || state.connecting}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (!busy) submit();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <div className="controls">
                    <select
                      aria-label="当前模型"
                      disabled={disabled || !runtime}
                      value={runtime?.model ?? ''}
                      onChange={(e) => setting('model', e.target.value)}
                    >
                      {runtime?.models.map((m) => (
                        <option key={m} value={m}>
                          {runtime.modelDetails?.find((model) => model.id === m)?.displayName ?? m}
                        </option>
                      )) ?? <option>未配置模型</option>}
                    </select>
                    <select
                      aria-label="权限模式"
                      disabled={disabled || !runtime}
                      value={runtime?.mode ?? 'ask'}
                      onChange={(e) => setting('mode', e.target.value)}
                    >
                      {['ask', 'auto', 'yolo'].map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                    <select
                      aria-label="思考等级"
                      disabled={disabled || !runtime}
                      value={runtime?.thinking ?? 'off'}
                      onChange={(e) => setting('think', e.target.value)}
                    >
                      {['off', 'low', 'medium', 'high'].map((m) => (
                        <option key={m} value={m}>
                          思考 {m}
                        </option>
                      ))}
                    </select>
                  </div>
                  {runtime?.busy ? (
                    <button
                      className="primary send-button"
                      aria-label="停止任务"
                      title="停止任务"
                      disabled={pending || runtime.phase === '正在停止'}
                      onClick={() => void perform(() => action({ type: 'stop' }))}
                    >
                      <Icon name="stop" size={14} />
                    </button>
                  ) : (
                    <button
                      className="primary send-button"
                      aria-label="发送任务"
                      title="发送任务"
                      disabled={disabled || !runtime || !prompt.trim()}
                      onClick={submit}
                    >
                      <Icon name="arrow" size={17} />
                    </button>
                  )}
                </div>
              </div>
              <div className="hint">
                <span className="context" title={runtime?.cwd}>
                  <Icon name="folder" size={13} />
                  {runtime?.projectName ?? '未选择项目'}
                  <span>·</span>
                  {runtime?.demo ? '离线' : '本地'}
                </span>
                <span>
                  {runtime
                    ? (
                        runtime.usage.inputTokens +
                        runtime.usage.outputTokens +
                        runtime.usage.cacheReadTokens +
                        runtime.usage.cacheWriteTokens
                      ).toLocaleString() + ' tokens'
                    : '本地工作台'}
                </span>
              </div>
              {runtime?.rows.length === 0 && (
                <div className="starter-prompts">
                  <button
                    className="suggestion"
                    onClick={() =>
                      setPrompt(
                        runtime.demo
                          ? '演示读取、审批和写入文件'
                          : '阅读 README.md，解释这个项目的架构',
                      )
                    }
                  >
                    <Icon name="code" />
                    {runtime.demo ? '试试工具审批' : '理解这个项目'}
                  </button>
                  <button
                    className="suggestion"
                    onClick={() =>
                      setPrompt(
                        runtime.demo
                          ? '演示 Markdown 排版'
                          : '检查项目里的测试，说明如何运行和验证',
                      )
                    }
                  >
                    <Icon name="terminal" />
                    {runtime.demo ? '表格与代码示例' : '运行与验证'}
                  </button>
                </div>
              )}
            </footer>
          </>
        )}
      </main>
      {inspector && view === 'chat' && (
        <aside className="inspector">
          <nav className="tabs" aria-label="检查面板">
            {[
              ['diff', '改动'],
              ['files', '文件'],
              ['logs', '执行记录'],
            ].map(([id, label]) => (
              <button
                key={id}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id as typeof tab)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="inspect-body">
            {tab === 'logs' ? (
              <>
                <div className="inspect-title">工具执行记录</div>
                {runtime?.rows
                  .filter((r) => r.kind === 'tool')
                  .map((row) => (
                    <div className="execution" key={row.id}>
                      <strong>{row.toolName}</strong>
                      <span className="small">
                        {row.status}{' '}
                        {row.durationMs !== undefined
                          ? '· ' + (row.durationMs / 1000).toFixed(1) + 's'
                          : ''}
                      </span>
                      <pre>{row.text}</pre>
                    </div>
                  ))}
                <p className="inspect-note">仅展示工具过程和输出，首版不提供手动终端输入。</p>
              </>
            ) : (
              <>
                <div className="inspect-title">
                  <span>{tab === 'diff' ? 'Git 工作区差异' : '项目文件'}</span>
                  <button
                    className="outline compact"
                    disabled={disabled || !runtime}
                    onClick={() => inspect(tab === 'diff' ? 'diff' : 'files')}
                  >
                    刷新
                  </button>
                </div>
                {tab === 'diff' ? (
                  <>
                    <details className="inspect-scope">
                      <summary>检查范围</summary>
                      <p className="small">
                        相对 HEAD 的普通已跟踪文件，包含用户原有修改。最多检查 200
                        个可读文件；不含隐藏、忽略、已删除与未跟踪文件。首次检查可能需要审批。
                      </p>
                    </details>
                    {runtime?.inspection.kind === 'diff' ? (
                      <pre className="diff">
                        {runtime.inspection.content.split('\n').map((line, i) => (
                          <span
                            key={i}
                            className={
                              line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''
                            }
                          >
                            {line || ' '}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <div className="inspect-empty">
                        <Icon name="code" size={28} />
                        <strong>查看工作区改动</strong>
                        <p>点击刷新，检查当前项目相对 HEAD 的差异。</p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="file-list">
                      {files.map((path) => (
                        <button
                          key={path}
                          disabled={disabled}
                          onClick={() => openFile(path)}
                          title={path}
                        >
                          {path}
                        </button>
                      ))}
                    </div>
                    {runtime?.inspection.kind === 'read' ? (
                      <div className="file-preview">
                        <h4>{runtime.inspection.path}</h4>
                        <pre>{runtime.inspection.content}</pre>
                      </div>
                    ) : (
                      <p className="small">
                        {files.length
                          ? files.length + ' 个文件（最多 200 个）'
                          : '点击刷新，通过现有 glob 工具获取文件列表。'}
                      </p>
                    )}
                  </>
                )}
                {runtime?.inspection.error && (
                  <p className="error-text">检查未完成，保留工具返回结果。</p>
                )}
              </>
            )}
          </div>
          <div className="inspector-footer">
            <Icon name="folder" size={13} /> {runtime?.projectName ?? '本地工作区'}
          </div>
        </aside>
      )}
      <datalist id="models">
        {runtime?.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </div>
  );
}
