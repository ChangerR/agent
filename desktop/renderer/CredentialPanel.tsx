import { useEffect, useState } from 'react';
import type { CredentialStatus, SettingsSnapshot } from '../shared/protocol.js';
import { getBridge } from './bridge.js';

/** 明文只停留在用户正在输入的密码控件和白名单保存调用；读取只返回状态。 */
export function CredentialPanel({
  settings,
  providerId,
  blocked,
  dirtyChanged,
  refresh,
}: {
  settings: SettingsSnapshot;
  providerId?: string;
  blocked: boolean;
  dirtyChanged: (v: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [choice, setProvider] = useState(
    settings.provider === 'fake' ? 'openai' : settings.provider,
  );
  const provider = providerId ?? choice;
  const [status, setStatus] = useState<CredentialStatus>(),
    [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [saved, setSaved] = useState(false);
  const bridge = getBridge();
  const read = async () => {
    setError('');
    if (blocked && !(settings.providerOptions ?? settings.providers).includes(provider)) {
      setStatus(undefined);
      return;
    }
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
          <p>加密保存，供所有项目使用。</p>
        </div>
        <span className={'credential-state ' + (status?.configured ? 'configured' : '')}>
          {status?.configured ? '已配置' : '未配置'}
        </span>
      </header>
      {!providerId && (
        <label className="credential-provider">
          服务连接
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
      )}
      <label className="credential-input">
        <span className="sr-only">API key</span>
        <input
          aria-label="直接输入 API key"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={key}
          placeholder={status?.configured ? '已设置 · 输入以替换' : '粘贴或输入 API key'}
          disabled={pending || blocked || !status?.available}
          onChange={(e) => {
            setKey(e.target.value);
            dirtyChanged(!!e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void save();
            }
          }}
        />
      </label>
      <p className="credential-endpoint">
        {settings.providerLabels?.[provider] ?? provider}
        <span>·</span>
        {status?.endpoint ?? '保存连接后可配置密钥'}
      </p>
      {blocked && (
        <p role="status" className="info">
          请先保存连接更改，再设置 API key。
        </p>
      )}
      {!blocked && !status?.available && !error && (
        <p role="status" className="info">
          安全存储不可用或未解锁，无法保存。可在下方查看说明并重新检查。
        </p>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="credential-feedback">
          API key 已{status?.configured ? '加密保存' : '清除'}。
        </p>
      )}
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
          className="text-button"
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
      <details className="credential-security">
        <summary>安全存储与生效方式</summary>
        <p>
          {status?.available
            ? `使用 Electron safeStorage（${status.backend}）加密；密文位于 ~/.agentlab/credentials.enc.json，普通配置仅存随机引用。`
            : '系统安全存储不可用时不会保存明文。Linux 需解锁 Secret Service/KWallet；basic_text 不被接受。'}
        </p>
        <p>
          保存后新打开项目、重新装配或重启采用。环境变量保留为高级方式；清除 key
          会恢复原环境变量方式。
        </p>
        <button
          type="button"
          className="text-button"
          disabled={pending || !!key}
          onClick={() => void read()}
        >
          重新检查安全存储
        </button>
      </details>
    </section>
  );
}
