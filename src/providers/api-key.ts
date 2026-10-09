/** API key 的显式变量引用在首次请求前校验，未配置时保留 provider 默认行为。 */
export interface ApiKeyOptions {
  apiKey?: string;
  /** 显式来源；只允许读取这个变量，不回退到其他凭据。 */
  apiKeyEnv?: string;
}

export function resolveApiKey(options: ApiKeyOptions, defaultEnv: string): string | undefined {
  if (options.apiKeyEnv === undefined) return options.apiKey ?? process.env[defaultEnv];
  if (!options.apiKeyEnv.trim()) {
    throw new Error('配置项 apiKeyEnv 必须填写非空环境变量名，不能填写 key；请修改 agent.config.json 或 ~/.agent/config.json 后重新启动。');
  }
  const key = options.apiKey ?? process.env[options.apiKeyEnv];
  if (typeof key !== 'string' || !key.trim()) {
    // apiKeyEnv 本身也可能被误填为 key，故变量名和变量值都不回显。
    throw new Error('配置项 apiKeyEnv 指定的环境变量未设置或为空；请核对 agent.config.json 或 ~/.agent/config.json 中的变量名，在项目根 .env 或 shell 环境中设置非空 key，然后重新启动。已有 shell 变量（包括空值）优先于 .env。');
  }
  return key;
}
