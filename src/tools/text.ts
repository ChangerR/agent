/**
 * 文件工具共用的跨平台文本处理。
 *
 * 打开文件仍用 path.resolve（按当前系统解释分隔符）。
 * 这里只处理换行、BOM，以及权限规则里的路径写法。
 */

export type Newline = '\n' | '\r\n';

export interface TextStyle {
  bom: string;
  newline: Newline;
  /** 去掉 BOM 并收成 LF，供比较和按行展示。 */
  body: string;
}

export function textStyle(raw: string): TextStyle {
  const bom = raw.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const body = toLf(bom ? raw.slice(1) : raw);
  return { bom, newline: detectNewline(raw), body };
}

/** 文件里占多数的换行。没有换行时用 LF。 */
export function detectNewline(text: string): Newline {
  const crlf = text.split('\r\n').length - 1;
  const lfOnly = text.replace(/\r\n/g, '').split('\n').length - 1;
  if (crlf === 0) return '\n';
  if (lfOnly === 0) return '\r\n';
  return crlf >= lfOnly ? '\r\n' : '\n';
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function fromLf(text: string, newline: Newline): string {
  return newline === '\n' ? text : text.replace(/\n/g, '\r\n');
}

/**
 * minimatch 把 \ 当成转义。Windows 上模型常给出反斜杠路径，
 * 规则靶子统一成 /，否则 edit_file(src/**) 匹配不到 src\a.ts。
 */
export function matchPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? path.replace(/\\/g, '/') : path;
}

/** Linux（含 WSL）区分大小写；Windows 和默认的 macOS 不区分。 */
export function fsCaseSensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux';
}

/** rg 在 Windows 上会把路径写成反斜杠。只改路径段，不动匹配正文。 */
export function normalizeGrepLine(line: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return line;
  const matched = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!matched) return line.replace(/\\/g, '/');
  return `${matched[1].replace(/\\/g, '/')}:${matched[2]}:${matched[3]}`;
}
