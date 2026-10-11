/**
 * Windows PowerShell 的命令形状。
 *
 * 工具名仍叫 bash，win32 上实际解释器是 powershell.exe。
 * bash 语法树和只读执行合约在 shell-readonly.ts，两边不要混在一个函数里。
 *
 * 这里只回答整条命令是不是读文件、列目录或搜索内容。
 * 按 `;` / 换行拆语句，再按 `|` 拆管道，只核对每段的命令名。
 * 不解析路径，不执行。命中后策略拒绝整条命令，要求改用 read_file、glob、grep。
 * 子表达式、调用运算符、重定向、脚本块或其他命令一律不命中。
 */
const READ_CMDLETS = new Set([
  'get-content',
  'gc',
  'cat',
  'type',
  'get-childitem',
  'gci',
  'ls',
  'dir',
  'select-string',
  'sls',
  'get-item',
  'gi',
]);
const FORMAT_CMDLETS = new Set([
  'select-object',
  'select',
  'sort-object',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'format-wide',
  'fw',
  'out-string',
  'measure-object',
]);
const METACHARS = new Set(['$', '@', '&', '`', '(', ')', '{', '}', '<', '>']);

export function windowsDedicatedFileCommand(command: string): boolean {
  const statements = splitStatements(command);
  if (!statements) return false;
  return statements.every(pipelineIsFileRead);
}

function splitStatements(command: string): string[] | null {
  if (!command.trim() || [...command].some((ch) => METACHARS.has(ch))) return null;
  const parts = splitOutsideQuotes(command, new Set([';', '\n', '\r']));
  if (!parts) return null;
  const statements = parts.map((part) => part.trim()).filter((part) => part.length > 0);
  return statements.length > 0 ? statements : null;
}

function pipelineIsFileRead(statement: string): boolean {
  const pipeline = splitOutsideQuotes(statement, new Set(['|']));
  if (!pipeline) return false;
  const segments = pipeline.map((part) => part.trim());
  if (segments.some((segment) => segment.length === 0)) return false;
  return segments.every((segment, index) => segmentIsAllowed(segment, index === 0));
}

function segmentIsAllowed(segment: string, first: boolean): boolean {
  const tokens = tokenize(segment);
  if (!tokens || tokens.length === 0) return false;
  const head = tokens[0]!;
  if (head.startsWith('"') || head.startsWith("'")) return false;
  const name = head.toLowerCase();
  if (first) return READ_CMDLETS.has(name);
  return READ_CMDLETS.has(name) || FORMAT_CMDLETS.has(name);
}

function splitOutsideQuotes(command: string, separators: Set<string>): string[] | null {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (separators.has(ch)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) return null;
  parts.push(current);
  return parts;
}

function tokenize(segment: string): string[] | null {
  const raw = splitOutsideQuotes(segment, new Set([' ', '\t']));
  if (!raw) return null;
  return raw.map((token) => token.trim()).filter((token) => token.length > 0);
}
