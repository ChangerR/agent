/**
 * 示例外部插件：演示插件能做的一切。
 *
 * 在 agent.config.json 中启用：
 *   { "pluginEntries": ["plugins/example/index.ts"] }
 *
 * 展示三件事：
 * 1. 注册自定义工具（current_time）
 * 2. 注册 PreToolUse 钩子（审计所有 bash 命令）
 * 3. 注册 TurnEnd 钩子（统计轮次）
 */
import type { Plugin } from '../../src/sdk/index.js';

const examplePlugin: Plugin = {
  manifest: { id: 'example', version: '1.0.0', apiVersion: 1 },
  setup(ctx) {
    // 1. 自定义工具
    ctx.provide.tool('current_time', {
      name: 'current_time',
      description: 'Get the current date and time.',
      risk: 'read',
      isConcurrencySafe: true,
      inputSchema: { type: 'object', properties: {} },
      analyzeInput: () => ({ patternTarget: '', summary: 'current_time' }),
      execute: async () => ({ content: new Date().toISOString() }),
    });

    // 2. PreToolUse 钩子：审计（也可以返回 { veto: '...' } 否决）
    ctx.hooks.register('PreToolUse', (payload: { toolName: string }) => {
      if (payload.toolName === 'bash') console.error('[example plugin] bash 调用被审计');
    });

    // 3. TurnEnd 钩子
    let turns = 0;
    ctx.hooks.register('TurnEnd', () => {
      turns++;
    });
  },
};

export default examplePlugin;
