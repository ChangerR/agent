/** PowerShell AST 与字面参数绑定；不执行命令，不把未知节点猜成安全参数。 */
import Parser from 'tree-sitter';
import PowerShell from 'tree-sitter-powershell/bindings/node/index.js';
import { powerShellCmdlet, type PowerShellCmdlet } from './powershell-cmdlets.js';

type LiteralValue = string | boolean | number;
export interface PowerShellCommand {
  name: string;
  module?: string;
  parameters: Record<string, LiteralValue>;
  /** 原生或未知命令的静态 argv 仅用于保守危险分类，不构成执行授权。 */
  arguments: string[];
  redirections: { operator: string; path?: string }[];
  complete: boolean;
  fileRead: boolean;
  format: boolean;
}
export interface PowerShellSyntax {
  complete: boolean;
  pipelines: PowerShellCommand[][];
  unresolved: string[];
  dedicatedFileRead: boolean;
  command?: string;
}
const parser = new Parser();
parser.setLanguage(PowerShell);
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
class Unsupported extends Error {}
const unsupported = (detail: string): never => {
  throw new Unsupported(detail);
};

/** 只解码 AST 已确认的单一静态字面量。混合引号、转义、插值与数组留在 unknown。 */
function literal(node: Parser.SyntaxNode): LiteralValue {
  const text = node.text;
  if (node.type === 'variable' && /^\$(true|false)$/i.test(text)) return /^\$true$/i.test(text);
  if (node.type === 'generic_token' || node.type === 'command_name') {
    if (
      !text ||
      /[\s'"‘’“”`$@,;|&(){}<>\u0000-\u001f]/.test(text) ||
      /^[\u2010-\u2015\u2212]/.test(text)
    )
      unsupported('动态或混合字面量');
    return text;
  }
  if (
    ['string_literal', 'expandable_string_literal', 'verbatim_string_characters'].includes(
      node.type,
    )
  ) {
    if (/^'(?:[^']|'')*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
    if (/^"(?:[^"$`]|"")*"$/.test(text)) return text.slice(1, -1).replace(/""/g, '"');
    unsupported('字符串包含插值、转义或非支持形态');
  }
  if (
    [
      'array_literal_expression',
      'unary_expression',
      'integer_literal',
      'decimal_integer_literal',
    ].includes(node.type)
  ) {
    if (node.namedChildCount === 1) return literal(node.namedChildren[0]!);
    if (/^[0-9]+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  }
  return unsupported(`未支持的参数节点 ${node.type}`);
}

function parameter(spec: PowerShellCmdlet, raw: string) {
  const name = raw.slice(1).toLowerCase();
  // 精确名/别名先匹配；缩写必须在完整参数集合中唯一，不能只在支持子集中猜测。
  const exact = spec.parameters.find(
    (p) => p.name.toLowerCase() === name || p.aliases?.some((a) => a.toLowerCase() === name),
  );
  if (exact) return exact;
  const matches = spec.parameters.filter((p) => p.name.toLowerCase().startsWith(name));
  return matches.length === 1 ? matches[0]! : unsupported(`未知或歧义参数 ${raw}`);
}

/** 文件路径等 String 参数按 PowerShell 标量转换；Object 输入保留数值/布尔类型。 */
function bindValue(name: string, value: LiteralValue): LiteralValue {
  return ['Value', 'InputObject'].includes(name)
    ? value
    : typeof value === 'boolean'
      ? value
        ? 'True'
        : 'False'
      : String(value);
}

function command(node: Parser.SyntaxNode, unresolved: string[]): PowerShellCommand {
  const nameNode = node.childForFieldName('command_name');
  let spec: PowerShellCmdlet | undefined;
  const result: PowerShellCommand = {
    name: nameNode?.text ?? '?',
    parameters: {},
    arguments: [],
    redirections: [],
    complete: true,
    fileRead: false,
    format: false,
  };
  const mark = (detail: string) => {
    result.complete = false;
    unresolved.push(`${result.name}: ${detail}`);
  };
  try {
    if (
      !nameNode ||
      nameNode.type !== 'command_name' ||
      node.namedChildren.some((n) => n.type === 'command_invokation_operator')
    )
      unsupported('动态命令或调用运算符');
    const name = literal(nameNode!);
    if (typeof name !== 'string') unsupported('命令名不是字符串');
    spec = powerShellCmdlet(name as string);
    if (!spec) unsupported('未支持的命令语义');
    result.name = spec!.name;
    result.module = spec!.module;
    result.fileRead = !!spec!.fileRead;
    result.format = !!spec!.format;
  } catch (error) {
    mark(error instanceof Unsupported ? error.message : '命令解析失败');
  }
  const elements = node.childForFieldName('command_elements')?.namedChildren ?? [];
  const positional: LiteralValue[] = [];
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    if (element.type === 'command_argument_sep') {
      if (!/^(?:\s|`\r?\n)*$/.test(element.text)) mark('不支持的参数分隔符');
      continue;
    }
    try {
      if (element.type === 'redirection') {
        const operator = element.namedChildren[0]?.text ?? '';
        if (/^[1-6]?>>?$/.test(operator) || /^\*>>?$/.test(operator)) {
          const filename = element.namedChildren.find((n) => n.type === 'redirected_file_name');
          const valueNodes = filename?.namedChildren.filter(
            (n) => n.type !== 'command_argument_sep',
          );
          if (valueNodes?.length !== 1) unsupported('重定向目标不是单一字面量');
          const path = literal(valueNodes![0]!);
          if (typeof path !== 'string') unsupported('重定向目标不是路径');
          result.redirections.push({ operator, path: path as string });
        } else if (/^[1-6]\s*>&\s*[1-6]$/.test(operator)) result.redirections.push({ operator });
        else unsupported('未支持的重定向');
        continue;
      }
      if (element.type === 'command_parameter') {
        if (!spec) {
          result.arguments.push(element.text);
          continue;
        }
        const p = parameter(spec!, element.text);
        if (Object.hasOwn(result.parameters, p.name)) unsupported('重复参数');
        const sep = elements[i + 1];
        let value: LiteralValue = true;
        if (!p.switch || sep?.text === ':') {
          if (sep?.type !== 'command_argument_sep') unsupported('缺少参数值');
          const valueNode = elements[i + 2];
          if (!valueNode || valueNode.type === 'command_parameter') unsupported('缺少参数值');
          value = literal(valueNode!);
          i += 2;
        }
        if (p.switch && typeof value !== 'boolean') unsupported('参数值类型不匹配');
        result.parameters[p.name] = p.switch ? value : bindValue(p.name, value);
        if (p.unsupported) mark(`参数 ${p.name} 的语义未支持`);
      } else {
        const value = literal(element);
        positional.push(value);
        if (!spec && typeof value === 'string') result.arguments.push(value);
      }
    } catch (error) {
      mark(error instanceof Unsupported ? error.message : '参数解析失败');
    }
  }
  if (spec) {
    const positions = spec.positional.filter(
      (name) =>
        !Object.hasOwn(result.parameters, name) &&
        !(name === 'Path' && Object.hasOwn(result.parameters, 'LiteralPath')),
    );
    for (let i = 0; i < positional.length; i++) {
      const name = positions[i];
      if (!name || Object.hasOwn(result.parameters, name)) {
        mark('无法完整绑定位置参数');
        continue;
      }
      result.parameters[name] = bindValue(name, positional[i]!);
    }
    if (result.parameters.Path !== undefined && result.parameters.LiteralPath !== undefined)
      mark('Path 与 LiteralPath 参数集冲突');
    for (const name of ['ErrorAction', 'WarningAction', 'InformationAction']) {
      const value = result.parameters[name];
      if (
        value !== undefined &&
        !/^(?:SilentlyContinue|Stop|Continue|Inquire|Ignore|Suspend)$/i.test(String(value))
      )
        mark(`未支持的 ${name}`);
    }
    if (
      result.parameters.Encoding !== undefined &&
      !/^(?:unknown|string|unicode|bigendianunicode|utf8|utf7|utf32|ascii|default|oem)$/i.test(
        String(result.parameters.Encoding),
      )
    )
      mark('未支持的编码');
    if (
      result.parameters.Confirm === true ||
      /^inquire$/i.test(String(result.parameters.ErrorAction))
    )
      mark('命令会要求解释器内部交互');
  }
  return result;
}

/** 只支持语句列表与普通管道。未知结构覆盖整条命令，不能只提取其中安全的 command。 */
export function parsePowerShell(source: string): PowerShellSyntax {
  const result: PowerShellSyntax = {
    complete: true,
    pipelines: [],
    unresolved: [],
    dedicatedFileRead: false,
  };
  if (!source.trim() || source.length > 60_000 || source.includes('\0'))
    return { ...result, complete: false, unresolved: ['空命令或解析预算超限'] };
  try {
    const root = parser.parse(source).rootNode;
    if (root.hasError) result.unresolved.push('语法树包含错误或缺失节点');
    if (root.namedChildren.some((n) => !['statement_list', 'comment'].includes(n.type)))
      result.unresolved.push('未支持的顶层结构');
    for (const statements of root.namedChildren.filter((n) => n.type === 'statement_list')) {
      for (const statement of statements.namedChildren) {
        if (['comment', 'empty_statement'].includes(statement.type)) continue;
        const chain = statement.namedChildren[0];
        if (
          statement.type !== 'pipeline' ||
          statement.namedChildCount !== 1 ||
          chain?.type !== 'pipeline_chain' ||
          chain.namedChildren.some((n) => n.type !== 'command') ||
          chain.children.some((n) => ['&&', '||', '&'].includes(n.type))
        ) {
          result.unresolved.push(`未支持的语句结构 ${statement.type}`);
          continue;
        }
        result.pipelines.push(chain.namedChildren.map((n) => command(n, result.unresolved)));
      }
    }
    result.complete = !result.unresolved.length && result.pipelines.length > 0;
    result.dedicatedFileRead =
      result.complete &&
      result.pipelines.every(
        (pipeline) =>
          pipeline.length > 0 &&
          pipeline[0]!.fileRead &&
          pipeline.every((cmd) => (cmd.fileRead || cmd.format) && !cmd.redirections.length),
      );
    if (result.complete)
      result.command = result.pipelines
        .map((pipeline) =>
          pipeline
            .map((cmd) =>
              [
                `${cmd.module}\\${cmd.name}`,
                ...Object.entries(cmd.parameters).map(([name, value]) =>
                  typeof value === 'boolean'
                    ? `-${name}:$${value}`
                    : `-${name} ${typeof value === 'number' ? value : quote(value)}`,
                ),
                ...cmd.redirections.map(
                  (redirection) =>
                    `${redirection.operator}${redirection.path === undefined ? '' : ` ${quote(redirection.path)}`}`,
                ),
              ].join(' '),
            )
            .join(' | '),
        )
        .join('; ');
    return result;
  } catch {
    return {
      ...result,
      complete: false,
      unresolved: [...result.unresolved, 'PowerShell parser 不可用'],
    };
  }
}

export function windowsDedicatedFileCommand(command: string): boolean {
  return parsePowerShell(command).dedicatedFileRead;
}
