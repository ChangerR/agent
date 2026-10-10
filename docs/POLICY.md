# 确定性权限策略

默认 preset 选择唯一内置策略 `deterministic`（插件 `agentlab.policy`）和严格审批员 `model`（插件 `agentlab.reviewer-model`），默认模式为 `ask`。插件是受信任的同进程代码，本文的审批门控、类型和路径检查都不是操作系统沙箱。

## 默认策略与审批顺序

默认配置无需选择另一套策略；以下配置明确写出默认选择：

```json
{
  "capabilities": { "policy": "deterministic" },
  "pluginConfig": {
    "agentlab.policy": { "writeRoots": [] }
  }
}
```

审批顺序是：

1. 明确 `deny`
2. 不能由模型降级的约束：敏感/项目外目标、未验证的平台路径、特殊文件、硬链接别名、危险 Shell
3. 明确 `ask`
4. 已完整验证操作的精确目标规则
5. `ask` 模式默认询问
6. 显式 `writeRoots` 目录授权；已验证的普通文件读取与受控项目搜索
7. `yolo` 仅跳过完整验证的普通项目文件写入；未知操作仍询问
8. `auto` 的剩余不确定操作可委托一次 reviewer；缺少 reviewer、非法输出、unknown、失败或超时均不会自动放行

会话规则只在同一 action 类别内优先于配置规则，不会让 session allow 越过配置 ask/deny。

精确规则使用 JSON 字面量目标，例如 `write_file(="src/new.ts")`，或不含 glob 元字符的字面量模式。其权限范围仍按实际匹配字段解释：文件规则匹配路径，不声称同时限定内容。宽泛的 `write_file` 或 `write_file(src/**)` 不足以让未知操作自动执行。敏感路径和不完整效果也不能借精确规则放行。

已知文件工具与搜索工具还会用全部实际候选的真实绝对路径与项目相对路径匹配 deny/ask，避免 `./`、`..` 或符号链接别名绕过相同文件的 ask/deny。

## 可量化的显式目录写入授权

已完整验证的普通项目文件读取不需要模型审批。用户还可以明确授权一个项目写入目录：

```json
{
  "permissionMode": "auto",
  "capabilities": { "policy": "deterministic", "reviewer": "model" },
  "pluginConfig": {
    "agentlab.policy": { "writeRoots": ["src"] }
  }
}
```

这表示在新的 auto 会话中，允许已知内置 `write_file` / `edit_file` 对 `src` 内普通文件进行完整、已验证的写入。默认目录列表为空，不存在隐式整项目写授权。项目外目录、敏感目录和非目录根会被拒绝；不存在的目录必须有可验证的目录父节点。

目标和授权根都会实时解析真实路径；新文件使用实际存在的父目录。规则 deny/ask、凭据、说明与权限配置、插件入口、`.git/hooks`、硬链接及外部符号链接约束仍优先。其他工具即使叫 `write_file` 也不能继承这份授权。`ask` 模式仍要求本次确认或精确规则，不因目录授权跳过默认询问。

`/settings` 中的“明确写入目录授权”支持独立输入、验证和一次提交自动保存，无额外确认；保存走配置 fingerprint/CAS、原子写、未知字段保留和符号链接保护。保存只改变下一会话配置，不热更新活动策略。更改写入目录属于明确扩大授权范围，界面说明这一含义。

离线 FakeProvider 回归覆盖显式目录授权、未授权目录、敏感文件和未知工具；确定性放行不代表真实模型成本、准确率或网络延迟结论。

## 分析范围

- 只识别宿主确认属于 `agentlab.local-tools`、版本 `1.0.0` 的内置语义。同名替换、未知版本和 MCP 自称 read 都保留未知副作用。
- `read_file`、`write_file`、`edit_file`：检查完整 JSON 参数、真实路径、项目边界、符号链接、悬空链接、新文件实际父目录、文件类型和硬链接。受保护目标包括 `.env*`、密钥/凭据、`.ssh` 等目录、agent/MCP/权限配置、AGENTS/CLAUDE 说明、插件入口和全部 `.git` 元数据（含 worktree 指针文件）。配置中的自定义插件入口也受保护。
- `glob` / `grep`：分析与执行共用受控目录枚举，只处理项目内普通文件；默认根目录、子目录、递归、空匹配与重复搜索在 auto 中均无需 reviewer 或人工确认。用户 glob 只过滤项目树并用于安全剪枝，不控制外部遍历根。排除隐藏/敏感路径、配置插件入口、symlink、多硬链接文件、node_modules 和 dist；显式敏感、项目外路径及链接逃逸仍要求人工确认。搜索工具始终遵守此范围；需要读取被排除的具体文件时使用 `read_file` 并按策略确认。
- 两种搜索工具统一遵守项目与嵌套 `.gitignore`（使用 `ignore` 包处理 negation）；被排除的父目录不会被子目录规则恢复。显式 pattern/glob 不覆盖 ignore；不读取项目外的全局 ignore 或链接形式的 ignore 配置。`glob('*.ts')` 只匹配当前层，`grep` 的 `glob: '*.ts'` 可匹配各层文件名。
- `grep` 保留宿主提供的 ripgrep 及其正则语义，只向它传入已核验的文件列表，禁用 rg 配置、预处理器与链接跟随，清除相关动态加载环境，使用 `--` 分隔文件参数并分批运行；无 rg 时使用同一候选列表的 JS 正则扫描。空候选不退回目录搜索。宿主安装的 rg 仍是受信任依赖，不能据此宣称任意替换二进制也安全。
- 搜索的 deny/ask 检查原请求与全部候选路径。一个文件的精确 allow 不能授权通配搜索的其他文件；grep 的 regex 精确匹配也不是文件范围授权。ask 模式的递归搜索仍询问。
- 每次最终重验重新枚举、比较文件集和元数据；执行时再核验并绑定已批准目标。若最终重验后新增候选，返回 `approval_stale`，需要重新搜索，不能把新文件悄悄并入已批准操作。
- Bash 使用成熟 `tree-sitter-bash` 语法树，区分语法解析与具体语义授权。支持字面量命令、单/双引号、转义空格、混合引号、`&&` / `||` / `;` 与只读管道；整条表达式所有命令和选项都要验证。可判定的命令包括 `ls`、`pwd`、`echo`、受限格式 `printf`、`cat`、`head`、`tail`、`wc`、`grep`、`rg`、只列举元数据的 `find`、受控本地仓库 `git status` / `git diff`。工具名称本身不能覆盖危险参数。
- 读取内容的目标检查真实路径、敏感/外部作用域、普通文件与硬链接；路径中的符号链接再接 `..` 按内核实际路径语义处理。列表元数据不等同读取秘密内容，因此 `ls -la` 或非 verbose `git status` 可列出 `.env` 文件名，`cat .env` / `git diff -- .env` 仍必须询问。shell 的 deny/ask 同时匹配原命令与解析后的真实目标。
- 确定性计划以固定系统工具和 `bash --noprofile --norc -p` 执行，保留 Bash builtin 的 echo/pwd/printf 语义，环境不继承 BASH_ENV、ENV、导出函数、动态加载器和搜索配置。Git 限定本地普通仓库与固定只读子命令，拒绝执行型配置和外部仓库入口，不开启 pager、外部 diff、textconv、fsmonitor 或网络取回。计划重验与实际执行绑定；目标/环境变化返回 `approval_stale`。
- 重定向、命令/进程替换、变量/算术/通配展开、后台执行、函数、脚本、未知选项与任意子进程不自动放行。反斜杠续行目前明确不确定，避免语法树与 Bash 去续行后的 argv 差异。解析结果给出命令、effects 与 unresolved 原因；不声称能静态推断任意程序目的。
- 递归 grep/rg 保留原工具与过滤语义，不悄悄删掉敏感候选；如果保守候选范围包含敏感/未知文件则询问。Git worktree/gitfile、submodule、partial clone、额外 filter/include 配置等不在确定性支持范围。普通 status 不遍历被忽略的 node_modules 或禁用的 hooks；diff 额外验证对象/引用存储，超过 20,000 项扫描预算明确回退审批。已安装系统工具是受信任依赖，不引入恶意宿主二进制的无限威胁模型。Windows/UNC/盘符路径在非 Windows 环境不会被误解成安全相对路径；未验证的 PowerShell 语义不进入确定性允许。

原生 Windows 的文件系统授予目前明确禁用：NTFS ADS、设备名、尾随点/空格和 PowerShell 的完整语义尚未实机验收，已知本地工具统一返回不可降级的人工询问，writeRoots、精确规则和 yolo 都不能绕过。Linux 上的 Windows 字符串样例仅验证保守分类，不宣称证明了 Windows 安全。工具执行仍保留平台适配；平台适配不等于已经完成安全分析验收。

目录和文件检查缩短审批到执行之间的过时窗口，不能提供对恶意外部进程的原子文件系统隔离。批准后会重验实际路径、脚本/配置状态、工具身份、最终参数、配置/policy revision、会话和取消状态；变化要求重新评估或终止。

## 缓存与观测

解析缓存只保存纯语法结果。键覆盖完整参数、工具拥有者/版本、分析器版本、cwd、配置/policy revision 和策略选项。每次重新读取文件系统与环境，不缓存文件安全状态，不缓存 allow，不跨调用复用批准。

`ToolAnalysis` 保留完整度、目标、effects、来源证据和环境指纹。每阶段有 `reasonCode`；执行审计包含 run/tool/request ID 和版本，judge 请求/usage 通过 `toolRequestId` 关联，模型用途仍为 `judge`。默认 JSONL 不写参数正文。

## 主要代码与回归

- `src/builtin/policy/`：版本化策略、文件分析、显式目录授权与设置
- `src/tools/shell-readonly.ts`：Bash AST、逐命令参数语义、受控执行合约
- `tests/deterministic-policy.test.ts`：优先级、路径、链接、凭据、Windows、Shell、MCP、缓存与环境变化
- `tests/policy-runtime.test.ts`：真实 runtime 中 reviewer 次数和拒绝边界
- `tests/search-runtime.test.ts` / `tests/search-tools.test.ts`：真实 rg/fallback、全部常用只读工具、零 judge/零人工、ignore、敏感/外部/规则与重验竞态
- `tests/shell-runtime.test.ts` / `tests/shell-contract-binding.test.ts`：真实 Bash 输出、审批次数、组合/参数/路径与执行绑定
- `tests/cli-pty.test.ts` / `tests/helpers/pty.ts`：Linux 真 PTY 运行仓库原样 pnpm dev，原命令、auto 单选保存与重启后零审批；共用 Vitest 入口，无额外 npm 依赖
- `tests/tool-executor.test.ts`：最终输入、一次批准绑定、故障回退、取消/迟到结果与唯一门控
