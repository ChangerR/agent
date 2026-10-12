# Auto 权限实现对照与完整工作流验收

## 结论与证据范围

本次不能把其他产品的「auto」名称当作本项目的安全语义：Pi 默认没有工具权限审批，Kimi Code 的 auto 是 Never Ask。本项目保留「确定性规则 → 真实 ModelReviewer → 必要时人工 → 唯一 ToolExecutor」路径；扩大可证明读取范围、减少审批输入重复，不关闭 reviewer，不采用整串普通命令白名单。

研究日期为 2026-10-12，直接读取以下官方源代码快照（版本号是快照 package.json 声明，不冒充发布标签）：

| 项目            | 当前官方仓库与固定提交                                                                                                 | 源码声明版本 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| Pi coding agent | [earendil-works/pi，77332f7](https://github.com/earendil-works/pi/tree/77332f7a34f957f495e23a1b02c70f95db85ad22)       | 1.1.0        |
| Kimi Code       | [MoonshotAI/kimi-code，c151d5a](https://github.com/MoonshotAI/kimi-code/tree/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9) | 2.1.1        |

[Pi 官网](https://pi.dev/) 指向 earendil-works/pi；旧 badlogic/pi-mono 地址已重定向。[MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli) 已归档并指向 kimi-code。因此不以旧 Python kimi-cli 或旧 Pi 仓库布局推断当前实现。只读取公开文档、源码，未执行这两个项目，未连接真实模型。

## 权限与执行对照

### Pi

- **默认行为和信任**：README 明确没有内建限制文件、进程、网络或凭据的权限系统，默认继承启动进程权限。项目 trust 针对 `.pi` 配置、扩展、skills、prompts 和系统提示加载；允许记住项目、父目录或本次会话。它不是逐工具操作授权。[默认权限说明](https://github.com/earendil-works/pi/blob/77332f7a34f957f495e23a1b02c70f95db85ad22/README.md)、[project-trust](https://github.com/earendil-works/pi/blob/77332f7a34f957f495e23a1b02c70f95db85ad22/packages/coding-agent/src/core/project-trust.ts)
- **Bash**：默认本地实现直接选择 shell 并 spawn，配置 cwd、环境、超时和进程树终止，没有本项目意义上的 AST 只读证明或 LLM 审批员。[bash.ts](https://github.com/earendil-works/pi/blob/77332f7a34f957f495e23a1b02c70f95db85ad22/packages/coding-agent/src/core/tools/bash.ts)
- **审批、deny、沙箱**：permission-gate 是可选扩展示例，用危险命令正则和 UI 确认；无 UI 时可阻止。sandbox 也是可选扩展示例，使用 sandbox-runtime，仅包 Bash；整进程容器是另一种部署边界。不能把这些示例当作默认启用的确定性分析或权限记忆系统。[permission-gate](https://github.com/earendil-works/pi/blob/77332f7a34f957f495e23a1b02c70f95db85ad22/packages/coding-agent/examples/extensions/permission-gate.ts)、[sandbox 示例](https://github.com/earendil-works/pi/blob/77332f7a34f957f495e23a1b02c70f95db85ad22/packages/coding-agent/examples/extensions/sandbox/index.ts)、[容器边界](https://github.com/earendil-works/pi/blob/77332f7a34f957f495e23a1b02c70f95db85ad22/packages/coding-agent/docs/containerization.md)
- **模型失败、子任务与 TUI**：默认没有审批模型，故不存在对应的 judge 预算/unknown/provider 故障语义；不能把主模型失败等同于审批失败。官网说明核心默认无 subagents、Plan mode 或权限弹窗，这些可用扩展实现，不能推断任意第三方扩展的子任务权限继承。[官网设计说明](https://pi.dev/)

### Kimi Code

- **模式名称**：当前 TUI/交互文档的 manual 是 Always Ask（默认），yolo 是 Ask When Needed，auto 是 Never Ask。名称不能与 AgentLab 一一对应。源码的首个匹配策略顺序是：auto 禁止 AskUserQuestion → 用户 deny → 危险命令 ask（非交互时省略）→ auto approve → 会话批准历史 → 用户 ask → 用户 allow → 敏感文件 ask → Git 控制路径 ask → yolo approve → 默认工具 approve → Git 工作区写入 approve → fallback ask。注意危险检测策略自身在 auto 下直接返回未命中；因此 auto 保留用户显式 deny，但跳过危险检测和后续人工 ask。它不是模型审查模式。[当前交互说明](https://moonshotai.github.io/kimi-code/en/guides/interaction)、[策略顺序](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/permissionPolicy/permissionPolicyService.ts)
- **普通读写**：默认 approve 工具含 Read/Grep/Glob 和 Agent/AgentSwarm，不含 Bash。manual 下普通 Bash 可落入 ask；部分 Git 工作区普通写入也可由策略批准，因此「manual 每个写都询问」并不准确。[默认工具](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/permissionPolicy/policies/default-tool-approve.ts)、[工作区写入](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/permissionPolicy/policies/git-cwd-write-approve.ts)
- **AST 与边界**：危险命令检测使用 tree-sitter-bash，有 500ms/10000 节点限制，递归检查部分 wrapper/eval/嵌套 shell。它在找已知危险命令，不是为所有文件效果建立只读证明；解析不明时 manual 可 ask，而 yolo 不因此必然阻止。Bash 的审批信息提供命令和精确匹配规则，不完整枚举任意 Bash 文件访问，不能从专用文件工具的 sensitive-path 检查推断任意 Bash 都被路径沙箱约束。[危险检测](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/permissionPolicy/policies/dangerous-command-ask.ts)、[Bash 工具](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts)
- **规则、拒绝及错误**：permission gate 在执行前 approve/ask/veto，人工拒绝产生 veto；审批异常会报告并抛出，除非调用者提供自定义错误处理。会话批准记录保存批准的 pattern，只有 session scope 才记住并去重；永久配置规则另有 config.toml 入口。没有与本项目等价的 LLM judge 请求预算或 provider 失败兜底层。[permission gate](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts)、[approval service](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/toolApproval/toolApprovalService.ts)、[规则操作](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/agent/permissionRules/permissionRulesOps.ts)、[配置文档](https://moonshotai.github.io/kimi-code/en/configuration/config-files)
- **子任务、运行时与 TUI**：spawn 显式复制调用者 permission mode；fresh/fork 构造和状态继承不同，不能断言 fresh 自动复制全部父会话批准记录。本地 Bash 使用主机进程，项目目录不是默认 OS 沙箱；Windows 文档要求 Git Bash。TUI 的审批选项和模式切换应与实际有序策略一起理解，不能只看按钮名字。[subagentService](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/packages/agent-core-v2/src/session/subagent/subagentService.ts)、[审批面板](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/apps/kimi-code/src/tui/components/dialogs/approval-panel.ts)

## 本项目差距与本次处置

| 观察到的差距                                                          | 处置与边界                                                                                                                                                                                         |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 常用 cd/管道/find/wc 替换无法证明，导致普通读取走模型甚至人工         | 修复 AST 目录状态和参数语义；Linux 上约束执行并绑定实际读取对象。原形命令 220/300 文件逐字输出一致，规则通过，0 模型、0 人工。详见 [Bash 专项报告](BASH_READONLY.md)。                             |
| 新 cd 组合最初只绑定动态 wc，普通 cat/head/tail/wc 字面量操作数仍回退 | 新增窄范围字面量文件描述符绑定，保留原参数顺序和旧式数字参数；wc 恢复原标签。head/tail 多文件头、wc 同文件不同标签等未证明格式继续回退。                                                           |
| 200 文件审批证据约 89KB，请求中重复路径身份及转义膨胀                 | 保留完整内部审计和执行绑定，对模型做可逆的路径/结构去重；不截断路径或风险。完整用户请求只保留一份，context 使用明确引用，同一性检查仍在投影前执行。默认请求预算仍为 32768。                        |
| 「允许」测试容易只证明 stub，未验证实际落盘/拒绝                      | 新增默认装配的完整工作流与真实 pnpm dev PTY，只替换 provider。实际 ModelReviewer 解析/校验判决，真实 policy/executor 执行及复核。                                                                  |
| 模式、记忆规则、子任务授权容易被产品名字或模型文本混淆                | 测试会话精确规则、显式配置重启、子任务真实用户来源与并行隔离、Plan only 硬边界。保留现有生产行为，未加入 Plan 边界待发布改动、UI 重做或兼容迁移。                                                  |
| 纯自然语言「不要修改」及跨工具拒绝理解不能由固定 provider 证明        | 测试证明完整限制、授权来源及拒绝历史传给真实 reviewer，且 deny 不转人工批准；不宣称真实模型判断准确，也不把任意自然语言自动编译成硬策略。确定性 deny、Plan only、readOnly 子任务才是对应的硬边界。 |

## 工作流矩阵

均在隔离 HOME/匿名临时项目中，不接触用户 `/data` 或真实凭据；正式测试为 TS/Node/pnpm。auto 使用正常 deterministic policy 和 model reviewer，未用 yolo。默认规划保留在新增工作流和 PTY 中。

| 场景                                       | 实际验证                                                                                                                                                     | 对应测试                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 原命令、200+ 文件、82KB 量级               | 220/300 文件实际输出与直接 Bash 逐字相同；0 judge/人工；200 文件旧证据实际测得完整请求 89078 字节                                                            | bash-readonly-auto、bash-readonly-pty；基线归因见专项报告     |
| 枚举/搜索/读取/CD/管道/git 状态            | 实际 glob、grep、read_file、cd+cat/head、find/wc、git status，0 judge/人工                                                                                   | auto-workflows                                                |
| 文件名、选项、链接、环境、TOCTOU、危险命令 | 安全子集验证；空白/换行/通配/选项注入/外部或敏感读取/硬链接/find 动作等无法证明时不走 safe_read；目录/文件替换不读替换内容；新增匹配候选在对应 wc 读取前拒绝 | bash-readonly-auto、shell-runtime、现有权限/契约测试          |
| 普通授权写入                               | writeRoots 的 edit_file 规则允许；其他 write_file 经真实 reviewer 受控 allow 后实际落盘；PTY 同样验收                                                        | auto-workflows、bash-readonly-pty                             |
| 记住规则与配置重启                         | 会话记住精确命令，同命令复用，其他命令重新审查；显式写项目规则后新 runtime 加载生效。此项没有冒充 UI 项目记住按钮                                            | auto-workflows；现有 permission-settings/cli-pty 验证设置入口 |
| deny 后换工具                              | write_file 拒绝后 edit_file 的 reviewer 输入仍含同一完整限制和前次拒绝；受控 deny 下二者均未执行且没有人工覆盖                                               | auto-workflows                                                |
| 子任务与 Plan                              | 两个真实并行子任务不能伪造父用户授权来源；受控拒绝不落盘；readOnly 子任务和 Plan only 在 judge 之前阻止写入/委派，专用读取可用                               | auto-workflows、现有 planning/subagents 测试                  |
| ask/unknown/provider error/请求超预算      | 真实 write_file 链路失败关闭转人工；人工拒绝后文件不存在。超预算 0 provider；其余各 1 provider。模型 deny 不转人工                                           | auto-workflows                                                |
| 响应上限、截断、超时、输出校验与操作变更   | 现有 reviewer/auto-fallback/permission-contract/powershell-chain 契约回归继续运行；不是每个故障都在真实 TUI 单独注入                                         | 全量测试                                                      |

## 验收分类与剩余限制

**已实现并在 Linux 验证**：原命令安全子集与实际输出、绑定与失败关闭、可逆证据、用户请求去重、上述实际工具及 PTY 工作流。格式、类型、全量测试、构建与独立审查结果在最终交付记录，未推送、未建 PR、未合并。

**仅受控 provider 验证**：需要模型判断的普通写入、语义限制、跨工具重试、子任务请求的 allow/deny/ask/unknown。测试调用真实 ModelReviewer，证明上下文、预算、协议、裁决和执行，不证明真实模型对越权或提示注入的识别率。没有发送真实模型请求，也没有扩大真实 API 预算。

**未支持或未验收**：任意 shell/命令替换不是安全子集；cd 后 grep/rg 文件操作数、git、递归或其他目录 ls 等未绑定的组合继续回退。head/tail 多文件标签和 wc 同对象不同别名等不能准确恢复语义时回退。原生 Windows/macOS 未在 Linux 环境执行；既有跨平台策略测试继续通过不等于原生验收。目录/文件描述符绑定不冻结已授权 inode 的内容，整个 Agent 也不是 OS 沙箱。非常大的未知调用仍可能超过请求预算，明确失败而非静默删证据。

**可选的后续真实模型核验**：如另获授权，可仅做少量只审查不执行的匿名调用，对允许写入、明确禁止写入、换工具重试、伪造子任务授权分别观察实际模型判决；沿用当前请求上限和小回复上限，不需要发送真实项目数据。本次没有以此为前提阻塞已授权的本地修复。

## 最终本地检查记录

- `pnpm format:check`、`pnpm typecheck`、`pnpm build` 通过。
- 原样 `pnpm test`：75 个测试文件通过，1397 项通过，2 项既有 Windows 原生测试按平台跳过；包含真实 `pnpm dev` PTY。
- 首次扩展全量的 4 个旧请求字段断言已更新为完整 currentUserRequest 及显式引用；随后一次并行全量触发子任务持久化测试的既有 100ms 超时。未修改其生产行为或超时；专项 30/30 及最终全量原样通过。该负载敏感性保留记录，不声称测试从未出现波动。
- 独立审查先运行 Bash 62、auto-workflows 5、auto-fallback 44 共 111 项；最终复查 judge 22、provenance 1、扩展 auto-workflows 10 共 33 项。均通过，无生产代码阻断意见；并核对官方源码路径和条件分支，修正文档中「绑定后目录替换一定拒绝」的过强表述。
- 最终 220 文件加空白文件名的模型证据：完整请求 27960 字节，payload 22553，analysis 21421；FakeProvider 收到完整请求，默认上限未改变。原命令安全目录仍为 0 judge。
