/** 类型化能力图。注册先整批验证，拥有者和别名不受加载先后顺序影响。 */
import { CAPABILITY_KINDS, SINGLETON_CAPABILITY_KINDS, type CapabilityKind, type CapabilityMap, type CapabilityRecord, type CapabilitySelections, type SingletonCapabilityKind } from '../sdk/capabilities.js';

export class CapabilityRegistry {
  private records = new Map<CapabilityKind, Map<string, CapabilityRecord>>();
  private aliases = new Map<CapabilityKind, Map<string, string>>();
  private locked = false;

  constructor() {
    for (const kind of CAPABILITY_KINDS) { this.records.set(kind, new Map()); this.aliases.set(kind, new Map()); }
  }

  commit(records: readonly CapabilityRecord[]): void {
    if (this.locked) throw new Error('Capability graph is frozen');
    const names = new Map([...this.aliases].map(([kind, aliases]) => [kind, new Map(aliases)]));
    for (const record of records) {
      if (!CAPABILITY_KINDS.includes(record.kind)) throw new Error(`Unknown capability kind: ${record.kind}`);
      const occupied = names.get(record.kind)!;
      for (const name of [record.capabilityId, ...record.aliases]) {
        if (!name.trim() || /\s/.test(name)) throw new Error(`Invalid ${record.kind} capability ID or alias: ${name}`);
        const existing = occupied.get(name);
        if (existing) throw new Error(`Duplicate ${record.kind} ID or alias "${name}" from ${record.ownerPlugin}; already owned by ${this.getRecord(record.kind, existing)?.ownerPlugin ?? 'this transaction'}`);
        occupied.set(name, record.capabilityId);
      }
    }
    for (const record of records) {
      this.records.get(record.kind)!.set(record.capabilityId, Object.freeze({ ...record, aliases: Object.freeze([...record.aliases]) }));
    }
    this.aliases = names;
  }

  get<K extends CapabilityKind>(kind: K, id: string): CapabilityMap[K] | undefined {
    return this.getRecord(kind, id)?.implementation;
  }
  getRecord<K extends CapabilityKind>(kind: K, id: string): CapabilityRecord<K> | undefined {
    const canonical = this.aliases.get(kind)?.get(id);
    return (canonical ? this.records.get(kind)?.get(canonical) : undefined) as CapabilityRecord<K> | undefined;
  }
  list<K extends CapabilityKind>(kind: K): readonly CapabilityRecord<K>[] {
    return Object.freeze([...(this.records.get(kind)?.values() ?? [])]) as readonly CapabilityRecord<K>[];
  }
  all(): readonly CapabilityRecord[] { return Object.freeze(CAPABILITY_KINDS.flatMap((kind) => [...this.list(kind)])); }
  freeze(): void { this.locked = true; }
  get frozen(): boolean { return this.locked; }
  validateSelections(selections: CapabilitySelections): void {
    for (const key of Object.keys(selections)) {
      if (!(SINGLETON_CAPABILITY_KINDS as readonly string[]).includes(key)) throw new Error(`Unknown capability selection key: ${key}`);
    }
    for (const kind of SINGLETON_CAPABILITY_KINDS) {
      this.selected(kind, selections);
    }
  }
  selected<K extends SingletonCapabilityKind>(kind: K, selections: CapabilitySelections): CapabilityMap[K] | undefined {
    return this.selectedRecord(kind, selections)?.implementation;
  }
  selectedRecord<K extends SingletonCapabilityKind>(kind: K, selections: CapabilitySelections): CapabilityRecord<K> | undefined {
    const selected = selections[kind];
    if (selected === false) return undefined;
    if (selected !== undefined) {
      const capability = this.getRecord(kind, selected);
      if (!capability) throw new Error(`Selected ${kind} capability not found: ${selected}`);
      return capability;
    }
    const records = this.list(kind);
    if (records.length > 1) throw new Error(`Multiple ${kind} capabilities registered; select one explicitly: ${records.map((record) => record.capabilityId).join(', ')}`);
    return records[0];
  }
}
