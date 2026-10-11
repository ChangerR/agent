/** 仅人工审批接入根 FIFO；其余 child 事件由 supervisor 转为专用信封。 */
import { EventBus, type AgentEvent } from '../core/events.js';
export class ChildEventBus extends EventBus {
  constructor(private readonly parent: EventBus) {
    super();
  }
  override hasListeners(type: AgentEvent['type']): boolean {
    return type === 'permission_request'
      ? this.parent.hasListeners(type)
      : super.hasListeners(type);
  }
  override emit(event: AgentEvent): void {
    if (event.type === 'permission_request') {
      super.emit(event);
      this.parent.emit(event);
    } else super.emit(event);
  }
}
