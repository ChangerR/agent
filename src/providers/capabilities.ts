/** 端点与模型能力属于 adapter；未知兼容厂商不从模型名猜测原生协议。 */
import { createHash } from 'node:crypto';
import type { ChatRequest, ModelCapabilities } from '../core/provider.js';
export function routeIdentity(provider: string, endpoint: string): string {
  let publicRoute: string;
  try {
    const url = new URL(endpoint);
    // 用户名、密码、查询参数从不进入可观测身份。
    publicRoute = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    publicRoute = `invalid-endpoint:${endpoint.trim()}`;
  }
  return `${provider}:${createHash('sha256').update(publicRoute).digest('hex').slice(0, 16)}`;
}
export function checkModelCapabilities(req: ChatRequest, caps: ModelCapabilities): ChatRequest {
  if (
    req.thinking !== undefined &&
    caps.thinkingLevels &&
    !caps.thinkingLevels.includes(req.thinking)
  )
    throw new Error(`unsupported_thinking_level: model ${req.model} cannot use ${req.thinking}`);
  if (req.systemSegments && req.systemSegments.map((s) => s.text).join('') !== req.system)
    throw new Error('invalid_system_segments');
  return req;
}
