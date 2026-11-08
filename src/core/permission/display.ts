/** 审批展示副本的最小脱敏；授权始终绑定未改写的原始参数。 */
function privateKey(key: string, structured = true): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    /(?:apikey|token|password|passwd|secret|privatekey|credentials)$/.test(normalized) ||
    /^(?:authorization|proxyauthorization|cookie|setcookie|credential)$/.test(normalized) ||
    (structured && /^(?:env|headers)$/.test(normalized))
  );
}
export function permissionDisplay(value: unknown, key = ''): unknown {
  if (privateKey(key)) return '[已隐藏敏感值]';
  if (Array.isArray(value))
    return value.map((item, index) =>
      index > 0 &&
      typeof value[index - 1] === 'string' &&
      /^--?[\w-]+$/.test(value[index - 1]) &&
      privateKey(value[index - 1], false)
        ? '[已隐藏敏感值]'
        : permissionDisplay(item),
    );
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, permissionDisplay(item, name)]),
    );
  if (typeof value === 'string') {
    // 工具摘要可能是序列化的参数，按结构处理，避免引号绕过字段脱敏。
    if (/^\s*[[{]/.test(value))
      try {
        const parsed: unknown = JSON.parse(value);
        const displayed = permissionDisplay(parsed);
        return JSON.stringify(displayed) === JSON.stringify(parsed)
          ? value
          : JSON.stringify(displayed);
      } catch {
        /* 不是完整 JSON，继续按普通文本脱敏。 */
      }
    if (/^https?:\/\//i.test(value))
      try {
        const url = new URL(value);
        if (url.username || url.password || url.search || url.hash)
          return `${url.protocol}//${url.host}${url.pathname}[敏感部分已隐藏]`;
      } catch {
        /* 继续按普通文本脱敏。 */
      }
    return value
      .replace(/\b(Bearer\s+)[\w.\-]+/gi, '$1[已隐藏]')
      .replace(
        /(\b([\w-]+)\s*[=:]\s*)(?:'[^']*'|"[^"]*"|[^\s;&]+)/g,
        (match, prefix: string, name: string) =>
          privateKey(name, false) ? `${prefix}[已隐藏]` : match,
      )
      .replace(/(--?([\w-]+)\s+)(?:'[^']*'|"[^"]*"|\S+)/g, (match, prefix: string, name: string) =>
        privateKey(name, false) ? `${prefix}[已隐藏]` : match,
      );
  }
  return value;
}
export function hasPrivateArguments(value: unknown): boolean {
  return JSON.stringify(permissionDisplay(value)) !== JSON.stringify(value);
}
