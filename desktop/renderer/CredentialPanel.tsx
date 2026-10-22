import { useEffect, useState } from 'react';
import type { CredentialStatus, SettingsSnapshot } from '../shared/protocol.js';
import { getBridge } from './bridge.js';

/** 明文只停留在用户正在输入的密码控件和白名单保存调用；读取只返回状态。 */
export function CredentialPanel({
  settings,
  blocked,
  dirtyChanged,
  refresh,
}: {
  settings: SettingsSnapshot;
  blocked: boolean;
  dirtyChanged: (v: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(
    settings.provider === 'fake' ? 'openai' : settings.provider,
  );
  const [status, setStatus] = useState<CredentialStatus>(),
    [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState(false);
  const bridge = getBridge();
  const read = async () => {
    setError('');
    try {
      if (!bridge.credentialStatus) throw new Error('此预览不提供系统安全存储；请在 App 中配置。');
      setStatus(await bridge.credentialStatus(provider));
    } catch (e) {
      setStatus(undefined);
      setError(e instanceof Error ? e.message : '安全存储读取失败。');
    }
  };
  useEffect(() => {
    setKey('');
    dirtyChanged(false);
    setSaved(false);
    void read();
  }, [provider, settings.providerOptions?.join('|')]);
  useEffect(() => () => dirtyChanged(false), []);
  const save = async (clear = false) => {
    if (!status || pending || blocked) return;
    if (
      clear &&
      !window.confirm(
        '清除这个全局连接保存的 API key？所有使用该凭据的项目下次装配将受影响，并恢复原环境变量方式（含 SDK 默认变量）；不会删除环境变量。',
      )
    )
      return;
    setPending(true);
    setError('');
    setSaved(false);
    try {
      if (!bridge.saveCredential) throw new Error('安全存储不可用。');
      await bridge.saveCredential(status.token, clear ? null : key);
      setKey('');
      dirtyChanged(false);
      await refresh();
      await read();
      setSaved(true);
    } catch (e) {
      const feedback = e instanceof Error ? e.message : '密钥保存失败。';
      await read();
      setError(feedback);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="credential-panel" aria-label="全局 API key">
      <header>
        <div>
          <h3>API key</h3>
          <p className="small">直接输入，所有项目共享。保存后重新装配连接或重启 App 采用。</p>
        </div>
        <span className="tag">全局安全存储</span>
      </header>
      <div className="credential-form">
        <label>
          Provider
          <select
            aria-label="密钥所属 Provider"
            value={provider}
            disabled={pending || !!key}
            onChange={(e) => setProvider(e.target.value)}
          >
            {(settings.providerOptions ?? settings.providers)
              .filter((id) => id !== 'fake')
              .map((id) => (
                <option key={id} value={id}>
                  {settings.providerLabels?.[id] ?? id}
                </option>
              ))}
          </select>
        </label>
        <label>
          API key
          <input
            aria-label="直接输入 API key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            placeholder={status?.configured ? '已设置 · 输入以替换' : '粘贴或输入 API key'}
            disabled={pending || !status?.available}
            onChange={(e) => {
              setKey(e.target.value);
              dirtyChanged(!!e.target.value);
              setSaved(false);
            }}
          />
        </label>
      </div>
      <p className="small credential-endpoint">
        绑定端点：{status?.endpoint ?? '请先保存连接'} ·{' '}
        {status?.configured ? '已保存，明文不会返回界面' : '尚未保存'}
      </p>
      <p className="small">
        {status?.available
          ? `使用 Electron safeStorage（${status.backend}）加密，密文保存在 ~/.agentlab/credentials.enc.json；配置文件仅保存随机引用。`
          : '系统安全存储不可用或未解锁，禁止保存明文。Linux 需 Secret Service/KWallet。环境变量仍可作为高级方式。'}
      </p>
      {blocked && (
        <p role="status" className="info">
          请先提交上方连接设置，再保存 API key；密钥绑定已保存的 Provider 与端点。
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {saved && <p role="status">API key 已{status?.configured ? '加密保存' : '清除'}。</p>}
      <div className="credential-actions">
        <button
          type="button"
          className="primary"
          disabled={!key || !status?.available || pending || blocked}
          onClick={() => void save()}
        >
          {pending ? '正在保存…' : '保存 API key'}
        </button>
        <button
          type="button"
          disabled={!status?.configured || pending || blocked}
          onClick={() => void save(true)}
        >
          清除保存的 key
        </button>
        {key && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setKey('');
              dirtyChanged(false);
            }}
          >
            取消输入
          </button>
        )}
      </div>
    </section>
  );
}
