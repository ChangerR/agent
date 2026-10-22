/** 仅在一次宿主草稿内有效的不透明保留句柄；从不把已保存凭据传给前端。 */
import { randomUUID } from 'node:crypto';
export class SettingsSecrets {
  private values = new Map<string, unknown>();
  keep(value: unknown): { $secret: string } {
    const id = randomUUID();
    this.values.set(id, structuredClone(value));
    return { $secret: id };
  }
  restore(value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      if (Object.hasOwn(object, '$secret')) {
        if (
          Object.keys(object).length !== 1 ||
          typeof object.$secret !== 'string' ||
          !this.values.has(object.$secret)
        )
          throw new Error('凭据保留句柄已失效。');
        return structuredClone(this.values.get(object.$secret));
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, item]) => {
          if (['__proto__', 'prototype', 'constructor'].includes(key))
            throw new Error('保留名称不能作为配置键。');
          return [key, this.restore(item)];
        }),
      );
    }
    if (Array.isArray(value)) return value.map((v) => this.restore(v));
    return value;
  }
}
