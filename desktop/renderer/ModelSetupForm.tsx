import { useEffect, useState } from 'react';
import { getBridge } from './bridge.js';
import { MODEL_SERVICES, type ModelService, type ModelSetupView } from '../shared/model-setup.js';

/** 常用配置一次完成；明文密钥只留在密码控件与受信任的保存调用中。 */
export function ModelSetupForm({
  dirtyChanged,
  pendingChanged,
  refresh,
}: {
  dirtyChanged: (dirty: boolean) => void;
  pendingChanged: (pending: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [view, setView] = useState<ModelSetupView>();
  const [key, setKey] = useState(''),
    [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false);
  const markDirty = (value: boolean) => {
    setDirty(value);
    dirtyChanged(value);
  };
  const read = async (service?: ModelService) => {
    const bridge = getBridge();
    if (!bridge.readModelSetup) throw new Error('快速配置需要桌面 App；也可使用下方的高级设置。');
    const next = await bridge.readModelSetup(service);
    setView(next);
    setKey('');
    markDirty(false);
  };
  const load = async (service?: ModelService) => {
    setBusy(true);
    pendingChanged(true);
    setError('');
    setSaved(false);
    try {
      await read(service);
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败，请重试。');
    } finally {
      setBusy(false);
      pendingChanged(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      dirtyChanged(false);
      pendingChanged(false);
    };
  }, []);
  const update = (patch: Partial<ModelSetupView>) => {
    setView((v) => v && { ...v, ...patch });
    markDirty(true);
    setSaved(false);
  };
  const save = async () => {
    if (!view || busy) return;
    setBusy(true);
    pendingChanged(true);
    setError('');
    setSaved(false);
    try {
      const bridge = getBridge();
      if (!bridge.saveModelSetup) throw new Error('请在桌面 App 中保存。');
      await bridge.saveModelSetup({
        token: view.token,
        model: view.model,
        endpoint: view.endpoint,
        protocol: view.protocol,
        key,
      });
      setKey('');
      markDirty(false);
      await read(view.service);
      await refresh();
      setSaved(true);
    } catch (e) {
      // 保存令牌一次消费；保留用户草稿，重新读取身份/CAS 后才允许再次提交。
      const feedback = e instanceof Error ? e.message : '保存失败，请重试。';
      try {
        const fresh = await getBridge().readModelSetup?.(view.service);
        if (fresh)
          setView(
            (v) =>
              v && {
                ...v,
                token: fresh.token,
                configured: fresh.configured,
                available: fresh.available,
              },
          );
      } catch {}
      setError(feedback);
    } finally {
      setBusy(false);
      pendingChanged(false);
    }
  };
  const preset = view && view.service !== 'custom' ? MODEL_SERVICES[view.service] : undefined;
  return (
    <section className="model-setup" aria-label="快速模型配置">
      <div className="model-setup-intro">
        <h3>选一个服务，填入 API Key</h3>
        <p>DeepSeek、Kimi 已配好地址和模型。保存一次，所有项目都能使用。</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation();
            void load(view?.service);
          }
        }}
      >
        <fieldset disabled={busy}>
          <legend className="sr-only">模型服务</legend>
          <div className="model-service-choices" role="group" aria-label="选择模型服务">
            {(['deepseek', 'kimi', 'custom'] as const).map((service) => (
              <button
                key={service}
                type="button"
                aria-pressed={view?.service === service}
                onClick={() => {
                  if (view?.service === service) return;
                  if (dirty && !window.confirm('放弃未保存的模型配置并切换服务？')) return;
                  void load(service);
                }}
              >
                <strong>
                  {service === 'custom' ? '自定义服务' : MODEL_SERVICES[service].label}
                </strong>
                <span>{service === 'custom' ? '中转站、其他厂商' : '只需 API Key'}</span>
              </button>
            ))}
          </div>
          {view && (
            <>
              {view.service === 'kimi' && (
                <label>
                  API Key 来源
                  <select
                    aria-label="Kimi API Key 来源"
                    value={view.endpoint}
                    onChange={(e) => update({ endpoint: e.target.value, configured: false })}
                  >
                    <option value="https://api.moonshot.cn/v1">Kimi 中国站（moonshot.cn）</option>
                    <option value="https://api.moonshot.ai/v1">Kimi 国际站（moonshot.ai）</option>
                  </select>
                </label>
              )}
              {view.service === 'custom' && (
                <>
                  <label>
                    API 端点
                    <input
                      aria-label="API 端点"
                      type="url"
                      required
                      value={view.endpoint}
                      placeholder="https://example.com/v1"
                      onChange={(e) => update({ endpoint: e.target.value })}
                    />
                  </label>
                  <p className="field-hint">
                    填服务商提供的基础地址，不需要加 /chat/completions 或 /messages。
                  </p>
                  <label>
                    API 协议
                    <select
                      aria-label="API 协议"
                      value={view.protocol}
                      onChange={(e) =>
                        update({ protocol: e.target.value as ModelSetupView['protocol'] })
                      }
                    >
                      <option value="openai">OpenAI 兼容（大多数服务）</option>
                      <option value="anthropic">Anthropic Messages</option>
                    </select>
                  </label>
                  <label>
                    模型 ID
                    <input
                      aria-label="模型 ID"
                      required
                      value={view.model}
                      placeholder="服务商给出的模型名称"
                      onChange={(e) => update({ model: e.target.value })}
                    />
                  </label>
                </>
              )}
              <label>
                API Key{' '}
                <span className="model-key-status">
                  {view.configured ? '已加密保存' : '尚未配置'}
                </span>
                <input
                  aria-label="模型 API Key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  required={!view.configured}
                  disabled={!view.available}
                  value={key}
                  placeholder={
                    view.configured ? '已保存，留空继续使用；输入可替换' : '粘贴你的 API Key'
                  }
                  onChange={(e) => {
                    setKey(e.target.value);
                    markDirty(true);
                    setSaved(false);
                  }}
                />
              </label>
              <p className="field-hint">密钥保存在本机系统安全存储中，保存时不会发送模型请求。</p>
              {preset && (
                <div className="model-preset-summary">
                  <p>
                    默认模型 <strong>{view.model}</strong>
                  </p>
                  <details>
                    <summary>更换模型</summary>
                    <label>
                      选择模型
                      <select
                        aria-label="官方模型"
                        value={view.model}
                        onChange={(e) => update({ model: e.target.value })}
                      >
                        {!preset.models.some((id) => id === view.model) && (
                          <option value={view.model}>{view.model}（已有配置）</option>
                        )}
                        {preset.models.map((id, i) => (
                          <option key={id} value={id}>
                            {preset.labels[i]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </details>
                </div>
              )}
              {!view.available && (
                <p className="info" role="status">
                  系统安全存储不可用，请解锁后重新读取。密钥不会保存为明文。
                </p>
              )}
              <div className="model-setup-actions">
                <button
                  className="primary"
                  type="submit"
                  disabled={!view.available || (!key && !view.configured)}
                >
                  {busy ? '正在保存…' : '保存并设为默认'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!dirty || window.confirm('放弃未保存的配置并重新读取？'))
                      void load(view.service);
                  }}
                >
                  重新读取
                </button>
              </div>
            </>
          )}
        </fieldset>
      </form>
      {busy && !view && <p role="status">正在读取模型配置…</p>}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="credential-feedback" role="status">
          已保存。重新打开项目或重启 App 后使用新配置；项目已有单独配置时仍优先使用项目配置。
        </p>
      )}
      {!view && !busy && (
        <button type="button" onClick={() => void load()}>
          重新读取
        </button>
      )}
    </section>
  );
}
