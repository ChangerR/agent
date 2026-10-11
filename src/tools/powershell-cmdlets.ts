/** Windows PowerShell 5.1 静态参数契约；未支持的参数也参与缩写消歧。 */
export interface PowerShellParameter {
  name: string;
  aliases?: string[];
  switch?: boolean;
  unsupported?: boolean;
}
export interface PowerShellCmdlet {
  name: string;
  module: string;
  aliases: string[];
  parameters: PowerShellParameter[];
  positional: string[];
  fileRead?: boolean;
  format?: boolean;
}
const parameters = (names: string, unsupported = false): PowerShellParameter[] =>
  names
    .split(' ')
    .filter(Boolean)
    .map((name) => ({ name, unsupported }));
const switches = (names: string): PowerShellParameter[] =>
  parameters(names).map((parameter) => ({ ...parameter, switch: true }));
const common: PowerShellParameter[] = [
  ...switches('Verbose Debug'),
  { name: 'ErrorAction', aliases: ['ea'] },
  { name: 'WarningAction', aliases: ['wa'] },
  { name: 'InformationAction', aliases: ['infa'] },
  ...parameters(
    'ErrorVariable WarningVariable InformationVariable OutVariable OutBuffer PipelineVariable',
    true,
  ),
];
const filesystem: PowerShellParameter[] = [
  { name: 'Path' },
  { name: 'LiteralPath', aliases: ['PSPath'] },
  ...parameters('Filter Include Exclude Credential UseTransaction', true),
];
const mutation: PowerShellParameter[] = [
  { name: 'WhatIf', aliases: ['wi'], switch: true },
  { name: 'Confirm', aliases: ['cf'], switch: true },
];
const management = 'Microsoft.PowerShell.Management';
const utility = 'Microsoft.PowerShell.Utility';
function cmdlet(
  name: string,
  aliases: string[],
  positional: string[],
  extra: PowerShellParameter[],
  options: Partial<Pick<PowerShellCmdlet, 'fileRead' | 'format'>> = {},
  module = management,
): PowerShellCmdlet {
  return { name, aliases, positional, parameters: [...common, ...extra], module, ...options };
}
export const POWERSHELL_CMDLETS: readonly PowerShellCmdlet[] = [
  ...['Set-Content', 'Add-Content'].map((name) =>
    cmdlet(
      name,
      [name === 'Set-Content' ? 'sc' : 'ac'],
      ['Path', 'Value'],
      [
        ...filesystem,
        ...mutation,
        ...parameters('Value Encoding'),
        ...switches('Force PassThru NoNewline'),
        ...parameters('Stream', true),
      ],
    ),
  ),
  cmdlet(
    'Clear-Content',
    ['clc'],
    ['Path'],
    [...filesystem, ...mutation, ...switches('Force'), ...parameters('Stream', true)],
  ),
  cmdlet(
    'Remove-Item',
    ['rm', 'ri', 'rd', 'del', 'erase', 'rmdir'],
    ['Path'],
    [
      ...filesystem,
      ...mutation,
      ...switches('Recurse Force'),
      ...parameters('Stream DeleteKey', true),
    ],
  ),
  ...['Copy-Item', 'Move-Item'].map((name) =>
    cmdlet(
      name,
      name === 'Copy-Item' ? ['cp', 'cpi', 'copy'] : ['mv', 'mi', 'move'],
      ['Path', 'Destination'],
      [
        ...filesystem,
        ...mutation,
        ...parameters('Destination'),
        ...switches('Force PassThru'),
        ...(name === 'Copy-Item' ? switches('Recurse Container') : []),
        ...parameters('ToSession FromSession', true),
      ],
    ),
  ),
  cmdlet(
    'New-Item',
    ['ni'],
    ['Path'],
    [
      ...parameters('Path ItemType Value'),
      ...parameters('Name Credential UseTransaction', true),
      ...mutation,
      ...switches('Force'),
    ],
  ),
  cmdlet(
    'Out-File',
    ['of'],
    ['FilePath'],
    [
      ...parameters('FilePath Encoding Width InputObject'),
      ...mutation,
      ...switches('Append Force NoClobber NoNewline'),
    ],
    {},
    utility,
  ),
  cmdlet(
    'Test-Path',
    [],
    ['Path'],
    [
      ...filesystem,
      ...parameters('PathType'),
      ...switches('IsValid'),
      ...parameters('OlderThan NewerThan', true),
    ],
  ),
  cmdlet(
    'Get-Location',
    ['pwd', 'gl'],
    [],
    [...switches('Stack'), ...parameters('StackName', true)],
  ),
  cmdlet(
    'Get-Content',
    ['gc', 'cat', 'type'],
    ['Path'],
    [
      ...filesystem,
      ...switches('Force Raw Wait'),
      ...parameters('ReadCount TotalCount Tail Encoding Delimiter Stream'),
    ],
    { fileRead: true },
  ),
  cmdlet(
    'Get-Item',
    ['gi'],
    ['Path'],
    [...filesystem, ...switches('Force'), ...parameters('Stream')],
    { fileRead: true },
  ),
  cmdlet(
    'Get-ChildItem',
    ['gci', 'ls', 'dir'],
    ['Path', 'Filter'],
    [
      ...filesystem,
      ...switches('Force Recurse Name File Directory Hidden ReadOnly System'),
      ...parameters('Depth Attributes'),
    ],
    { fileRead: true },
  ),
  cmdlet(
    'Select-String',
    ['sls'],
    ['Pattern', 'Path'],
    [
      ...parameters('Pattern Path Encoding Context InputObject Include Exclude'),
      { name: 'LiteralPath', aliases: ['PSPath'] },
      ...switches('SimpleMatch CaseSensitive Quiet List AllMatches NotMatch'),
    ],
    { fileRead: true },
    utility,
  ),
  cmdlet(
    'Write-Output',
    ['echo', 'write'],
    ['InputObject'],
    [...parameters('InputObject'), ...switches('NoEnumerate')],
    {},
    utility,
  ),
  ...(
    [
      [
        'Select-Object',
        ['select'],
        'Property',
        'ExcludeProperty ExpandProperty Skip First Last',
        'Unique Wait',
      ],
      ['Sort-Object', ['sort'], 'Property', 'Top Bottom', 'Descending Unique CaseSensitive'],
      [
        'Format-Table',
        ['ft'],
        'Property',
        'GroupBy View',
        'AutoSize HideTableHeaders Wrap Force ShowError DisplayError',
      ],
      ['Format-List', ['fl'], 'Property', 'GroupBy View', 'Force ShowError DisplayError'],
      [
        'Format-Wide',
        ['fw'],
        'Property',
        'Column GroupBy View',
        'AutoSize Force ShowError DisplayError',
      ],
      ['Out-String', [], '', 'Width', 'Stream'],
      [
        'Measure-Object',
        ['measure'],
        'Property',
        '',
        'Sum Average Maximum Minimum Line Word Character IgnoreWhiteSpace',
      ],
    ] as Array<[string, string[], string, string, string]>
  ).map(([name, aliases, positional, values, flags]) =>
    cmdlet(
      name,
      aliases,
      positional ? [positional] : [],
      [
        ...parameters([positional, values].filter(Boolean).join(' ')),
        ...switches(flags),
        ...parameters('InputObject', true),
      ],
      { format: true },
      utility,
    ),
  ),
];

export function powerShellCmdlet(raw: string): PowerShellCmdlet | undefined {
  const parts = raw.toLowerCase().split('\\');
  const name = parts.at(-1);
  if (parts.length > 2) return undefined;
  return POWERSHELL_CMDLETS.find(
    (spec) =>
      (parts.length === 1 || parts[0] === spec.module.toLowerCase()) &&
      (spec.name.toLowerCase() === name || (parts.length === 1 && spec.aliases.includes(name!))),
  );
}
