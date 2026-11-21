/** 测试夹具的配置与插件由测试作者提供；显式授予启动信任，工具授权保持真实策略。
 * startup-trust.test.ts 使用原始入口独立验证未受信任项目。
 */
export * from '../../src/index.js';
import { createAgent as runtime, type CreateAgentOptions } from '../../src/index.js';
import {
  readGlobalPermissionConfig,
  savePermissionConfig,
  copyPermissionDraft,
} from '../../src/builtin/policy/config.js';
import { onTestFinished } from 'vitest';

// 权限场景使用测试 HOME 的全局配置，各用例结束后还原原值。
export function setFixturePermissionMode(permissionMode: 'ask' | 'auto' | 'yolo') {
  const before = readGlobalPermissionConfig();
  savePermissionConfig(before, { ...copyPermissionDraft(before), permissionMode });
  onTestFinished(() => {
    const current = readGlobalPermissionConfig(before.path);
    if (current.exists)
      savePermissionConfig(current, {
        ...copyPermissionDraft(current),
        permissionMode: before.permissionMode,
      });
  });
}
export function createAgent(cwd: string, options: CreateAgentOptions = {}) {
  const { permissionMode, ...config } = options.config ?? {};
  if (permissionMode !== undefined) setFixturePermissionMode(permissionMode);
  return runtime(cwd, { ...options, config, approveStartup: () => true });
}
