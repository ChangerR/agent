/** 只保存 safeStorage 密文；配置中仅有随机引用。没有明文或 basic_text 降级。 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getGlobalConfigPath } from '../../src/core/paths.js';
import { loadConfigWithSources, type AgentConfig } from '../../src/core/config.js';
import {
  createScopedConfigStores,
  PluginConfigStore,
  type ConfigSnapshot,
} from '../../src/runtime/config-store.js';
import { assertManagedSettingsPath } from '../../src/builtin/settings-paths.js';
import type { CredentialStatus } from '../shared/protocol.js';

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type Entry = { binding: string; encrypted: string };
type Target = {
  provider: string;
  type: 'openai' | 'anthropic';
  endpoint: string;
  reference?: string;
};
const plugin = 'agentlab.provider-connections';
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function target(config: AgentConfig, provider: string): Target {
  const connections = config.pluginConfig[plugin]?.connections as
    Record<string, Record<string, unknown>> | undefined;
  const builtin = ['openai', 'anthropic'].includes(provider);
  const item = builtin
    ? config.pluginConfig['agentlab.provider-' + provider]
    : connections?.[provider];
  const type = builtin ? provider : item?.type;
  if (!['openai', 'anthropic'].includes(String(type)))
    throw new Error('此 Provider 不使用 API key；请先保存网络连接。');
  const endpoint = String(
    (builtin && config.provider === provider ? config.baseURL : undefined) ??
      (builtin ? undefined : item?.baseURL) ??
      (type === 'openai'
        ? process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
        : process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
  ).replace(/\/+$/, '');
  const url = new URL(endpoint);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('连接端点无效。');
  return {
    provider,
    type: type as Target['type'],
    endpoint,
    reference: item?.apiKeyRef as string | undefined,
  };
}
const binding = (t: Target) => JSON.stringify([t.provider, t.type, t.endpoint]);
export class CredentialVault {
  readonly path = join(dirname(getGlobalConfigPath()), 'credentials.enc.json');
  private store = new PluginConfigStore(this.path);
  constructor(
    private storage: SecureStorage,
    private platform = process.platform,
  ) {}
  status() {
    let backend = 'unavailable',
      available = false;
    try {
      available = this.storage.isEncryptionAvailable();
      backend =
        this.platform === 'linux'
          ? (this.storage.getSelectedStorageBackend?.() ?? 'unknown')
          : this.platform === 'darwin'
            ? 'macOS safeStorage'
            : 'Windows DPAPI';
    } catch {}
    return {
      backend,
      available:
        available &&
        (this.platform !== 'linux' ||
          ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(backend)),
    };
  }
  read() {
    assertManagedSettingsPath(dirname(this.path), this.path);
    const base = this.store.readDocument();
    for (const [key, value] of Object.entries(base.value))
      if (
        !/^cred_[a-f0-9]{32}$/.test(key) ||
        !record(value) ||
        typeof value.binding !== 'string' ||
        typeof value.encrypted !== 'string' ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value.encrypted)
      )
        throw new Error('加密凭据文件无效；未读取任何明文。');
    return base;
  }
  write(base: ConfigSnapshot, value: Record<string, unknown>) {
    assertManagedSettingsPath(dirname(this.path), this.path);
    return this.store.commitDocument(base, value);
  }
  encrypt(key: string, t: Target): Entry {
    if (!this.status().available)
      throw new Error(
        '系统安全存储不可用，API key 未保存。Linux 需要已解锁的 Secret Service/KWallet；不会写入明文。',
      );
    try {
      return { binding: binding(t), encrypted: this.storage.encryptString(key).toString('base64') };
    } catch {
      throw new Error('系统安全存储加密失败，API key 未保存。');
    }
  }
  resolve(config: AgentConfig): Record<string, { key: string; binding: string }> {
    const refs: Target[] = [];
    const active = new Set([
      config.provider,
      ...['agentlab.planning', 'agentlab.compaction-summary', 'agentlab.reviewer-model'].map((id) =>
        String(config.pluginConfig[id]?.provider ?? config.provider),
      ),
    ]);
    for (const provider of ['openai', 'anthropic'])
      if (active.has(provider) && config.pluginConfig['agentlab.provider-' + provider]?.apiKeyRef)
        refs.push(target(config, provider));
    const connections = config.pluginConfig[plugin]?.connections as
      Record<string, Record<string, unknown>> | undefined;
    for (const [id, item] of Object.entries(connections ?? {}))
      if (active.has(id) && item.enabled !== false && item.apiKeyRef) refs.push(target(config, id));
    if (!refs.length) return {};
    if (!this.status().available)
      throw new Error(
        '系统安全存储未解锁，无法读取保存的 API key。请打开全局设置检查；不会回退其他凭据。',
      );
    const base = this.read(),
      keys: Record<string, { key: string; binding: string }> = {};
    for (const t of refs) {
      const entry = base.value[t.reference!] as Entry | undefined;
      if (!entry || entry.binding !== binding(t))
        throw new Error(
          '保存的 API key 不存在或连接端点已变化。请在全局设置重新输入；不会向其他端点发送凭据。',
        );
      try {
        keys[t.reference!] = {
          key: this.storage.decryptString(Buffer.from(entry.encrypted, 'base64')),
          binding: entry.binding,
        };
      } catch {
        throw new Error('API key 解密失败，请解锁系统安全存储或重新输入。');
      }
    }
    return keys;
  }
}

export class CredentialSettings {
  private tokens = new Map<
    string,
    { target: Target; base: ConfigSnapshot; vault: ConfigSnapshot }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private cwd = join(dirname(getGlobalConfigPath()), '.settings-context');
  constructor(private vault: CredentialVault) {}
  read(provider: string): CredentialStatus {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(provider)) throw new Error('无效 Provider。');
    const loaded = loadConfigWithSources(this.cwd, {}, { globalOnly: true });
    const t = target(loaded.config, provider),
      store = createScopedConfigStores(this.cwd).store('global');
    const base = store.read(
      ['openai', 'anthropic'].includes(provider) ? 'agentlab.provider-' + provider : plugin,
    );
    const vault = this.vault.read(),
      token = randomUUID();
    this.tokens.clear();
    this.tokens.set(token, { target: t, base, vault });
    return {
      token,
      provider,
      endpoint: t.endpoint,
      configured:
        !!t.reference && (vault.value[t.reference] as Entry | undefined)?.binding === binding(t),
      ...this.vault.status(),
    };
  }
  async save(token: string, key: string | null) {
    const work = this.queue.then(() => {
      const saved = this.tokens.get(token);
      this.tokens.delete(token);
      if (!saved) throw new Error('密钥表单已过期，请重新读取。');
      if (
        key !== null &&
        (typeof key !== 'string' || !key.trim() || key.length > 16384 || /[\u0000\r\n]/.test(key))
      )
        throw new Error('API key 不能为空或包含换行；清除请使用清除按钮。');
      const t = saved.target,
        old = t.reference ? (saved.vault.value[t.reference] as Entry | undefined) : undefined;
      const ref =
        old?.binding === binding(t) ? t.reference! : 'cred_' + randomUUID().replaceAll('-', '');
      const next = { ...saved.vault.value };
      if (key === null) delete next[ref];
      else next[ref] = this.vault.encrypt(key, t);
      const written = this.vault.write(saved.vault, next),
        store = createScopedConfigStores(this.cwd).store('global');
      try {
        if (['openai', 'anthropic'].includes(t.provider)) {
          store.commit(
            'agentlab.provider-' + t.provider,
            saved.base,
            { apiKeyRef: key === null ? undefined : ref, apiKeyEnv: undefined },
            { ownedFields: ['apiKeyRef', 'apiKeyEnv'] },
          );
        } else {
          const connections = {
            ...(saved.base.value.connections as Record<string, Record<string, unknown>>),
          };
          const item = { ...connections[t.provider] };
          if (key === null) delete item.apiKeyRef;
          else item.apiKeyRef = ref;
          delete item.apiKeyEnv;
          connections[t.provider] = item;
          store.commit(plugin, saved.base, { connections }, { ownedFields: ['connections'] });
        }
      } catch (error) {
        try {
          this.vault.write(written, saved.vault.value as Record<string, unknown>);
        } catch {
          throw new Error('配置保存失败且密文回滚冲突，请重新读取；未输出任何密钥。');
        }
        throw error;
      }
    });
    this.queue = work.catch(() => {});
    await work;
  }
}
