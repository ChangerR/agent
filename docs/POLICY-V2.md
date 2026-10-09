# 可选确定性策略 v2

默认 preset 仍选择 `legacy-v1` 和 `model-v1`。注册 v2 不等于启用；旧配置不会在启动时重写。插件是受信任的同进程代码，本文的审批门控、类型和路径检查都不是操作系统沙箱。

## 显式选择与兼容差异

在新的会话配置中显式选择：

```json
{
  "capabilities": { "policy": "deterministic-v2" },
  "pluginConfig": {
    "agentlab.policy-deterministic-v2": { "writeRoots": [] }
  }
}
```

审批顺序是：

1. 明确 `deny`
2. 不能由模型降级的约束：敏感/项目外目标、未验证的平台路径、特殊文件、硬链接别名、危险 Shell
3. 明确 `ask`
4. 已完整验证操作的精确目标规则
5. `ask` 模式默认询问
6. 显式 `writeRoots` 目录授权；已验证的普通文件读取
7. `yolo` 仅跳过完整验证的普通项目文件写入；未知操作仍询问
8. `auto` 的剩余不确定操作可委托一次 reviewer；缺少 reviewer、非法输出、unknown、失败或超时均不会自动放行

这有意区别于 v1 的 `allow` 先于 `ask`。`previewRuleConflicts()` 和 `/policy-migrate preview` 只展示冲突，不写配置。复杂 glob 的交集无法静态确定时标为 `potential`，不宣称已经精确证明冲突。会话规则只在同一 action 类别内优先于配置规则，不会让 session allow 越过配置 ask/deny。

精确规则是旧语法中的 JSON 字面量目标，例如 `write_file(="src/new.ts")`，或不含 glob 元字符的字面量模式。其权限范围仍按实际匹配字段解释：文件规则匹配路径，不声称同时限定内容。宽泛的 `write_file` 或 `write_file(src/**)` 不足以让未知操作在 v2 中自动执行。敏感路径和不完整效果也不能借精确规则放行。

已知文件工具还会用真实绝对路径与项目相对路径匹配规则，避免 `./`、`..` 或符号链接别名绕过相同文件的 ask/deny。这也是明确属于 v2 的语义，不反向改变 legacy 匹配器。

## 可量化的显式目录写入授权

v1 auto 本来已经放行 read 风险工具。因此“安全文件读取不用模型”是安全性质，不被当作新增节省。v2 的新增可测量路径是用户明确授权一个写入目录：

```json
{
  "permissionMode": "auto",
  "capabilities": { "policy": "deterministic-v2", "reviewer": "model-v2" },
  "pluginConfig": {
    "agentlab.policy-deterministic-v2": { "writeRoots": ["src"] }
  }
}
```

这表示在新的 v2 auto 会话中，允许已知内置 `write_file` / `edit_file` 对 `src` 内普通文件进行完整、已验证的写入。默认目录列表为空，不存在隐式整项目写授权。项目外目录、敏感目录和非目录根会被拒绝；不存在的目录必须有可验证的目录父节点。

目标和授权根都会实时解析真实路径；新文件使用实际存在的父目录。规则 deny/ask、凭据、说明与权限配置、插件入口、`.git/hooks`、硬链接及外部符号链接约束仍优先。其他工具即使叫 `write_file` 也不能继承这份授权。`ask` 模式仍要求本次确认或精确规则，不因目录授权跳过默认询问。

`/settings` 中的“v2 明确写入目录授权”支持独立草稿、验证和显式保存；保存走配置 fingerprint/CAS、原子写、未知字段保留和符号链接保护。保存只改变下一会话配置，不热更新活动策略。更改写入目录属于明确扩大授权范围，界面说明这一含义。

离线 FakeProvider 回归用同一个普通源码写入证明：legacy auto 需要一次 judge；显式选择 v2 并配置 `writeRoots:["src"]` 时为零次；未授权目录、敏感文件和未知插件没有得到同样放行。这不是模型价格、准确率或真实网络延迟结论。

## 分析范围

- 只识别宿主确认属于 `agentlab.local-tools`、版本 `1.0.0` 的内置语义。同名替换、未知版本和 MCP 自称 read 都保留未知副作用。
- `read_file`、`write_file`、`edit_file`：检查完整 JSON 参数、真实路径、项目边界、符号链接、悬空链接、新文件实际父目录、文件类型和硬链接。受保护目标包括 `.env*`、密钥/凭据、`.ssh` 等目录、agent/MCP/权限配置、AGENTS/CLAUDE 说明、插件入口和全部 `.git` 元数据（含 worktree 指针文件）。配置中的自定义插件入口也受保护。
- `glob`：只有字面量、可验证的普通文件目标能够给出完整分析。递归模式、扩展 glob 与未展开目标不被当作完整的只读证明；绝对/父目录逃逸及敏感目标仍被约束。
- `grep`：递归扫描、ripgrep 配置和实现选择仍是不完整证据，不做确定性放行。
- Shell 字面量解析子集包含单条 `pwd`、无选项字面量 `echo`、受限 `%s` 的 `printf`。这里只证明语法，不证明实际解释器安全。当前内置 POSIX 执行是 `bash -c`，仍存在 PATH、BASH_ENV、继承函数等环境前提；所以所有实际 bash 调用仍 defer，不会因为字面量子集命中就自动放行。
- 重定向、替换、变量展开、复杂组合、npm/pnpm 构建测试脚本、git alias/config 和外部命令均不被称为只读。Windows/UNC/盘符路径在非 Windows 环境不会被误解成安全相对路径；未验证的 PowerShell 语义不进入确定性允许。

原生 Windows 的 v2 文件系统授予目前明确禁用：NTFS ADS、设备名、尾随点/空格和 PowerShell 的完整语义尚未实机验收，已知本地工具统一返回不可降级的人工询问，writeRoots、精确规则和 yolo 都不能绕过。Linux 上的 Windows 字符串样例仅验证保守分类，不宣称证明了 Windows 安全。legacy 的跨平台执行功能保持原有行为。

目录和文件检查缩短审批到执行之间的过时窗口，不能提供对恶意外部进程的原子文件系统隔离。批准后会重验实际路径、脚本/配置状态、工具身份、最终参数、配置/policy revision、会话和取消状态；变化要求重新评估或终止。

## 缓存、观测与 shadow

解析缓存只保存纯语法结果。键覆盖完整参数、工具拥有者/版本、分析器版本、cwd、配置/policy revision 和策略选项。每次重新读取文件系统与环境，不缓存文件安全状态，不缓存 allow，不跨调用复用批准。

`ToolAnalysis` 保留完整度、目标、effects、来源证据和环境指纹。每阶段有 `reasonCode`；执行审计包含 run/tool/request ID 和版本，judge 请求/usage 通过 `toolRequestId` 关联，模型用途仍为 `judge`。默认 JSONL 不写参数正文。

`legacy-shadow` 仍以 v1 结果决定实际执行。候选 v2 只做本地分析；不会执行工具、写配置、修改活动控制器或调用付费模型。离线样例中的授权与标注是测试数据，不能成为真实用户的授权。所有 v2 allow / v1 非 allow 的差异都必须单独解释并人工审核。录制的 reviewer 结果是独立对照数据，不是审批缓存。

## 主要代码与回归

- `src/builtin/policy-deterministic-v2/`：版本化策略、文件/字面量语法分析、显式目录授权与设置
- `tests/deterministic-policy.test.ts`：优先级、路径、链接、凭据、Windows、Shell、MCP、缓存与环境变化
- `tests/policy-v2-runtime.test.ts`：真实 runtime 中 v1/v2 reviewer 次数和拒绝边界
- `tests/tool-executor.test.ts`：最终输入、一次批准绑定、故障回退、取消/迟到结果与唯一门控
