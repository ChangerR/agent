import { useState } from 'react';
import type { DesktopBridge, ProjectSummary, RemoteHostSummary } from '../shared/protocol.js';
import { RemoteProjectPicker } from './RemoteHosts.js';
import { Icon } from './Icon.js';

export function NewSessionChooser({
  projects,
  hosts,
  currentProjectId,
  close,
  select,
  openDirectory,
  createProject,
}: {
  projects: ProjectSummary[];
  hosts: RemoteHostSummary[];
  currentProjectId?: string;
  close: () => void;
  select: (id: string) => Promise<void>;
  openDirectory: () => void;
  createProject?: () => void;
}) {
  const [location, setLocation] = useState('all'),
    [search, setSearch] = useState(''),
    [busy, setBusy] = useState<string>(),
    [error, setError] = useState('');
  const visible = projects.filter(
    (p) =>
      (location === 'all' || (location === 'local' ? !p.remote : p.remoteHostId === location)) &&
      `${p.name} ${p.path} ${p.remote?.target ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  const choose = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      await select(id);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : '会话创建失败。');
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="remote-dialog-backdrop">
      <section
        className="remote-dialog new-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
      >
        <h2 id="new-session-title">新建会话</h2>
        <p>选择这次会话的项目。新会话从空白上下文开始。</p>
        <div className="new-session-filters">
          <label>
            工作位置
            <select
              aria-label="会话工作位置"
              value={location}
              disabled={!!busy}
              onChange={(e) => setLocation(e.target.value)}
            >
              <option value="all">全部项目</option>
              <option value="local">本机</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} · SSH
                </option>
              ))}
            </select>
          </label>
          <label>
            搜索项目
            <input
              autoFocus
              aria-label="搜索会话项目"
              placeholder="名称或目录"
              value={search}
              disabled={!!busy}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="new-session-projects" aria-label="会话项目列表">
          {visible.map((p) => (
            <button
              key={p.id}
              className="new-session-project"
              aria-label={'在项目 ' + p.name + ' 中新建会话'}
              disabled={!!busy}
              onClick={() => void choose(p.id)}
            >
              <Icon name="folder" />
              <span className="new-session-project-info">
                <strong>
                  {p.name}
                  {p.id === currentProjectId && <small>当前项目</small>}
                </strong>
                <code>{p.path}</code>
              </span>
              <span className="tag">
                {busy === p.id
                  ? '创建中…'
                  : p.remote
                    ? (hosts.find((h) => h.id === p.remoteHostId)?.name ?? p.remote.target)
                    : '本机'}
              </span>
              <Icon name="chevron" />
            </button>
          ))}
          {!visible.length && (
            <p className="small">
              {projects.length ? '没有匹配的项目。' : '先选择项目目录，或新建项目。'}
            </p>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="new-session-options">
          <button className="outline" disabled={!!busy} onClick={openDirectory}>
            打开其他项目…
          </button>
          {createProject && (
            <button className="outline" disabled={!!busy} onClick={createProject}>
              新建项目…
            </button>
          )}
          <button className="outline new-session-cancel" disabled={!!busy} onClick={close}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}

export function NewProjectForm({
  bridge,
  hosts,
  initialHostId,
  close,
  created,
  status,
}: {
  bridge: DesktopBridge;
  hosts: RemoteHostSummary[];
  initialHostId?: string;
  close: () => void;
  created: () => void;
  status?: string;
}) {
  const [location, setLocation] = useState(initialHostId ?? 'local'),
    [name, setName] = useState(''),
    [parent, setParent] = useState(hosts.find((h) => h.id === initialHostId)?.home ?? ''),
    [browsing, setBrowsing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const host = hosts.find((h) => h.id === location);
  const browse = async () => {
    if (host) {
      setBrowsing(true);
      return;
    }
    const path = await bridge.pickDirectory();
    if (path) setParent(path);
  };
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await bridge.createProject!({
        location: host ? 'ssh' : 'local',
        ...(host ? { hostId: host.id } : {}),
        parentPath: parent,
        name,
      });
      created();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目创建失败。');
    } finally {
      setBusy(false);
    }
  };
  if (browsing)
    return (
      <RemoteProjectPicker
        bridge={bridge}
        hosts={hosts}
        initialHostId={host?.id ?? 'local'}
        purpose="select-directory"
        close={() => setBrowsing(false)}
        opened={() => {}}
        selectedDirectory={(selection) => {
          setLocation(selection.hostId ?? 'local');
          setParent(selection.path);
        }}
      />
    );
  return (
    <div className="remote-dialog-backdrop">
      <section
        className="remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
      >
        <h2 id="new-project-title">新建项目</h2>
        <p>创建项目目录后，直接开始一个空白会话。</p>
        <label>
          项目位置
          <select
            aria-label="新项目位置"
            value={location}
            disabled={busy}
            onChange={(e) => {
              setLocation(e.target.value);
              setParent(hosts.find((h) => h.id === e.target.value)?.home ?? '');
            }}
          >
            <option value="local">本机</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} · {h.target}
              </option>
            ))}
          </select>
        </label>
        <label>
          父目录
          <div className="new-project-parent">
            <input
              aria-label="新项目父目录"
              value={parent}
              disabled={busy}
              readOnly={!host}
              placeholder={host ? '远程绝对路径' : '请选择本机文件夹'}
              onChange={(e) => setParent(e.target.value)}
            />
            <button
              className="outline"
              disabled={busy}
              onClick={() => void browse().catch((e) => setError(e.message))}
            >
              浏览…
            </button>
          </div>
        </label>
        <label>
          项目名称
          <input
            autoFocus
            aria-label="新项目名称"
            value={name}
            disabled={busy}
            placeholder="my-project"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {parent && name && (
          <p className="small remote-selected-path">
            将创建：{parent.replace(/[\\/]$/, '')}/{name}
          </p>
        )}
        {busy && (
          <p className="small" role="status">
            {status ?? '正在创建项目与会话…'}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="outline" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="primary"
            disabled={busy || !parent || !name.trim()}
            onClick={() => void create()}
          >
            {busy ? '创建中…' : '创建项目并新建会话'}
          </button>
        </div>
      </section>
    </div>
  );
}
