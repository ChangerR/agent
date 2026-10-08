/** 最终调用必须是无隐式转换的 JSON，审批与执行使用同一个验证后的副本。 */
export function jsonInput(value: unknown, schema: Record<string, unknown>): Record<string, unknown> {
  assertJson(value, new Set());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool input must be a JSON object');
  checkSchema(schema, schema, new Set());
  validate(value, schema, schema, '$', 0);
  return structuredClone(value) as Record<string, unknown>;
}

function assertJson(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || !value) throw new Error('Tool input contains non-JSON data');
  if (seen.has(value)) throw new Error('Tool input contains a cycle');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Tool input must contain plain JSON objects');
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string')) throw new Error('Tool input contains non-JSON keys');
  seen.add(value);
  for (const item of Object.values(value)) assertJson(item, seen);
  seen.delete(value);
}

const annotations = new Set(['$schema', '$id', '$anchor', '$comment', 'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format', '$defs', 'definitions']);
const assertions = new Set(['$ref', 'type', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'properties', 'required', 'additionalProperties', 'patternProperties', 'propertyNames', 'minProperties', 'maxProperties', 'dependentRequired', 'dependentSchemas', 'dependencies', 'items', 'prefixItems', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern']);
/** 先检查整个 schema，避免 not/anyOf 把“不支持”误当成正常的不匹配。 */
function checkSchema(schema: unknown, root: Record<string, unknown>, seen: Set<object>): void {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid JSON Schema');
  if (seen.has(schema)) return;
  seen.add(schema);
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!annotations.has(key) && !assertions.has(key)) throw new Error(`Unsupported JSON Schema keyword: ${key}`);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.length || types.some((type) => !['null', 'array', 'object', 'integer', 'string', 'number', 'boolean'].includes(String(type)))) throw new Error('Invalid JSON Schema type');
  }
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== 'string' || !s.$ref.startsWith('#/')) throw new Error('Only local JSON Schema references are supported');
    let target: unknown = root;
    for (const key of s.$ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw new Error('Unresolved JSON Schema reference');
      target = (target as Record<string, unknown>)[key];
    }
    checkSchema(target, root, seen);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (s[key] !== undefined) {
    if (!Array.isArray(s[key]) || key !== 'prefixItems' && s[key].length === 0) throw new Error(`Invalid JSON Schema ${key}`);
    for (const child of s[key]) checkSchema(child, root, seen);
  }
  for (const key of ['not', 'if', 'then', 'else', 'additionalProperties', 'propertyNames', 'additionalItems', 'contains']) if (s[key] !== undefined) checkSchema(s[key], root, seen);
  if (s.items !== undefined) for (const child of Array.isArray(s.items) ? s.items : [s.items]) checkSchema(child, root, seen);
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) if (s[key] !== undefined) {
    const group = s[key];
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error(`Invalid JSON Schema ${key}`);
    for (const [pattern, child] of Object.entries(group)) {
      if (key === 'patternProperties') new RegExp(pattern, 'u');
      checkSchema(child, root, seen);
    }
  }
  for (const key of ['dependencies', 'dependentRequired']) if (s[key] !== undefined) {
    const group = s[key];
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error(`Invalid JSON Schema ${key}`);
    for (const child of Object.values(group)) {
      if (Array.isArray(child)) { if (child.some((v) => typeof v !== 'string')) throw new Error(`Invalid JSON Schema ${key}`); }
      else if (key === 'dependencies') checkSchema(child, root, seen);
      else throw new Error(`Invalid JSON Schema ${key}`);
    }
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((key) => typeof key !== 'string'))) throw new Error('Invalid JSON Schema required');
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.length)) throw new Error('Invalid JSON Schema enum');
  if (s.pattern !== undefined) { if (typeof s.pattern !== 'string') throw new Error('Invalid JSON Schema pattern'); new RegExp(s.pattern, 'u'); }
  for (const key of ['minProperties', 'maxProperties', 'minItems', 'maxItems', 'minContains', 'maxContains', 'minLength', 'maxLength']) {
    if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isSafeInteger(s[key]) || s[key] < 0)) throw new Error(`Invalid JSON Schema ${key}`);
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || key === 'multipleOf' && s[key] <= 0)) throw new Error(`Invalid JSON Schema ${key}`);
  }
}
function matches(value: unknown, schema: unknown, root: Record<string, unknown>, path: string, depth: number): boolean {
  try { validate(value, schema, root, path, depth + 1); return true; } catch { return false; }
}
function validate(value: unknown, schema: unknown, root: Record<string, unknown>, path: string, depth: number): void {
  if (depth > 80) throw new Error('JSON Schema nesting exceeds limit');
  if (schema === true) return;
  if (schema === false) throw new Error(`${path}: schema rejects input`);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid JSON Schema');
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!annotations.has(key) && !assertions.has(key)) throw new Error(`Unsupported JSON Schema keyword: ${key}`);
  const fail = (reason: string): never => { throw new Error(`${path}: ${reason}`); };
  const sub = (v: unknown, spec: unknown, at = path) => validate(v, spec, root, at, depth + 1);
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== 'string' || !s.$ref.startsWith('#/')) fail('only local JSON Schema references are supported');
    let resolved: unknown = root;
    for (const part of (s.$ref as string).slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!resolved || typeof resolved !== 'object' || !Object.hasOwn(resolved, part)) fail('unresolved schema reference');
      resolved = (resolved as Record<string, unknown>)[part];
    }
    sub(value, resolved);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const valid = types.some((type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : ['string', 'number', 'boolean'].includes(type as string) && typeof value === type);
    if (!valid) fail(`expected ${types.join(' | ')}`);
  }
  if (Object.hasOwn(s, 'const') && canonical(value) !== canonical(s.const)) fail('does not match const');
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.some((item) => canonical(item) === canonical(value)))) fail('does not match enum');
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (s[key] === undefined) continue;
    if (!Array.isArray(s[key])) fail(`invalid ${key}`);
    const choices = s[key] as unknown[];
    const count = choices.filter((choice) => matches(value, choice, root, path, depth)).length;
    if (key === 'allOf' ? count !== choices.length : key === 'anyOf' ? count === 0 : count !== 1) fail(`does not match ${key}`);
  }
  if (s.not !== undefined && matches(value, s.not, root, path, depth)) fail('matches excluded schema');
  if (s.if !== undefined) {
    const branch = matches(value, s.if, root, path, depth) ? s.then : s.else;
    if (branch !== undefined) sub(value, branch);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof s.minLength === 'number' && length < s.minLength) fail('string is too short');
    if (typeof s.maxLength === 'number' && length > s.maxLength) fail('string is too long');
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) fail('string does not match pattern');
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) fail('below minimum');
    if (typeof s.maximum === 'number' && value > s.maximum) fail('above maximum');
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) fail('below exclusive minimum');
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) fail('above exclusive maximum');
    if (typeof s.multipleOf === 'number' && (!Number.isFinite(s.multipleOf) || s.multipleOf <= 0 || Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-10)) fail('does not match multipleOf');
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) fail('too few items');
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) fail('too many items');
    if (s.uniqueItems && new Set(value.map((v) => canonical(v))).size !== value.length) fail('items must be unique');
    const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : [];
    value.forEach((item, index) => {
      const spec = index < tuple.length ? tuple[index] : Array.isArray(s.items) ? s.additionalItems : s.items;
      if (spec !== undefined) sub(item, spec, `${path}[${index}]`);
    });
    if (s.contains !== undefined) {
      const count = value.filter((v) => matches(v, s.contains, root, path, depth)).length;
      if (count < (typeof s.minContains === 'number' ? s.minContains : 1) || typeof s.maxContains === 'number' && count > s.maxContains) fail('does not match contains');
    }
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) fail('too few properties');
    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) fail('too many properties');
    if (s.required !== undefined && !Array.isArray(s.required)) fail('invalid required');
    for (const key of (s.required ?? []) as string[]) if (!Object.hasOwn(object, key)) fail(`missing required property ${key}`);
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, unknown>).map(([pattern, spec]) => [new RegExp(pattern, 'u'), spec] as const);
    for (const key of keys) {
      if (s.propertyNames !== undefined) sub(key, s.propertyNames);
      let known = Object.hasOwn(properties, key);
      if (known) sub(object[key], properties[key], `${path}.${key}`);
      for (const [pattern, spec] of patterns) if (pattern.test(key)) { known = true; sub(object[key], spec, `${path}.${key}`); }
      if (!known && s.additionalProperties !== undefined) sub(object[key], s.additionalProperties, `${path}.${key}`);
    }
    for (const [key, dependency] of Object.entries({ ...(s.dependencies as object), ...(s.dependentRequired as object), ...(s.dependentSchemas as object) })) {
      if (!Object.hasOwn(object, key)) continue;
      if (Array.isArray(dependency)) { for (const required of dependency) if (!Object.hasOwn(object, required)) fail(`missing dependent property ${required}`); }
      else sub(value, dependency);
    }
  }
}
function canonical(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
