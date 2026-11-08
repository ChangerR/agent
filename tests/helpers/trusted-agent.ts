/** 测试夹具的配置与插件由测试作者提供；显式授予启动信任，工具授权保持真实策略。
 * startup-trust.test.ts 使用原始入口独立验证未受信任项目。
 */
export * from '../../src/index.js';
import { createAgent as runtime, type CreateAgentOptions } from '../../src/index.js';
export function createAgent(cwd: string, options: CreateAgentOptions = {}) {
  return runtime(cwd, { ...options, approveStartup: () => true });
}
