import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge, RemoteHostSummary } from '../shared/protocol.js';
import { Icon } from './Icon.js';

export function RemoteHostForm({
  bridge,
  close,
  saved,
}: {
  bridge: DesktopBridge;
  close: () => void;
  saved: () => void;
}) {
  const [target, setTarget] = useState(''),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await bridge.addRemoteHost!({
        target: target.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      saved();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : '主机连接验证失败，请检查 SSH 配置。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="remote-dialog-backdrop">
      <section
        className="remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-host-title"
      >
        <h2 id="remote-host-title">添加 SSH 主机</h2>
        <p>先保存主机连接。添加后，在主机的“打开项目”中选择远程目录。</p>
        <label>
          SSH 主机
          <input
            autoFocus
            aria-label="SSH 主机"
            placeholder="dev-server 或 ubuntu@10.100.0.8"
            value={target}
            disabled={busy}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <label>
          主机名称（可选）
          <input
            aria-label="主机名称"
            placeholder="例如：开发服务器"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="small">使用本机已有的 SSH 密钥和主机信任配置。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="outline" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || !target.trim()} onClick={() => void add()}>
            {busy ? '验证连接中…' : '添加主机'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function RemoteProjectPicker({
  bridge,
  hosts,
  initialHostId,
  close,
  opened,
  status,
  purpose = 'open-project',
  selectedDirectory,
}: {
  bridge: DesktopBridge;
  hosts: RemoteHostSummary[];
  initialHostId?: string;
  close: () => void;
  opened: () => void;
  status?: string;
  purpose?: 'open-project' | 'new-session' | 'select-directory';
  selectedDirectory?: (selection: { hostId?: string; path: string }) => void;
}) {
  const [hostId, setHostId] = useState(initialHostId ?? hosts[0]?.id ?? 'local');
  const host = hosts.find((h) => h.id === hostId);
  const [path, setPath] = useState(''),
    [listedPath, setListedPath] = useState(''),
    [directories, setDirectories] = useState<string[]>([]);
  const [operation, setOperation] = useState<'listing' | 'opening'>(),
    [error, setError] = useState('');
  const [connections, setConnections] = useState<
      Array<{ id: string; label: string; model: string }>
    >([]),
    [connection, setConnection] = useState(''),
    [advanced, setAdvanced] = useState('{}');
  const sequence = useRef(0);
  const browse = async (next: string) => {
    if (!host || !bridge.pickRemoteDirectory) return;
    const id = ++sequence.current;
    setOperation('listing');
    setError('');
    try {
      const values = await bridge.pickRemoteDirectory({ hostId: host.id, path: next });
      if (id !== sequence.current) return;
      setDirectories(values);
      setListedPath(next);
      setPath(next);
    } catch (e) {
      if (id === sequence.current) setError(e instanceof Error ? e.message : '目录读取失败。');
    } finally {
      if (id === sequence.current) setOperation(undefined);
    }
  };
  useEffect(() => {
    setDirectories([]);
    setListedPath('');
    setPath(host?.home ?? '');
    setError('');
    if (host) void browse(host.home);
    return () => {
      sequence.current++;
    };
  }, [hostId]);
  useEffect(() => {
    if (purpose === 'select-directory') return;
    let current = true;
    void bridge
      .remoteConnections?.()
      .then((values) => {
        if (current) {
          setConnections(values);
          setConnection(values[0]?.id ?? '');
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [bridge]);
  const open = async () => {
    setOperation('opening');
    setError('');
    try {
      if (purpose === 'select-directory') {
        const selected = host ? listedPath : await bridge.pickDirectory();
        if (selected) {
          selectedDirectory?.({ hostId: host?.id, path: selected });
          close();
        }
        return;
      }
      if (!host) {
        await bridge.pickProject(purpose === 'new-session' ? { newSession: true } : undefined);
      } else {
        const mappings: unknown = JSON.parse(advanced);
        if (
          !mappings ||
          typeof mappings !== 'object' ||
          Array.isArray(mappings) ||
          Object.values(mappings).some((v) => typeof v !== 'string')
        )
          throw new Error('Provider 映射须为 JSON 对象。');
        await bridge.openRemoteProject!({
          hostId: host.id,
          path: listedPath,
          mappings: {
            ...(mappings as Record<string, string>),
            ...(connection ? { $default: connection } : {}),
          },
          ...(purpose === 'new-session' ? { newSession: true } : {}),
        });
      }
      opened();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : '项目打开失败。');
    } finally {
      setOperation(undefined);
    }
  };
  const parent = listedPath.slice(0, listedPath.lastIndexOf('/')) || '/';
  return (
    <div className="remote-dialog-backdrop">
      <section
        className="remote-dialog remote-project-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-project-title"
      >
        <h2 id="remote-project-title">
          {purpose === 'select-directory'
            ? '选择父目录'
            : purpose === 'new-session'
              ? '为新会话选择项目'
              : '打开项目'}
        </h2>
        <label>
          项目位置
          <select
            aria-label="项目位置"
            value={hostId}
            disabled={!!operation}
            onChange={(e) => setHostId(e.target.value)}
          >
            <option value="local">本机</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} · {h.target}
              </option>
            ))}
          </select>
        </label>
        {host ? (
          <>
            <div className="remote-path-field">
              <label htmlFor="remote-directory-path">远程目录</label>
              <div className="remote-path-control">
                <button
                  className="outline"
                  aria-label="上一级目录"
                  disabled={!!operation || !listedPath || listedPath === '/'}
                  onClick={() => void browse(parent)}
                >
                  上一级
                </button>
                <input
                  id="remote-directory-path"
                  aria-label="远程目录"
                  value={path}
                  disabled={!!operation}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !operation && path.startsWith('/')) void browse(path);
                  }}
                />
                <button
                  className="outline"
                  disabled={!!operation || !path.startsWith('/')}
                  onClick={() => void browse(path)}
                >
                  转到
                </button>
              </div>
            </div>
            <div
              className="remote-directory-list"
              aria-label="远程目录列表"
              aria-busy={operation === 'listing'}
            >
              {operation === 'listing' ? (
                <p className="small">正在读取远程目录…</p>
              ) : (
                directories
                  .filter((p) => p !== listedPath)
                  .sort((a, b) => a.localeCompare(b))
                  .map((directory) => (
                    <button
                      key={directory}
                      className="remote-directory-entry"
                      aria-label={'进入目录 ' + directory.split('/').filter(Boolean).at(-1)}
                      onClick={() => void browse(directory)}
                      disabled={!!operation}
                    >
                      <Icon name="folder" />
                      <span>{directory.split('/').filter(Boolean).at(-1) ?? directory}</span>
                      <Icon name="chevron" />
                    </button>
                  ))
              )}
              {operation !== 'listing' &&
                listedPath &&
                directories.every((p) => p === listedPath) && (
                  <p className="small">当前目录没有子文件夹，可以直接打开此目录。</p>
                )}
            </div>
            <p className="small remote-selected-path">
              项目目录：<code>{listedPath || '请选择目录'}</code>
            </p>
            {purpose !== 'select-directory' && (
              <details>
                <summary>模型连接（本机）</summary>
                <label>
                  本机模型连接
                  <select
                    aria-label="本机模型连接"
                    value={connection}
                    disabled={!!operation}
                    onChange={(e) => setConnection(e.target.value)}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} · {c.model}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  高级 Provider 映射
                  <textarea
                    aria-label="Provider 映射"
                    value={advanced}
                    disabled={!!operation}
                    onChange={(e) => setAdvanced(e.target.value)}
                  />
                </label>
              </details>
            )}
          </>
        ) : (
          <p>选择本机文件夹，在本地工作区打开项目。</p>
        )}
        {operation === 'opening' && (
          <p className="small" role="status">
            {status ?? '正在打开项目…'}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button
            className="outline"
            onClick={() => {
              if (operation === 'opening') void bridge.cancelRemoteConnection?.().then(close);
              else close();
            }}
          >
            取消
          </button>
          <button
            className="primary"
            disabled={!!operation || (!!host && (!listedPath || listedPath !== path))}
            onClick={() => void open()}
          >
            {operation === 'opening'
              ? '打开中…'
              : host
                ? purpose === 'select-directory'
                  ? '选择此目录'
                  : purpose === 'new-session'
                    ? '在此项目新建会话'
                    : '打开此目录为项目'
                : '选择本机文件夹'}
          </button>
        </div>
      </section>
    </div>
  );
}
