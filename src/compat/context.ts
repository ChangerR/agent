/** 保留历史构造方式，默认实现仅在兼容入口装配。 */
import { ContextManager as Coordinator } from '../core/context/coordinator.js';
import { SummaryCompactor } from '../builtin/compaction-summary/implementation.js';
import type { Compactor } from '../sdk/runtime-capabilities.js';
export class ContextManager extends Coordinator {
  constructor(options: { compactThreshold: number; compactor?: Compactor; compactTimeoutMs?: number }) {
    super({ ...options, compactor: options.compactor ?? new SummaryCompactor() });
  }
}
