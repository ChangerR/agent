/** 面向前端的只读目录：不暴露实现、注册入口、清理开关或执行句柄。 */
import type { CapabilityKind, CapabilityRecord, SingletonCapabilityKind } from '../sdk/index.js';
import { PluginHost, observationSnapshot } from './plugin-host.js';
export type CapabilityInspection = Omit<CapabilityRecord, 'implementation'> & { readonly id: string };
export function inspectPlugins(host: PluginHost) {
  const describe = (record: CapabilityRecord): CapabilityInspection => { const { implementation: _implementation, ...metadata } = record; return observationSnapshot({ ...metadata, id: record.capabilityId }); };
  return Object.freeze({
    get manifests() { return host.manifests; },
    get diagnostics() { return host.diagnostics; },
    get frozen() { return host.frozen; },
    get status() { return host.status; },
    get capabilities() { return Object.freeze(host.capabilities.map(describe)); },
    get tui() { return Object.freeze(host.list('tui').map(record => observationSnapshot(record))); },
    list(kind: CapabilityKind) { return Object.freeze(host.list(kind).map(describe)); },
    get(kind: CapabilityKind, id: string) { const record = host.getRecord(kind, id); return record ? describe(record) : undefined; },
    selected(kind: SingletonCapabilityKind) { const implementation = host.selected(kind); const record = host.list(kind).find(record => record.implementation === implementation); return record ? describe(record) : undefined; },
  });
}
export type PluginInspection = ReturnType<typeof inspectPlugins>;
