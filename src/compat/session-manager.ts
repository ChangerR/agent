/** 旧使用者不必立刻改构造参数；新版 runtime 不经过这个默认装配入口。 */
import { SessionManager as Coordinator, type SessionManagerOptions as CoordinatorOptions } from '../core/session/coordinator.js';
import { parseRule } from '../builtin/policy-legacy/engine.js';
import { fileSessionStore } from '../builtin/session-file/index.js';
export type SessionManagerOptions = Omit<CoordinatorOptions, 'store' | 'restoreRequirements'> & Partial<Pick<CoordinatorOptions, 'store' | 'restoreRequirements'>>;
export class SessionManager extends Coordinator {
  constructor(options: SessionManagerOptions) {
    super({ ...options, validateSessionRules: options.validateSessionRules ?? ((rules) => { for (const rule of [...rules.allow, ...rules.ask, ...rules.deny]) parseRule(rule); }), store: options.store ?? fileSessionStore, restoreRequirements: options.restoreRequirements ?? { policy: { id: 'legacy-v1', version: '1.0.0', stateSchemaVersion: 1 } } });
  }
}
