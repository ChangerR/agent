/** 官方预设核对于 2026-10-24；只提供表单默认值，不联网探测用户凭据。 */

export const MODEL_SERVICES = {
  deepseek: {
    label: 'DeepSeek 官方',
    endpoint: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    labels: ['DeepSeek Flash · 推荐', 'DeepSeek V4 Pro'],
  },
  kimi: {
    label: 'Kimi 官方',
    endpoint: 'https://api.moonshot.cn/v1',
    models: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'],
    labels: ['Kimi K3.1 Pro · 推荐', 'Kimi K3.1 Pro Highspeed'],
  },
} as const;
export const officialEndpoints = (service: 'deepseek' | 'kimi'): readonly string[] =>
  service === 'kimi'
    ? [MODEL_SERVICES.kimi.endpoint, 'https://api.moonshot.ai/v1']
    : [MODEL_SERVICES.deepseek.endpoint];
export type ModelService = 'deepseek' | 'kimi' | 'custom';
export interface ModelSetupSave {
  token: string;
  model: string;
  endpoint: string;
  protocol: 'openai' | 'anthropic';
  key: string;
}
export interface ModelSetupView {
  token: string;
  service: ModelService;
  endpoint: string;
  protocol: 'openai' | 'anthropic';
  model: string;
  configured: boolean;
  available: boolean;
}
