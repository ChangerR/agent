/** 执行/审批专项剧本关闭无关的规划请求；默认自动规划在 planning 测试中独立验收。 */
import { createAgent, type CreateAgentOptions } from '../../src/index.js';

export function createExecutionAgent(cwd: string, options: CreateAgentOptions = {}) {
  return createAgent(cwd, {
    ...options,
    config: {
      ...options.config,
      pluginConfig: {
        'agentlab.planning': { mode: 'off' },
        ...options.config?.pluginConfig,
      },
    },
  });
}
