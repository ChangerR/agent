import type { WorkerRequest } from '../shared/protocol.js';
/** 本地与 SSH 宿主的共同控制面，业务和权限仍属于 worker。 */
export interface RuntimeHost {
  request(action: WorkerRequest['action']): Promise<void>;
  dispose(): Promise<void>;
}
