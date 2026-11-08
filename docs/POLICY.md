# 权限策略 v3

默认 preset 使用 `deterministic` 策略与 `model` 审批员，默认模式 `ask`。所有工具调用仍通过唯一 ToolExecutor，绑定最终参数、工具身份、配置版本、任务范围和执行环境，并在调度后重验。进程内插件属于受信任代码；工具审批本身不提供操作系统隔离。

## 启动信任

项目提供的插件入口、MCP 服务、模型端点、权限扩大和插件配置，在解析凭据、动态导入或 setup 之前审查。CLI 首次使用 `pnpm dev --trust`，阅读实际入口和脱敏范围后输入 `yes`；无交互终端不会自动信任。App 展示同一份启动信任请求。SDK 通过 `approveStartup(request)` 接入宿主的真实用户决定，不应对未知仓库固定返回 true。

信任记录位于用户项目状态目录的 `startup-trust.json`，绑定项目、宿主和具体配置指纹。MCP 在批准后使用冻结的配置快照；入口、端点和授权范围变化重新审查。明确保存模式和授权会记录这次用户决定，不新增二次确认。插件的依赖和进程内 Node 权限属于安装信任范围，不能由 manifest 自报安全。

MCP stdio 默认只继承运行所需的最小环境和独立 HOME；通过 `inheritEnv` 显式列名或 `env` 显式配置的变量才额外传入。模型凭据与动态加载环境不再自动传给普通 Shell。

## 判定顺序与模式

1. 校验参数，运行 PreToolUse 改写，再校验并冻结。
2. 检查任务停止、工具身份和宿主执行约束。
3. 检查原始调用 deny，分析实际资源，再检查真实目标和跨工具资源 deny。
4. 检查敏感参数、危险操作、敏感/项目外路径、平台限制与明确 ask。
5. 匹配已有范围授权、精确规则与已验证普通读取。
6. 应用模式默认，需要时交给 reviewer 或用户。
7. 形成当前调用的一次性执行许可，调度后重验并消费。

| 场景                             | ask  | auto     | yolo         |
| -------------------------------- | ---- | -------- | ------------ |
| 项目内普通读取、受控搜索         | 允许 | 允许     | 允许         |
| 已有授权完整覆盖，且无优先约束   | 允许 | 允许     | 允许         |
| 未授权的完整普通项目写入         | 人工 | reviewer | 允许         |
| 已验证隔离中的未知程序           | 人工 | reviewer | 在边界内允许 |
| 无可验证边界的未知程序、未知 MCP | 人工 | 人工     | 人工         |
| 敏感、危险、项目外、明确 ask     | 人工 | 人工     | 人工         |
| deny                             | 拒绝 | 拒绝     | 拒绝         |

Windows 写入保留额外限制：精确规则或完整调用 Grant 可以生效；未命中时 ask 人工，auto/yolo 的完整普通写入交 reviewer。未知 PowerShell 始终人工。模式保存成功后立即应用，不能替已经弹出的审批作答。

模型仅能处理 policy 返回的 `review`。明确模型 deny 拒绝当前操作，不自动转人工批准；ask/unknown、故障或超时才人工。模型不能创造 Grant、扩大执行环境或越过 deny/明确 ask。未知程序只有宿主实际提供可验证执行边界时才可自动委托。

## 授权范围和拒绝范围

审批动作由后端生成不透明 ID，CLI/App 展示同一组动作并提交 ID。前端不再根据原因码推断能否记住。

- 允许一次：只覆盖当前完整参数。
- 本任务允许相同完整调用：绑定全部 JSON 参数、工具与连接身份、目录、会话及任务，任务结束撤销。
- 本会话允许相同完整调用：不随聊天历史恢复。
- 本任务允许修改某个子目录：仅适用于已验证内置文件工具，仍逐次检查实际路径与保护目标。
- 保存为项目授权：真实写入配置，完成保存后重新判定；冲突或激活失败不会冒充保存成功。
- 拒绝此操作：保留资源/effect 与同义重试约束，允许无关的安全工作。不能证明避开拒绝资源的未知程序也被阻止。
- 停止整个任务：取消根请求及后代、审批和排队调用；迟到批准无效。

普通策略 deny 只拒绝其规则覆盖的操作。显式任务停止才设置请求拒绝锁。子代理默认不能创建共享父授权、持久化项目授权或把一次批准复制给兄弟。

`/permissions` 显示活动授权，`/permissions audit` 显示决策记录，`/permissions revoke <id>` 撤销授权。App 的“活动授权与撤销”提供相同操作；项目撤销同步删除配置和对应信任记录，不能通过放回旧配置复活授权。

## 规则与目录授权

工具规则仍支持 `tool(glob)` 与 `tool(="字面量目标")`。文件路径规则和目录 glob 在完整、已验证的内置文件操作中实际生效；敏感、危险、越界和明确 ask 优先。Shell 的宽文本匹配不证明程序安全，未知程序不因此放行。MCP 精确授权绑定完整 JSON 与连接配置指纹。

显式目录授权在 ask/auto/yolo 都适用，默认空，不存在隐式整项目授权：

```json
{
  "pluginConfig": {
    "agentlab.policy": { "writeRoots": ["src", "tests"] }
  }
}
```

仅已验证内置 write_file/edit_file 使用 writeRoots。真实目标、敏感目录、链接、硬链接、配置及插件入口检查继续优先。Windows 目录授权不能跳过未验证的平台写入限制。目录编辑使用 CAS、原子写和未知字段保留，重启后生效。

跨工具限制使用结构化资源规则，可在 App/CLI 设置的“跨工具资源规则”编辑，重启后生效：

```json
{
  "pluginConfig": {
    "agentlab.policy": {
      "resourceRules": [
        {
          "id": "private-source",
          "action": "deny",
          "effects": ["read"],
          "resource": { "kind": "file", "glob": "src/private/**" }
        }
      ]
    }
  }
}
```

资源路径必须是项目相对 glob，可选 tools 只收窄工具范围。deny/ask 优先于资源 allow 和 Grant。完整操作的全部效果都需要被 allow 覆盖。未知程序或分析失败时，不能证明避开资源 deny 就拒绝该调用；可以继续使用可验证的专用工具。普通 SDK 会话空数组不能清除上层 deny/ask。

## 可选执行隔离

```json
{ "capabilities": { "execution": "project-snapshot" } }
```

内置 `agentlab.execution` 插件提供 Linux bubblewrap 的项目副本执行，默认 execution=false。启动探针必须实际成功；不可用返回 `sandbox_unavailable`，不询问一个无法执行的操作，不自动切换到宿主执行。

隔离环境使用单独的项目副本、HOME、临时目录及 PID/网络命名空间；仅挂载系统运行目录，不挂载真实用户 HOME，不传入模型凭据。快照复用受控搜索，排除敏感文件、symlink、多硬链接、忽略目录、node_modules 和构建输出，并限制文件数量和字节数。命令对子副本的修改不会回写项目，输出明确注明这一范围。因此依赖本地 node_modules 的工作流可能需要额外准备；此实现不宣称支持直接挂载可写项目、联网域名白名单或原生 Windows/macOS 隔离。

## 升级与会话迁移

策略版本从 2.0.0 升级为 3.0.0。旧权限状态不在加载路径静默兼容；先在新会话查看报告，再显式迁移：

```text
/permissions migrate-session <旧会话ID>
/permissions migrate-session <旧会话ID> apply
```

迁移通过会话 CAS 保存，保留消息、ask/deny、计划及拒绝记录，移除临时 allow 并收紧为 ask。不能迁移当前会话、子会话或未知策略版本。迁移不会执行历史工具。已有字符串规则无需转换格式；宽文件 allow 在 v3 中会生效，升级时应审查对应配置范围。

## 分析范围

- 只识别宿主确认属于 `agentlab.local-tools`、版本 `1.0.0` 的内置语义。同名替换、未知版本和 MCP 自称 read 都保留未知副作用。
- `read_file`、`write_file`、`edit_file`：检查完整 JSON 参数、真实路径、项目边界、符号链接、悬空链接、新文件实际父目录、文件类型和硬链接。读写均受保护的目标包括 `.env*`、密钥/凭据、`.ssh` 等目录、`.agentlab` 权限配置、`mcp.json`（可能含 MCP env/headers 令牌）、配置中的插件入口和全部 `.git` 元数据（含 worktree 指针文件）。`AGENTS.md` / `CLAUDE.md` 说明、`agent.config.json` 与 `plugins/` 目录只保护写入：它们是指令/装配入口，篡改有风险，但读取不泄露秘密（密钥通过 `apiKeyEnv` 引用环境变量）。auto 中读取项目内不存在的路径或目录不再询问，由工具返回 ENOENT/EISDIR；仅有项目外或敏感路径仍按原约束询问。多硬链接文件一律视为未验证别名并询问，`node_modules` 也不例外：路径段不能证明 inode 来自 pnpm store，同用户进程可以把项目外密钥硬链接进 `node_modules`；store 同样可被同用户写入，按内容哈希比对 store 也不能证明来源。pnpm 默认以硬链接安装依赖，因此读取这些文件会询问；需要免审批读取依赖源码时可设置 `package-import-method=copy`。
- `glob` / `grep`：分析与执行共用受控目录枚举，只处理项目内普通文件；默认根目录、子目录、递归、空匹配与重复搜索在 auto 中均无需 reviewer 或人工确认。用户 glob 只过滤项目树并用于安全剪枝，不控制外部遍历根。排除隐藏/敏感路径、配置插件入口、symlink、多硬链接文件、node_modules 和 dist；`plugins/`、AGENTS/CLAUDE 说明与 agent.config.json 作为普通文件参与搜索。指向项目内的绝对 pattern（如 `/repo/src/**/*.ts`）在分析与执行中统一转换为项目相对 pattern；含 `..`、指向项目外，或相对部分以 `!`/`#` 开头（minimatch 会解释为取反/注释）的绝对 pattern 不转换，保持字面语义并按项目外要求确认；不使用反斜杠转义，因为 Windows 上反斜杠是路径分隔符。遇到 EACCES/EPERM 的目录或 ignore 文件在分析与执行中一致跳过，不让整次搜索变成 analysis_error。显式敏感、项目外路径及链接逃逸仍要求人工确认。搜索工具始终遵守此范围；需要读取被排除的具体文件时使用 `read_file` 并按策略确认。
- 两种搜索工具统一遵守项目与嵌套 `.gitignore`（使用 `ignore` 包处理 negation）；被排除的父目录不会被子目录规则恢复。显式 pattern/glob 不覆盖 ignore；不读取项目外的全局 ignore 或链接形式的 ignore 配置。`glob('*.ts')` 只匹配当前层，`grep` 的 `glob: '*.ts'` 可匹配各层文件名。
- `grep` 保留宿主提供的 ripgrep 及其正则语义，只向它传入已核验的文件列表，禁用 rg 配置、预处理器与链接跟随，清除相关动态加载环境，使用 `--` 分隔文件参数并分批运行；无 rg 时使用同一候选列表的 JS 正则扫描。空候选不退回目录搜索。宿主安装的 rg 仍是受信任依赖，不能据此宣称任意替换二进制也安全。
- 搜索的 deny/ask 检查原请求与全部候选路径。一个文件的精确 allow 不能授权通配搜索的其他文件；grep 的 regex 精确匹配也不是文件范围授权。ask 模式的已验证项目内递归搜索直接放行；敏感、项目外与明确 ask 仍询问。
- 每次最终重验重新枚举、比较文件集和元数据；执行时再核验并绑定已批准目标。若最终重验后新增候选，返回 `approval_stale`，需要重新搜索，不能把新文件悄悄并入已批准操作。
- Bash 使用成熟 `tree-sitter-bash` 语法树，区分语法解析与具体语义授权。支持字面量命令、单/双引号、转义空格、混合引号、`&&` / `||` / `;` 与只读管道；整条表达式所有命令和选项都要验证。可判定的命令包括 `ls`、`pwd`、`echo`、受限格式 `printf`、`cat`、`head`、`tail`、`wc`、`grep`、`rg`、只列举元数据的 `find`、受控本地仓库 `git status` / `git diff` / `git log`。工具名称本身不能覆盖危险参数。
- `git log` 仅支持当前 HEAD 的提交元数据、数量限制、常用日期与格式输出。格式占位符使用白名单，不接受签名验证、mailmap、notes 或命名配置模板；固定关闭 pager、补丁、外部 diff、textconv、签名验证与 mailmap。`--output`、补丁/统计、任意 revision/pathspec 等不在此确定性路径放行。对象、引用、shallow/grafts 入口仍校验物理边界，不读取工作区或历史 blob 正文。
- 读取内容的目标检查真实路径、敏感/外部作用域、普通文件与硬链接；路径中的符号链接再接 `..` 按内核实际路径语义处理。列表元数据不等同读取秘密内容，因此 `ls -la` 或非 verbose `git status` 可列出 `.env` 文件名，`cat .env` / `git diff -- .env` 仍必须询问。shell 的 deny/ask 同时匹配原命令与解析后的真实目标。
- 确定性计划以固定系统工具和 `bash --noprofile --norc -p` 执行，保留 Bash builtin 的 echo/pwd/printf 语义，环境不继承 BASH_ENV、ENV、导出函数、动态加载器和搜索配置。Git 限定本地普通仓库与固定只读子命令，拒绝执行型配置和外部仓库入口，不开启 pager、外部 diff、textconv、fsmonitor 或网络取回。计划重验与实际执行绑定；目标/环境变化返回 `approval_stale`。
- 重定向、命令/进程替换、变量/算术/通配展开、后台执行、函数、脚本、未知选项与任意子进程不自动放行。反斜杠续行目前明确不确定，避免语法树与 Bash 去续行后的 argv 差异。解析结果给出命令、effects 与 unresolved 原因；不声称能静态推断任意程序目的。
- 递归 grep/rg 保留原工具与过滤语义，不悄悄删掉敏感候选；如果保守候选范围包含敏感/未知文件则询问。Git worktree/gitfile、submodule、partial clone、额外 filter/include 配置等不在确定性支持范围。普通 status 不遍历被忽略的 node_modules 或禁用的 hooks；diff/log 额外验证对象/引用存储，超过 20,000 项扫描预算明确回退审批。已安装系统工具是受信任依赖，不引入恶意宿主二进制的无限威胁模型。Windows/UNC/盘符路径在非 Windows 环境不会被误解成安全相对路径；未验证的 PowerShell 语义不进入确定性允许。

原生 Windows 上，内置 read_file/glob/grep 保留与其他平台相同的真实路径、边界、敏感名称、链接、多硬链接、文件类型和受控搜索检查。项目内完整读取在 ask/auto/yolo 直接放行（safe_read），不调用 reviewer。用户 deny 优先终止，明确 ask 优先询问；敏感、项目外和歧义路径仍需人工。NTFS ADS、设备名、8.3 短名、junction 等原生语义尚未实机验收。

### PowerShell 的完整分析与边界

工具名仍为 bash，Windows 实际解释器是 powershell.exe（Windows PowerShell 5.1）。独立 tree-sitter-powershell AST 解析整条语句列表、普通管道和文件/流重定向；命令名、参数缩写与默认别名先规范化，再绑定位置参数。缩写必须在完整参数集合中唯一，不在支持子集中猜测；未支持参数也参与消歧。Path/LiteralPath 参数集、大小写、参数次序、冒号值及静态布尔开关均保留明确语义。

当前可以验证字面 Set-Content/sc、Add-Content/ac、Clear-Content/clc、Remove-Item/rm/ri/rd/del/erase/rmdir、Copy-Item/cp/cpi/copy、Move-Item/mv/mi/move、显式 ItemType File 的 New-Item/ni、Out-File/of、Test-Path、Get-Location/pwd/gl 和 Write-Output/echo/write。每个已知文件操作复用通用路径检查和环境绑定；复制/移动到已有目录会分类目录下实际目标文件，移动同时分类源写入。删除磁盘根的危险性来自规范化语义，不依赖拼写或参数排列。删除/复制/移动链接本身、目录树操作仍无法完整验证。完整普通文件操作的精确原命令规则可授权；未命中时，纯文件写入在 ask 人工确认，auto/yolo 委托 reviewer（powershell_write_review），与原生文件工具的平台写入约束一致。writeRoots 不授权 Shell。

Get-Content、Get-Item、Get-ChildItem、Select-String 及默认别名与静态格式化管道组成的纯文件 Shell 仍直接拒绝（use_dedicated_tool），引导 read_file/glob/grep，不交给模型或人工批准。Get-ChildItem 的 provider 枚举没有被冒充为专用搜索工具的受控枚举。Test-Path 和 Get-Location 的完整项目内元数据读取可直接放行。

单引号字符串（含双写单引号）与无插值/转义的双引号可解码；分号、换行和普通静态管道必须整条分析。静态 Write-Output/Get-Content 管道可给固定目标的 Set-Content/Add-Content 提供内容；Out-File 必须有显式固定目标。格式化仅完整验证 Write-Output/Get-Content/Test-Path 的原始标量数据；FileInfo/PathInfo 等对象 getter 与属性投影可能访问更广路径，保持未知。其他对象/路径管道绑定未支持。文件重定向也分类真实写入目标；流合并不制造文件目标。批准的完整 cmdlet 以模块限定名、完整参数和单引号字面值执行，执行前核对同一解析契约；文件/环境变化由唯一 Executor 重验。

变量、插值、子表达式、splat、脚本块、函数/别名修改、调用运算符、混合引号/转义、数组、多目标通配、非文件 provider、tilde、drive-relative 路径、未知参数/命令，以及语法树错误/缺失节点均保留 partial/unknown（powershell_unresolved）。普通 Git/npm 等原生程序会读取配置或执行脚本，目前没有 PowerShell 的完整原生程序契约，git status/log 也不被伪称已验证安全；它们仍可在人工授权后执行。UNC、ADS、保留设备名、短名和尾随点/空格仍使用平台人工约束。这些未知情况在所有模式下先人工确认，精确 allow、yolo 或模型 allow 均不能补全缺失语义。

只有已完整分类、排除敏感/项目外/危险与用户限制的普通操作，才能在 auto 进入 ModelReviewer；yolo 对未完整分类的操作仍人工，完整普通写入也委托 reviewer。这里 complete 仅指已声明子集的解析和通用文件前提完整，不声称原生 Windows 安全已实机验收，也不证明任意程序没有副作用。reviewer 明确 deny 终止调用，绝不自动转成批准；ask/unknown、失败、超时、非法输出或不可用才回到人工。面板显示 PowerShell。后端为可记忆的完整普通 PowerShell 调用提供完整参数 Grant 动作，包括仅 execute effect 的静态输出；未知 PowerShell、歧义路径、未验证实现、明确 ask、敏感/外部目标、grep/glob 和子代理请求仍隐藏不能生效的记住选项。

参数与别名依据 [Microsoft 的解析说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-5.1)、[Remove-Item](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/remove-item?view=powershell-5.1)、[Set-Content](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/set-content?view=powershell-5.1)；语法树使用 [tree-sitter-powershell](https://github.com/airbus-cert/tree-sitter-powershell)。语法树是解析器，不是任意 PowerShell 程序的安全证明。

写入例外：内置 `write_file` / `edit_file` 先执行与其他平台相同的通用写入分析（真实路径、项目边界、敏感与写保护目标、配置插件入口、链接逃逸、多硬链接、非普通文件、新文件实际父目录），只有判定为项目内完整写入且路径不含歧义形态时才标记为 `native_windows_write_unverified`（`completeness` 保持 `complete`，平台风险由 reason code 与证据表达）。随后：命中用户配置的精确目标 allow 规则或完整调用 Grant（`write_file(="src/a.ts")` 或不含通配符的模式）直接放行（`exact_allow`），ask 模式同样适用。未命中时 ask 人工确认（`platform_write_ask`），auto/yolo 委托 reviewer（`platform_write_review`）。模型要求确认或不可用时才人工，记住的精确规则之后直接放行。通配规则（如 `write_file`、`write_file(src/*)`）与 `writeRoots` 不能直接放行 Windows 写入，最多进入模型审批；yolo 在 Windows 上也不确定性放行写入。这比 Linux 更严格，是有意为之。敏感/写保护/配置插件入口/项目外/多硬链接/歧义路径目标在通用检查阶段即返回人工确认，精确规则也不能放行；用户 deny/ask 规则仍优先；Windows 文件路径限制按大小写不敏感匹配，以保护尚未创建的大小写变体目标，allow 不因此扩大，Shell 命令与 grep 正则仍保持字面语义。原始路径普通、但规范化目标或项目根含 Windows 歧义形式时，同样必须人工确认，不能退回通用自动放行。批准后执行前重验保持绑定：审批期间目标被替换为硬链接别名等变化会重新评估为人工确认。

平台判断可通过 `platform` 选项注入，Windows 分支测试因此在所有宿主上运行。Linux 上的 Windows 字符串样例仅验证保守分类，不宣称证明了 Windows 安全。工具执行仍保留平台适配；平台适配不等于已经完成安全分析验收。

目录和文件检查缩短审批到执行之间的过时窗口，不能提供对恶意外部进程的原子文件系统隔离。批准后会重验实际路径、脚本/配置状态、工具身份、最终参数、配置/policy revision、会话和取消状态；变化要求重新评估或终止。

## 缓存与观测

解析缓存只保存纯语法结果。键覆盖完整参数、工具拥有者/版本、分析器版本、cwd、配置/policy revision 和策略选项。每次重新读取文件系统与环境，不缓存文件安全状态，不缓存 allow，不跨调用复用批准。

`ToolAnalysis` 保留完整度、目标、effects、来源证据和环境指纹。每阶段有 `reasonCode`；执行审计包含 run/tool/request ID 和版本，judge 请求/usage 通过 `toolRequestId` 关联，模型用途仍为 `judge`。默认 JSONL 不写参数正文。

## 主要代码与回归

- `src/builtin/policy/`：版本化策略、文件分析、显式目录授权与设置
- `src/tools/shell-readonly.ts`：Bash AST、逐命令参数语义、受控执行合约
- `src/tools/powershell.ts` / `src/tools/powershell-cmdlets.ts`：PowerShell AST、字面参数绑定与模块限定执行命令
- `tests/powershell-permission-chain.test.ts`：真实 analyzer → policy → ModelReviewer → ToolExecutor；仅 Shell 执行使用无副作用替身，受控 provider 核对完整证据；敏感/外部/别名/参数/未知/deny/ask/重验与 PR #30 读取回归
- `tests/powershell-permission-pty.test.ts`：Linux 原样 pnpm dev 实际审批与详情；注入 Windows policy 验证摘要，拒绝所有 Shell，只实际执行普通 read_file
- `tests/deterministic-policy.test.ts`：优先级、路径、链接、凭据、Windows、Shell、MCP、缓存与环境变化
- `tests/auto-readonly-scope.test.ts`：auto 只读放行矩阵（缺失/目录读取、说明与插件目录读写区分、多硬链接含外部密钥硬链接进 node_modules、绝对 glob 及开头 `!`、无权限目录）与零审批端到端
- `tests/windows-remembered-write-rules.test.ts`：注入 win32 平台，覆盖精确/会话记住规则直接放行写入、通配规则与 writeRoots 不直接放行、未命中→模型审批、ask 模式、敏感/写保护/项目外/硬链接/歧义路径与 bash→人工、deny 优先、Linux 行为不变、真实严格审查合约可返回 allow，以及 ToolExecutor 端到端（记住规则只询问一次、执行前重验绑定）
- `tests/windows-readonly-review.test.ts`：注入 win32 平台，覆盖项目内只读（含 ask 模式）直接放行、写入/无精确规则的 Shell/敏感/项目外/歧义路径→人工，以及只读不调用 reviewer 的端到端
- `tests/windows-policy-path-guards.test.ts`：Windows 路径 deny/ask 大小写限制、真实路径歧义、目标替换重验，以及非 Windows 和命令/正则字面语义不变
- `tests/windows-default-runtime.test.ts`：默认 runtime、真实 reviewer + FakeProvider 的写入执行、会话规则与显式持久化规则重启回归；仅注入平台，不代表 Windows 实机验收
- `tests/windows-permission-ui.test.ts`：Windows 项目内只读（含 ask 模式）零 reviewer/零人工；前端只渲染后端动作；普通写入回退可提供完整调用授权
- `tests/policy-runtime.test.ts`：真实 runtime 中 reviewer 次数和拒绝边界
- `tests/search-runtime.test.ts` / `tests/search-tools.test.ts`：真实 rg/fallback、全部常用只读工具、零 judge/零人工、ignore、敏感/外部/规则与重验竞态
- `tests/shell-runtime.test.ts` / `tests/shell-contract-binding.test.ts`：真实 Bash 输出、审批次数、组合/参数/路径与执行绑定
- `tests/cli-pty.test.ts` / `tests/helpers/pty.ts`：Linux 真 PTY 运行仓库原样 pnpm dev，原命令、auto 单选保存与重启后零审批；共用 Vitest 入口，无额外 npm 依赖
- `tests/tool-executor.test.ts`：最终输入、一次批准绑定、故障回退、取消/迟到结果与唯一门控
