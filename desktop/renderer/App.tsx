import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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
import { DebugPage } from './DebugPage.js';
import { RemoteHostForm, RemoteProjectPicker } from './RemoteHosts.js';
import { NewSessionChooser, NewProjectForm } from './NewSession.js';
const bridge = getBridge();
const empty: DesktopState = { version: 1, revision: -1, connecting: false, projects: [] };
type Theme = 'system' | 'light' | 'dark' | 'blue';
const DEFAULT_INSPECTOR_WIDTH = 380;
const clampInspectorWidth = (width: number) =>
  Math.max(300, Math.min(560, Math.round(width), Math.round(window.innerWidth * 0.55)));
const initialInspectorWidth = () => {
  try {
    const saved = Number(localStorage.getItem('agentlab-inspector-width'));
    return saved ? clampInspectorWidth(saved) : DEFAULT_INSPECTOR_WIDTH;
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
};
function pathFrom(row: Row) {
  try {
    const input = JSON.parse(row.input ?? '{}');
    return typeof input.path === 'string' ? input.path : undefined;
  } catch {
    return undefined;
  }
}
function inspectionGuidance(content: string) {
  if (content.includes('plan_step_required'))
    return '当前计划没有正在执行的步骤。请先让 agent 建立或继续计划步骤，再检查文件。';
  if (content.includes('task_read_only'))
    return '当前步骤只允许经过验证的专用读取，Git 差异命令不能执行；专用文件读取仍可继续。';
  return '请根据工具返回检查项目状态、Git 安装和当前权限。';
}
function formatSessionTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
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
function ConversationRows({
  rows,
  busy,
  openFile,
  disabled,
}: {
  rows: Row[];
  busy: boolean;
  openFile: (path: string) => void;
  disabled: boolean;
}) {
  const groups: Array<{ key: string; activity: boolean; rows: Row[] }> = [];
  for (const row of rows) {
    const activity = row.kind === 'tool' || row.kind === 'thinking';
    const previous = groups.at(-1);
    if (activity && previous?.activity) previous.rows.push(row);
    else groups.push({ key: row.id, activity, rows: [row] });
  }
  const knownGroups = useRef(new Set<string>());
  const expandedGroups = useRef(new Set<string>());
  useEffect(() => {
    for (const group of groups) {
      if (!group.activity || knownGroups.current.has(group.key)) continue;
      knownGroups.current.add(group.key);
      if (busy) expandedGroups.current.add(group.key);
    }
    if (!busy) expandedGroups.current.clear();
  }, [busy, groups]);
  return groups.map((group) => {
    if (!group.activity) {
      const row = group.rows[0];
      return <MessageRow key={row.id} row={row} openFile={openFile} disabled={disabled} />;
    }
    const expanded = expandedGroups.current.has(group.key);
    const latestTool = [...group.rows].reverse().find((row) => row.kind === 'tool');
    return (
      <details className="activity-group" key={group.key} open={expanded ? true : undefined}>
        <summary>
          <span className="activity-title">{expanded ? '正在执行' : '执行过程'}</span>
          <span className="activity-summary">
            {latestTool?.toolName ? latestTool.toolName + ' · ' : ''}
            {group.rows.length} 步
          </span>
        </summary>
        <div className="activity-rows">
          {group.rows.map((row) => (
            <MessageRow key={row.id} row={row} openFile={openFile} disabled={disabled} />
          ))}
        </div>
      </details>
    );
  });
}
export default function App() {
  const [state, setState] = useState(empty),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [view, setView] = useState<'projects' | 'chat'>('projects'),
    [tab, setTab] = useState<'diff' | 'files' | 'logs'>('diff');
  const [sessionSort, setSessionSort] = useState<'created' | 'updated'>(() => {
    try {
      return localStorage.getItem('agentlab-session-sort') === 'updated' ? 'updated' : 'created';
    } catch {
      return 'created';
    }
  });
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
    [files, setFiles] = useState<string[]>([]),
    [inspector, setInspector] = useState(false),
    [inspectorWidth, setInspectorWidth] = useState(initialInspectorWidth),
    [sidebar, setSidebar] = useState(() => window.innerWidth > 760);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [projectPicker, setProjectPicker] = useState<{
    hostId?: string;
    purpose?: 'open-project' | 'new-session';
  }>();
  const [newSessionOpen, setNewSessionOpen] = useState(false),
    [newProjectOpen, setNewProjectOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inspectorResizeStart = useRef<{ x: number; width: number } | undefined>(undefined);
  const workspaceScroll = useRef<Array<{ element: HTMLElement; top: number; left: number }>>([]);
  const settingsDirtyRef = useRef(false);
  const dirtyChanged = (dirty: boolean) => {
    settingsDirtyRef.current = dirty;
    void bridge.settingsDirty(dirty).catch(() => {});
  };
  const allowLeave = () =>
    !settingsDirtyRef.current || window.confirm('设置有未保存更改，放弃后继续？');
  const closeSettings = () => {
    if (!allowLeave()) return;
    dirtyChanged(false);
    setSettingsOpen(false);
    requestAnimationFrame(() => {
      for (const item of workspaceScroll.current) {
        if (!item.element.isConnected) continue;
        item.element.scrollTop = item.top;
        item.element.scrollLeft = item.left;
      }
      returnFocus.current?.focus({ preventScroll: true });
    });
  };
  const navigate = (next: typeof view | 'settings') => {
    if (next === 'settings') {
      if (debugOpen) {
        setDebugOpen(false);
        void action({ type: 'debug-close' }).catch(() => {});
      }
      if (!settingsOpen) {
        returnFocus.current = document.activeElement as HTMLElement | null;
        workspaceScroll.current = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.app .conversation, .app .inspect-body, .app .project-tree, .app .session-list, .app .projects-page',
          ),
        ).map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
      }
      setSettingsOpen(true);
      return;
    }
    if (!allowLeave()) return;
    dirtyChanged(false);
    setSettingsOpen(false);
    setView(next);
    if (window.innerWidth <= 650) setSidebar(false);
  };
  const scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const runtime = state.runtime,
    busy = state.connecting || !!runtime?.busy;
  const disabled = busy || pending;
  const disconnected = runtime?.remote?.connected === false;
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
    try {
      localStorage.setItem('agentlab-inspector-width', String(inspectorWidth));
    } catch {}
  }, [inspectorWidth]);
  useEffect(() => {
    const fit = () => setInspectorWidth((width) => clampInspectorWidth(width));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  useEffect(() => {
    setFiles([]);
    setDebugOpen(false);
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
    if (state.remoteHosts?.length) {
      const current = state.projects.find((p) => p.id === runtime?.projectId);
      setProjectPicker({ hostId: current?.remoteHostId });
      return;
    }
    void perform(async () => {
      await bridge.pickProject();
    });
  };
  const openProject = (id: string) => {
    if (!allowLeave()) return;
    if (
      (runtime?.projectId ?? runtime?.cwd) === id &&
      runtime?.phase !== '进程中断' &&
      runtime?.phase !== '连接中断'
    ) {
      setView('chat');
      return;
    }
    void perform(async () => {
      await bridge.openProject(id);
      setView('chat');
    });
  };
  useEffect(() => {
    if (runtime?.generation) {
      setView('chat');
      setSettingsOpen(false);
    }
  }, [runtime?.generation]);
  const startDemo = () => {
    if (!allowLeave()) return;
    void perform(async () => {
      await bridge.startDemo();
      setView('chat');
    });
  };
  const createSessionInProject = async (projectId: string) => {
    await bridge.newSession({ projectId });
    setView('chat');
  };
  const newSession = () => {
    if (!allowLeave()) return;
    setNewSessionOpen(true);
  };
  const submit = () => {
    const text = prompt.trim();
    if (!text || !runtime || disabled || runtime.remote?.connected === false) return;
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
      else if (!disabled) newSession();
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
  const sortedSessions = [...(runtime?.sessions ?? [])].sort((a, b) => {
    const field = sessionSort === 'created' ? 'createdAt' : 'updatedAt';
    return new Date(b[field]).getTime() - new Date(a[field]).getTime();
  });
  const workspace = (
    <div
      hidden={debugOpen}
      inert={settingsOpen || debugOpen}
      style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
      className={
        'app ' +
        (!inspector || view !== 'chat' ? 'inspector-closed ' : '') +
        (!sidebar ? 'sidebar-closed' : '')
      }
    >
      {sidebar && (
        <aside className="sidebar">
          <div className="brand">
            <button
              className="brand-home"
              aria-label="所有项目"
              onClick={() => navigate('projects')}
            >
              <span className="logo">
                <Icon name="terminal" size={17} />
              </span>
              <span className="brand-name">agentlab</span>
            </button>
            <button
              className="icon-button sidebar-toggle"
              aria-label="收起侧栏"
              onClick={() => setSidebar(false)}
            >
              <Icon name="sidebar" />
            </button>
          </div>
          <button className="nav-new" disabled={disabled} onClick={newSession}>
            <Icon name="plus" /> 新建会话
          </button>
          <nav className="project-tree" aria-label="项目列表">
            {state.projects.map((project) => (
              <div
                className={
                  'project-group ' +
                  ((runtime?.projectId ?? runtime?.cwd) === project.id ? 'selected' : '')
                }
                key={project.id}
              >
                <div className="project-entry-row">
                  <button
                    className="project-entry"
                    title={project.path}
                    aria-label={'打开项目 ' + project.name}
                    disabled={disabled && (runtime?.projectId ?? runtime?.cwd) !== project.id}
                    onClick={() => openProject(project.id)}
                  >
                    <Icon name={project.remote ? 'server' : 'folder'} />
                    <span className="project-entry-name">{project.name}</span>
                    {project.remote && (
                      <span className="remote-target">
                        {project.remote.target}
                        <span
                          className={
                            'remote-status ' +
                            ((runtime?.projectId ?? runtime?.cwd) === project.id &&
                            runtime?.remote?.connected
                              ? 'connected'
                              : '')
                          }
                          title={
                            (runtime?.projectId ?? runtime?.cwd) === project.id &&
                            runtime?.remote?.connected
                              ? '已连接'
                              : '未连接'
                          }
                        />
                      </span>
                    )}
                  </button>
                  {(runtime?.projectId ?? runtime?.cwd) === project.id && (
                    <div className="project-entry-actions">
                      <button
                        className="icon-button project-settings"
                        aria-label="设置当前项目"
                        title="项目设置"
                        onClick={() => navigate('settings')}
                      >
                        <Icon name="more" size={17} />
                      </button>
                      <button
                        className="icon-button project-new-session"
                        aria-label="新建当前项目会话"
                        title="新建会话"
                        disabled={disabled}
                        onClick={() => {
                          if (allowLeave()) void perform(() => createSessionInProject(project.id));
                        }}
                      >
                        <Icon name="plus" size={14} />
                      </button>
                    </div>
                  )}
                </div>
                {project.remote &&
                  !project.lastSessionId &&
                  (runtime?.projectId ?? runtime?.cwd) !== project.id && (
                    <div className="remote-empty">暂无会话</div>
                  )}
                {(runtime?.projectId ?? runtime?.cwd) === project.id && (
                  <div className="project-children">
                    <label className="session-sort">
                      <span>排序</span>
                      <select
                        aria-label="会话排序"
                        value={sessionSort}
                        onChange={(event) => {
                          const value = event.target.value as typeof sessionSort;
                          setSessionSort(value);
                          try {
                            localStorage.setItem('agentlab-session-sort', value);
                          } catch {}
                        }}
                      >
                        <option value="created">创建时间</option>
                        <option value="updated">最近使用</option>
                      </select>
                    </label>
                    <div className="session-list" aria-label={project.name + ' 的会话'}>
                      {runtime && !runtime.sessions.some((s) => s.id === runtime.sessionId) && (
                        <button className="active" onClick={() => navigate('chat')}>
                          <span>新会话</span>
                          <span className="session-meta">{runtime.phase}</span>
                        </button>
                      )}
                      {sortedSessions.map((s) => (
                        <button
                          key={s.id}
                          className={s.id === runtime?.sessionId ? 'active' : ''}
                          disabled={disabled}
                          onClick={() => {
                            if (!allowLeave()) return;
                            setView('chat');
                            if (s.id !== runtime?.sessionId)
                              void perform(() => action({ type: 'resume', id: s.id }));
                          }}
                        >
                          <span>{s.title || '未命名会话'}</span>
                          <span
                            className="session-meta"
                            title={`${s.messageCount} 条消息 · 最近使用 ${new Date(s.updatedAt).toLocaleString('zh-CN')}`}
                          >
                            {formatSessionTime(
                              sessionSort === 'created' ? s.createdAt : s.updatedAt,
                            )}
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
              <Icon name="settings" /> 设置
            </button>
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
            <h1>{view === 'projects' ? '项目' : (runtime?.title ?? 'agentlab')}</h1>
          </div>
          <div className="header-actions">
            {runtime?.remote && (
              <span className="remote-identity" title={runtime.remote.path}>
                SSH · {runtime.remote.target} · {runtime.remote.path} ·{' '}
                {runtime.remote.connected ? '本机代理模型' : '连接中断'}
              </span>
            )}
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
            {(state.connecting || (runtime && runtime.phase !== '就绪')) && (
              <span className="tag" role="status">
                {state.connecting ? (state.connectionStatus ?? '正在打开项目') : runtime?.phase}
              </span>
            )}
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
            <header className="projects-toolbar">
              <div>
                <span className="eyebrow">WORKSPACE / PROJECTS</span>
                <h2>项目目录</h2>
                <p>打开本机项目，或添加主机后选择远程项目。</p>
              </div>
              <div className="project-intro-actions">
                {bridge.addRemoteHost && (
                  <button
                    className="outline"
                    disabled={disabled}
                    onClick={() => setRemoteOpen(true)}
                  >
                    添加主机
                  </button>
                )}
                <button className="outline" onClick={() => navigate('settings')}>
                  <Icon name="settings" /> 模型设置
                </button>
                <button className="primary" disabled={disabled} onClick={choose}>
                  <Icon name="folder" /> 打开项目
                </button>
              </div>
            </header>
            {!!state.remoteHosts?.length && (
              <section className="remote-hosts-section" aria-label="SSH 主机">
                <div className="projects-list-heading">
                  <h3>远程主机</h3>
                  <span className="small">{state.remoteHosts.length} 台主机</span>
                </div>
                <div className="remote-host-cards">
                  {state.remoteHosts.map((host) => (
                    <article className="remote-host-card" key={host.id}>
                      <Icon name="folder" size={19} />
                      <div className="remote-host-info">
                        <strong>{host.name}</strong>
                        <code>{host.target}</code>
                        <span className="small">
                          {state.projects.filter((p) => p.remoteHostId === host.id).length} 个项目
                        </span>
                      </div>
                      <button
                        className="outline"
                        disabled={disabled}
                        aria-label={'打开主机项目 ' + host.name}
                        onClick={() => setProjectPicker({ hostId: host.id })}
                      >
                        打开项目
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}
            <div className="projects-list-heading">
              <h3>所有项目</h3>
              <span className="small">{state.projects.length} 个项目</span>
            </div>
            <div className="project-cards" aria-label="项目目录">
              {state.projects.map((project) => {
                const current = (runtime?.projectId ?? runtime?.cwd) === project.id;
                return (
                  <button
                    key={project.id}
                    className="project-card"
                    disabled={disabled && !current}
                    onClick={() => openProject(project.id)}
                  >
                    <span className="project-card-icon">
                      <Icon name="folder" size={19} />
                    </span>
                    <span className="project-card-info">
                      <strong>{project.name}</strong>
                      <code>{project.path}</code>
                    </span>
                    <span className="project-card-state">
                      <small>
                        {current
                          ? runtime!.sessions.length + ' 个会话 · ' + runtime!.phase
                          : project.lastSessionId
                            ? '继续上次会话'
                            : '打开工作区'}
                      </small>
                      <span className="tag">
                        {current
                          ? '当前项目'
                          : project.demo
                            ? '离线演示'
                            : project.remote
                              ? 'SSH · ' + project.remote.target
                              : '本地'}
                      </span>
                    </span>
                    <Icon name="chevron" />
                  </button>
                );
              })}
            </div>
            {!state.projects.length && (
              <div className="projects-empty">
                <Icon name="folder" size={24} />
                <div>
                  <h3>项目目录为空</h3>
                  <p>
                    {state.remoteHosts?.length
                      ? '从上方主机打开项目，或选择本机文件夹。'
                      : '先打开本机项目或添加 SSH 主机。'}
                  </p>
                </div>
                <div className="project-intro-actions">
                  <button className="primary" disabled={disabled} onClick={choose}>
                    <Icon name="plus" /> 添加项目
                  </button>
                  <button className="outline" disabled={disabled} onClick={startDemo}>
                    离线演示
                  </button>
                </div>
              </div>
            )}
            {runtime?.busy && (
              <div className="info">
                {runtime.projectName} · {runtime.phase}。点击当前项目返回处理任务或审批。
              </div>
            )}
          </section>
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
                  <div className="welcome-brand" aria-label="agentlab">
                    agent<span>lab</span>
                  </div>
                  <p>{runtime.projectName}</p>
                </div>
              ) : (
                <ConversationRows
                  key={runtime.generation + ':' + runtime.sessionId}
                  rows={runtime.rows}
                  busy={runtime.busy}
                  openFile={openFile}
                  disabled={disabled}
                />
              )}
              {runtime?.phase === '已停止' && (
                <div className="run-stopped" role="status">
                  本次执行已停止，可重新发送任务继续。
                </div>
              )}
            </div>
            {runtime?.approvals[0] && (
              <div className="approval-dock">
                <ApprovalCard
                  key={runtime.approvals[0].id}
                  approval={runtime.approvals[0]}
                  disabled={pending || disconnected}
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
                      disabled={disabled || disconnected || !runtime || !prompt.trim()}
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
                  {runtime?.demo ? '离线' : runtime?.remote ? '远程 SSH' : '本地'}
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
            </footer>
          </>
        )}
      </main>
      {inspector && view === 'chat' && (
        <aside className="inspector">
          <div
            className="inspector-resizer"
            role="separator"
            aria-label="调整检查面板宽度"
            aria-orientation="vertical"
            aria-valuemin={300}
            aria-valuemax={560}
            aria-valuenow={inspectorWidth}
            tabIndex={0}
            onPointerDown={(event) => {
              if (window.innerWidth <= 1100) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              inspectorResizeStart.current = { x: event.clientX, width: inspectorWidth };
            }}
            onPointerMove={(event) => {
              const start = inspectorResizeStart.current;
              if (start)
                setInspectorWidth(clampInspectorWidth(start.width + start.x - event.clientX));
            }}
            onPointerUp={(event) => {
              inspectorResizeStart.current = undefined;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onLostPointerCapture={() => {
              inspectorResizeStart.current = undefined;
            }}
            onDoubleClick={() => setInspectorWidth(clampInspectorWidth(DEFAULT_INSPECTOR_WIDTH))}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                setInspectorWidth((width) =>
                  clampInspectorWidth(width + (event.key === 'ArrowLeft' ? 20 : -20)),
                );
              } else if (event.key === 'Home') {
                event.preventDefault();
                setInspectorWidth(clampInspectorWidth(DEFAULT_INSPECTOR_WIDTH));
              }
            }}
          />
          <nav className="tabs" aria-label="检查面板">
            <div className="inspector-tabs">
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
            </div>
            <button
              className="icon-button inspector-close"
              aria-label="关闭检查面板"
              title="关闭检查面板"
              onClick={() => setInspector(false)}
            >
              <Icon name="close" size={14} />
            </button>
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
                        <header>
                          <h4>{runtime.inspection.path}</h4>
                          <button
                            className="icon-button"
                            aria-label="关闭文件预览"
                            title="返回文件列表"
                            onClick={() => inspect('files')}
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </header>
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
                {runtime?.inspection.error && runtime.inspection.kind === tab && (
                  <div className="inspection-error" role="alert">
                    <strong>检查被权限策略阻止</strong>
                    <p>{runtime.inspection.content}</p>
                    <p className="small">{inspectionGuidance(runtime.inspection.content)}</p>
                  </div>
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
  return (
    <>
      {debugOpen && runtime && (
        <DebugPage
          key={runtime.generation + ':' + runtime.sessionId}
          runtime={runtime}
          request={action}
          onBack={() => {
            setDebugOpen(false);
            void action({ type: 'debug-close' }).catch((e) => setError(e.message));
          }}
        />
      )}
      {settingsOpen && (
        <div className="settings-overlay">
          <SettingsPanel
            key={runtime?.generation ?? 'preferences'}
            onBack={closeSettings}
            appError={allError}
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
            onStartDemo={() => {
              if (!allowLeave()) return;
              dirtyChanged(false);
              setSettingsOpen(false);
              startDemo();
            }}
            onOpenDebug={() => {
              if (!allowLeave()) return;
              dirtyChanged(false);
              setSettingsOpen(false);
              setDebugOpen(true);
            }}
          />
        </div>
      )}
      {workspace}
      {remoteOpen && (
        <RemoteHostForm
          bridge={bridge}
          close={() => setRemoteOpen(false)}
          saved={() => setView('projects')}
        />
      )}
      {projectPicker && (
        <RemoteProjectPicker
          bridge={bridge}
          hosts={state.remoteHosts ?? []}
          initialHostId={projectPicker.hostId}
          purpose={projectPicker.purpose}
          close={() => setProjectPicker(undefined)}
          opened={() => setView('chat')}
          status={state.connectionStatus}
        />
      )}
      {newSessionOpen && (
        <NewSessionChooser
          projects={state.projects}
          hosts={state.remoteHosts ?? []}
          currentProjectId={runtime?.projectId ?? runtime?.cwd}
          close={() => setNewSessionOpen(false)}
          select={createSessionInProject}
          openDirectory={() => {
            setNewSessionOpen(false);
            setProjectPicker({
              hostId:
                state.projects.find((p) => p.id === runtime?.projectId)?.remoteHostId ?? 'local',
              purpose: 'new-session',
            });
          }}
          createProject={
            bridge.createProject
              ? () => {
                  setNewSessionOpen(false);
                  setNewProjectOpen(true);
                }
              : undefined
          }
        />
      )}
      {newProjectOpen && (
        <NewProjectForm
          bridge={bridge}
          hosts={state.remoteHosts ?? []}
          initialHostId={state.projects.find((p) => p.id === runtime?.projectId)?.remoteHostId}
          close={() => setNewProjectOpen(false)}
          created={() => setView('chat')}
          status={state.connectionStatus}
        />
      )}
    </>
  );
}
