/** API key 的显式变量引用在首次请求前校验，未配置时保留 provider 默认行为。 */
export interface ApiKeyOptions {
  apiKey?: string;
  apiKeyResolver?: (endpoint: string) => string;
  /** 显式来源；只允许读取这个变量，不回退到其他凭据。 */
  apiKeyEnv?: string;
}

export function storedApiKey(
  reference: string | undefined,
  resolve?: (reference: string, identity?: string) => string,
  identity?: string,
): string | undefined {
  if (!reference) return undefined;
  if (!resolve)
    throw new Error(
      '此连接使用 App 加密保存的 API key。请在 agentlab App 中使用，或明确改用高级环境变量方式；不会回退到其他凭据。',
    );
  const value = resolve(reference, identity);
  if (!value?.trim()) throw new Error('保存的 API key 不可用，请在全局设置中重新输入。');
  return value;
}

export function resolveApiKey(
  options: ApiKeyOptions,
  defaultEnv: string,
  endpoint = '',
): string | undefined {
  const provided = options.apiKeyResolver ? options.apiKeyResolver(endpoint) : options.apiKey;
  if (options.apiKeyEnv === undefined) return provided ?? process.env[defaultEnv];
  if (!options.apiKeyEnv.trim()) {
    throw new Error(
      '配置项 apiKeyEnv 必须填写非空环境变量名，不能填写 key；请修改 agent.config.json 或 ~/.agentlab/config.json 后重新启动。',
    );
  }
  const key = provided ?? process.env[options.apiKeyEnv];
  if (typeof key !== 'string' || !key.trim()) {
    // apiKeyEnv 本身也可能被误填为 key，故变量名和变量值都不回显。
    throw new Error(
      '配置项 apiKeyEnv 指定的环境变量未设置或为空；请核对 agent.config.json 或 ~/.agentlab/config.json 中的变量名，在项目根 .env 或 shell 环境中设置非空 key，然后重新启动。已有 shell 变量（包括空值）优先于 .env。',
    );
  }
  return key;
}

export const credentialBinding = (provider: string, type: string, endpoint: string) =>
  JSON.stringify([provider, type, endpoint.replace(/\/+$/, '')]);
