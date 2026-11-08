/** 授权数据与匹配机制；不依赖具体工具、平台或默认策略。 */
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { PolicyInput } from '../../sdk/capabilities.js';

export type GrantScope = 'task' | 'session' | 'project';
export interface PermissionGrant {
  id: string;
  scope: GrantScope;
  cwd: string;
  sessionId?: string;
  permissionScope?: string;
  ownerPlugin: string;
  toolVersion: string;
  boundary: string;
  tools: string[];
  selector:
    | { kind: 'call'; inputHash: string; definitionHash: string }
    | { kind: 'directory'; root: string; effects: Array<'read' | 'write'> };
  createdAt: number;
}

export function permissionHash(value: unknown): string {
  return createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
}

export function permissionDefinition(input: PolicyInput): string {
  return permissionHash({
    name: input.tool.name,
    owner: input.tool.ownerPlugin,
    version: input.tool.version,
    schema: input.tool.inputSchema,
    connection: input.tool.permissionIdentity,
  });
}

export function grantMatches(grant: PermissionGrant, input: PolicyInput): boolean {
  if (
    resolve(grant.cwd) !== resolve(input.cwd) ||
    grant.ownerPlugin !== (input.tool.ownerPlugin ?? 'unowned') ||
    grant.toolVersion !== (input.tool.version ?? 'unversioned') ||
    !grant.tools.includes(input.tool.name)
  )
    return false;
  if (grant.boundary !== (input.executionBoundary?.revision ?? 'host')) return false;
  if (grant.scope !== 'project' && grant.sessionId !== input.sessionId) return false;
  if (grant.scope === 'task' && grant.permissionScope !== input.permissionScope) return false;
  if (grant.selector.kind === 'call')
    return (
      grant.selector.inputHash === permissionHash(input.input) &&
      grant.selector.definitionHash === permissionDefinition(input)
    );
  const selector = grant.selector;
  return (
    input.analysis?.completeness === 'complete' &&
    input.analysis.effects.length > 0 &&
    input.analysis.effects.every((effect) => {
      if (
        effect.scope !== 'project' ||
        !effect.target ||
        !selector.effects.includes(effect.kind as 'read' | 'write')
      )
        return false;
      const rest = relative(selector.root, effect.target);
      return rest !== '' && rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
    })
  );
}

export interface ApprovalAction {
  id: string;
  kind: 'allow_once' | 'grant' | 'deny' | 'stop';
  label: string;
  description: string;
  scope?: GrantScope;
}

/** 候选只在 executor 内保存；UI 只取得不透明动作 ID。 */
export interface GrantOption {
  label: string;
  description: string;
  grant: PermissionGrant;
}

export class PermissionGrantStore {
  private readonly values = new Map<string, PermissionGrant>();
  private generation = 0;
  get revision(): number {
    return this.generation;
  }
  list(): PermissionGrant[] {
    return structuredClone([...this.values.values()]);
  }
  add(grant: PermissionGrant): void {
    this.values.set(grant.id, structuredClone(grant));
    this.generation++;
  }
  revoke(id: string): boolean {
    const removed = this.values.delete(id);
    if (removed) this.generation++;
    return removed;
  }
  clearTemporary(sessionId?: string): void {
    for (const grant of this.values.values())
      if (grant.scope !== 'project' && (!sessionId || grant.sessionId === sessionId))
        this.revoke(grant.id);
  }
  finishTask(scope: string, sessionId?: string): void {
    for (const grant of this.values.values())
      if (
        grant.scope === 'task' &&
        grant.permissionScope === scope &&
        (!sessionId || grant.sessionId === sessionId)
      )
        this.revoke(grant.id);
  }
  match(
    input: PolicyInput,
    eligible: (grant: PermissionGrant) => boolean = () => true,
  ): PermissionGrant | undefined {
    return this.list().find((grant) => eligible(grant) && grantMatches(grant, input));
  }
}
