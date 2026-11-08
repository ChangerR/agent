import type { PolicyInput } from '../../sdk/capabilities.js';
import { permissionHash } from './grants.js';
import { win32 } from 'node:path';

/** 任务停止与操作拒绝分离；同一资源不能通过换工具绕过拒绝。 */
export class RequestPermissionGuard {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}
  private readonly denied = new Set<string>();
  private readonly operations = new Map<
    string,
    Array<{ key: string; resources: string[]; opaque: boolean }>
  >();

  deny(scope: string): void {
    this.denied.add(scope);
  }
  isDenied(scope: string): boolean {
    return this.denied.has(scope);
  }
  denyOperation(scope: string, operation: PolicyInput): void {
    const entries = this.operations.get(scope) ?? [];
    entries.push({
      key: operationKey(operation),
      resources: operationResources(operation, this.platform),
      opaque: operation.analysis?.completeness !== 'complete',
    });
    this.operations.set(scope, entries);
  }
  operationDenied(scope: string, operation: PolicyInput): boolean {
    const entries = this.operations.get(scope) ?? [];
    const key = operationKey(operation);
    const resources = operationResources(operation, this.platform);
    return entries.some(
      (entry) =>
        entry.key === key ||
        entry.resources.some((resource) => resources.includes(resource)) ||
        ((entry.opaque || entry.resources.length > 0) &&
          operation.analysis?.completeness !== 'complete'),
    );
  }
}

function operationKey(input: PolicyInput): string {
  return permissionHash({
    cwd: input.cwd,
    tool: input.tool.name,
    owner: input.tool.ownerPlugin,
    input: input.input,
  });
}
function operationResources(input: PolicyInput, platform: NodeJS.Platform): string[] {
  return (input.analysis?.effects ?? []).flatMap((effect) =>
    effect.target && effect.kind !== 'execute'
      ? [
          `${effect.kind}:${platform === 'win32' ? win32.normalize(effect.target).toLowerCase() : effect.target}`,
        ]
      : [],
  );
}
