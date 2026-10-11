# 当前架构验收

本文件规定当前源码树的验收范围，不将历史版本的通过计数当作本次验证结果。最终运行结果应以本次 PR 的检查记录为准。所有模型验证使用 FakeProvider 或本地故障替身，没有真实 API 成本、延迟或准确率测试。

## 完整检查

运行 `pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check`。全部回归统一走 Vitest；`pnpm test tests/cli-pty.test.ts tests/subagents-pty.test.ts` 可单独复现 Linux 真 PTY。这两项专项依赖 util-linux `script`，缺失明确失败，非 Linux 明确跳过。

## 核心证据

- SDK/host：重复 ID/alias、依赖版本与循环、原子注册、失败回滚、资源超时和逆序清理、不可变观察者与范围化依赖。
- 能力替换：独立 ESM manifest/setup 插件只改 pluginEntries/capabilities，即可替换 policy、compactor、SessionStore 并增加工具、命令和设置。
- 默认装配：唯一内置确定性策略和严格审批员，ask 为默认模式；配置不接受历史插件入口或运行设置别名。
- 执行门：最终参数/schema、身份/revision/环境/会话绑定、嵌套调用、取消、迟到响应、唯一结算、无 responder 终止、确定 deny/ask 不被模型覆盖。
- 策略：deny/ask 优先、精确授权、显式 writeRoots、敏感文件、路径与链接、未知工具及 Shell 保守处理；模型调用次数由真实 runtime 事件验证。
- 会话：只接受当前格式；完整 provider/endpoint 和 policy 身份；缺失或不兼容安全状态拒绝恢复；锁/CAS、未知字段、失败恢复、删除/重建约束。
- 历史：摘要不能伪造真实用户来源；用户消息按原始顺序匹配；不合作 compactor 不提交迟到结果。
- reviewer：完整参数与真实用户要求、严格 JSON/流协议、预算、独立模型/provider 来源、用途与执行关联、超时/取消、无批准结果缓存。
- 设置：项目默认作用域、一次提交自动保存、Esc 不保存未提交输入、全局/项目覆盖、重启提示、CAS 冲突和安全错误。
- `.env`：项目根加载、进程环境优先、显式 apiKeyEnv 不回退、不暴露 key、provider 端点与凭据身份绑定。
- Shell：原始 `ls -la && echo "---" && cat package.json` 通过真实 runtime 和 pnpm dev PTY 验证实际 stdout 与 judge/人工次数，并在保存 auto 后重启复验；不能用内置 grep/glob 的通过数量代替 shell 可用性证据。
- Headless/TUI：命令不加载 pi-tui；内存终端检查窄屏、焦点、详情、审批、队列和 renderer 异常；Linux 真 PTY 复用原 package.json/dev 与逐文件哈希一致的源码，验证单选自动保存、Esc 不保存、重启，以及真实工具失败和运行中取消后的再次请求。
- 子 agent：`tests/subagents.test.ts` 使用真实 runtime 和 FakeProvider 验证两个并行 child、独立 fresh/snapshot、完成回传、FIFO 与完成边界、指定 run 的 wait race/timeout、全树额度、回合/时限/累计结构输出预算、父 deny/ask 与用户来源、一次性审批、只读兄弟权限交集、失败隔离和 headless approval_required。实际模型审批员与自定义压缩器验证各 agent 的 agent/compact/judge 用量以及迟到去重。
- 共享调度与结算：`tests/tool-scheduler.test.ts` 验证已分析读取并行、写入串行、公平等待、取消和整个嵌套租约树。runtime 与 executor 回归验证同目标父子写入、控制工具等待无死锁、忽略取消的模型/工具/analyzer/policy/hook/compactor/store 保留容量或必要资源；Linux Shell 用真实本地子进程验证进程组取消与部分结果。
- 子会话与界面：真实文件会话验证根/child 分开原子保存、空 child 取消恢复、CAS、切换取消、旧 running 标 interrupted、恢复不发请求、迟到存储读取不提前关闭宿主。`tests/cli.test.ts` 的真实 pi-tui 渲染和 `tests/subagents-pty.test.ts` 的原样 pnpm dev 真终端验证进度卡片、实时列表/详情、父输入不串线、补充与取消、FIFO 审批与迟到点击、设置单选成功落盘及失败/取消不应用。详细语义见 [SUBAGENTS.md](SUBAGENTS.md)。

## 本次 Linux 验证记录

### 2026-10-11：PR #35 同步 #36 权限与 #37 规划续跑

发布前核对 PR #35 的远端 head 仍为 `77f08525e2e6ac8b9ea21dbd311ddb86225a837c`。
本次 master 基线为 `d35bd70c273f3ad948961b20479ea74f333a0875`，包含 #36 的
`ec69577871a7b8fe56ffc0e4cffa2fe35c771408` 与 #37 的合并修改。原分支使用本地
merge 提交 `b3cf7a0b4de881f14477f2b20046310fca9d0254` 保留两侧历史，再补格式与本记录；
更新原 Draft PR #35，不改写已发布历史，不另开 PR，不合并远端 PR。

逐处处理 `docs/ARCHITECTURE.md`、`docs/POLICY.md`、`src/cli/app.ts` 和
`tests/cli.test.ts` 四个文本冲突。保留 #36 的 ask 模式已验证只读放行、等于引号精确调用
规则和同次审批复用；保留 #35 的 PowerShell 敏感/外部/危险/歧义与未知语义约束先于精确
规则及模型。审批面板允许完整静态输出或普通写入记住精确调用，包括
`powershell_write_review`；未知 PowerShell 与受限目标继续隐藏无效记住选项。

上游两条“未知 npm test 可凭 PowerShell 精确规则放行”的测试调整为完整静态调用的正例，
新增 ask/auto/yolo 下未知 npm test 仍人工的反例。新增组合回归涵盖：完整调用记住后免重复
审批且不扩大到其他命令、ModelReviewer ask 后记住写入、仅 policyRevision 改变复用本次
批准且不跨调用复用、人工批准时目标变为外部链接仍重新询问，以及 Windows ask 普通读取
和检索持续推进计划、拒绝敏感/外部/未知/危险别名命令后停止自动重试。

单独复查确认 `src/core/tool-executor.ts`、loop/plan 与规划插件源码逐字等于本次 master；
PowerShell 解析/路径分类与 Bash AST 源码逐字等于原已发布 head，未恢复原 Windows 缺口。
五个上游测试文件仅修正 Prettier 格式，TypeScript AST 复核无语义变化。#36 的 MCP owner
线索未扩张修复；#37 的只规划边界源码未修改，由另一任务处理。

最终在 Linux、Node `24.19.0`、pnpm `11.25.0` 下完成格式、类型、全量测试、构建和 diff
检查：**71 个文件、1319 项通过、2 项跳过（1321 总计）**。PowerShell 链路为 103 项，
102 项通过、1 项原生 Windows 跳过；规划 43 项全通过（新增 5 项组合）。四个 PTY 文件
共五项用例全部通过，均实际启动仓库原样 `pnpm dev`，包括 CLI、子任务、两种规划终端
尺寸与 PowerShell 审批。日志在 `/tmp/agent-permission-validation/*-sync-final.log`。

全部模型使用 FakeProvider 或受控 provider，新增真实模型请求为 0。原生 Windows 与真实
模型仍未实测；跳过的两项仍是原生 Windows cwd 大小写恢复和安全 PowerShell 输出/元数据。
危险与外部 Shell 命令只验证决策并拒绝执行，完整命令使用无副作用替身；Linux 上注入
Windows policy 不能代替 Windows 实机证据。

### 2026-10-11：PR #32 PowerShell 权限修复

只读复核基线为 `44aaf9dcb777ac7907cb5ff49995ad1c6bfff5cb`，初次最新 master 为
`9e19d86f9fb92f5503ed4ed0e7ce4f7c260cb940`（#33）。检查确认 #33 没有修改 #32 的
analyzer/policy/reviewer/executor，五条 review 仍成立。之后同步已合并 #34 的 master
`464023d1105010b11a7dea826b10aa606b6fe3bf`，保留 Plan 控制工具识别；未改动另一环境的工作树。
最终源码为 `ef69b3c2b583b61acb720aa1f983455dec29e494`，独立分支
`fix/powershell-permission-semantics-20261011`。验收记录提交仅更新本文件，未发布、推送或创建 PR。

| #32 review                                                                     | 复核与修复证据                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [4240509467](https://github.com/ChangerR/agent/pull/32#discussion_r4240509467) | 基线只记录 cwd/unknown execute，敏感和项目外命令进入 review。修复先解析操作数，复用真实路径、敏感、外部、链接、特殊文件及用户规则检查；无法完整验证时直接人工，provider allow 不会被调用。 |
| [4240509468](https://github.com/ChangerR/agent/pull/32#discussion_r4240509468) | 基线遗漏 rm/rd/del 等默认别名与倒序参数。修复依据 AST 的规范化命令、参数及根目标分类危险；字符串和注释中的危险词不被冒充为调用。                                                           |
| [4240509471](https://github.com/ChangerR/agent/pull/32#discussion_r4240509471) | 保留明确 reviewer deny 终止；文档改为 ask/unknown、失败、超时、非法输出或不可用回到人工。deny 不被自动改成批准。                                                                           |
| [4240509472](https://github.com/ChangerR/agent/pull/32#discussion_r4240509472) | 分析摘要显示 PowerShell；真实 ModelReviewer ask → Executor → 原样 pnpm dev 审批/详情已验证。                                                                                               |
| [4240509473](https://github.com/ChangerR/agent/pull/32#discussion_r4240509473) | 完整支持子集提供真实目标、effects、参数和执行契约；受控 provider 在内置 ModelReviewer 中核对完整证据后返回协议结果。未知分析直接人工，不能由只返回 allow 的 stub 补全。                    |

在 Linux、Node `24.19.0`、pnpm `11.25.0` 下，最终源码的 `pnpm format:check`、
`pnpm typecheck`、`pnpm test`、`pnpm build` 和 `git diff --check` 全部通过。
Vitest 为 **71 个文件、1268 项通过、2 项跳过**；两项跳过分别是原生 Windows cwd 大小写
恢复和真实 PowerShell 的安全输出/元数据读取。格式、类型、测试与构建日志在本次环境
`/tmp/agent-permission-validation/`，基线反例为同目录 `baseline.json`。

`tests/powershell-permission-chain.test.ts` 有 91 项，其中原生 Windows 项跳过，90 项通过。
覆盖真实 analyzer → policy → ModelReviewer → ToolExecutor、敏感/外部目标、别名、命名/位置/
缩写/冒号/布尔参数、组合语句与重定向、普通读取、unknown/deny/ask、协议故障、超时、
审批摘要和目标替换重验。Shell 执行均使用无副作用替身，破坏性命令只分析决策，绝未执行。
read_file/glob/grep 对隔离普通文件实际执行，保留 #30 的零 reviewer/零人工行为。

四项 Linux 真 PTY 随最终全量测试通过，启动入口均为仓库原样 `pnpm dev`：
原有 CLI、子任务、Plan，以及新增 PowerShell 审批回归。新增回归在真实 TUI 中注入 Windows
policy，验证敏感/未知直接人工、完整操作经真实 ModelReviewer 实现返回 ask、PowerShell
摘要与详情、拒绝后无执行，以及普通读取零审批。所有 Shell 均拒绝，未以 Linux Bash
执行冒充原生 PowerShell。HOME、项目和 provider 均隔离；**真实模型请求为 0**。
受控 provider 验证协议和数据传递，不能作为真实模型判决准确率证据。

单独反例复查覆盖别名/参数消歧、字面值类型与引号、全语句覆盖、模型不可降级约束、
审批后环境重验、原始/规范化路径规则，以及 Plan/Bash 的边界。复查收紧了 FileInfo/PathInfo
对象 getter/属性投影：这类实际访问范围未验证的管道仍需人工；同时保留原始标量的静态
格式化。未发现其他已确认的阻塞缺陷。原生 Windows 和真实模型未实测，Git/npm 原生程序、
动态表达式、未知 provider/参数、通配/数组与平台歧义等边界完整列于 [POLICY.md](POLICY.md)。

仓库已读取 `AGENTS.md`；最新 master 没有 `.agents/skills`。本任务没有新增 Python、迁移、
历史兼容层、凭据或二次确认，也未修改 #33 的其他 UI review 范围。

### 下列为仓库已有验收记录

2026-10-11，PR 提交前的最终基线更新到 master `b819045e27b509d3d9de6715297c34d9311d7225`
（PR #30，保留 PR #28/#29 的写入与 Shell 保护，并采用项目内只读直接放行）。`pnpm format:check`、`pnpm typecheck`、
`pnpm test`、`pnpm build` 和 `git diff --check` 全部通过。
Vitest 共 67 个文件，1145 项通过、1 项跳过（包含手动验收发现的标题回归）；跳过的是仅原生 Windows 执行的
cwd 大小写恢复测试。两个 Linux 真 PTY 专项通过，复用原样 `pnpm dev`；
子 agent 专项验证真实双 child 并行和回传、父输入、实时列表、补充/取消及单选保存。
实际 pi-tui 另验证 child 等审批时父问题独立完成、草稿/FIFO/迟到点击保护和慢速恢复后的底栏。

独立只读复审使用 FakeProvider 和临时 HOME/项目重现关键取消、嵌套租约、存储迟到提交
及 TUI 边界；报告的问题已修复并加入回归，没有遗留阻塞性缺陷。未使用真实 API key
或用户文件，未合并或部署。原生 Windows 未实测。

提交前首次重跑时，云端默认命令权限让本地 git/Node 同步子进程返回 EPERM，导致
73 个依赖进程的测试失败。同一源码与 `pnpm test` 在允许网络的命令权限配置下全部通过；
未修改或跳过这些测试，仍只使用 FakeProvider/mock SDK 和本地进程，未发出真实模型请求。

## 本次手动用户流程

2026-10-11，在 Linux `6.18.44 x86_64`、Node `24.19.0`、pnpm `11.25.0` 下，
另从真实终端手动操作原样 `pnpm dev` 与 `pnpm dev --resume <sessionId>`，
当时的代码基线为 master `663f7edb89ce5a94dbfda0006515be6fdc858e2f`（PR #29）；
整合 PR #30 后两个 Linux 真 PTY 专项随最终全套重新通过。
HOME/项目完全隔离；启动文件和源码 118 个文件的 SHA-256 与仓库一致。
本地脚本 provider 为 `offline-e2e`，模型标签由 `offline-e2e-v1` 切至
`offline-e2e-v2`；这些标签不代表真实模型。复制的 node_modules 产生 workspace
元数据告警，未重新安装或联网。

| 用户流程             | 实际结果                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设置选择、取消、重启 | `/agent-limit` 一次选择立即保存并应用 2；第三个并行任务立即拒绝。Esc 不保存新选择；模型、ask 模式和并发限制重启保留，未知 JSON 字段保留。                                        |
| 并行、消息、回传     | A/B 同时进入受控流；父聊天独立完成。运行中两条消息在同一 run FIFO 处理，完成各通知一次；完成后补充保留上下文并创建新 runId。                                                     |
| 列表与详情           | 实时状态、完整结果、部分输出和 tokens 分开显示；详情页补充和取消实际生效，child 文本不拼入父回复。                                                                               |
| 真实读取和 Shell     | read_file/glob/grep/Bash 对隔离测试文件实际执行；`cat fixture.txt` 返回精确标记，auto 无 judge 或人工审批。                                                                      |
| child 审批、父输入   | ask 下真实 write_file 在明确选“允许一次”前不执行；未选择按 Enter 无效。Ctrl+G 后父问题完成；详情显示 child 名称、任务和路径。                                                    |
| 审批取消和迟到输入   | 新 child 不复用之前批准；详情页取消后审批移除，迟到 Enter 不执行写入，测试目标 mtime 不变。                                                                                      |
| 流、工具与退出取消   | 流收到 AbortSignal；真实 Bash/Node 子进程从存活变为不存在，部分 stdout 保存，结算后 cancelled。父聊天空闲时 Ctrl+C 退出码 0，所有所属任务终态并保存部分结果。                    |
| 异常退出与恢复       | 对已验证归属的 CLI PID 注入 SIGKILL（预期退出 137）；重启后旧 running 显示 interrupted，已有结果保留，请求数保持 13。详情页明确补充后仅新增一次请求；保存后 interrupted 持久化。 |
| 用量与会话文件       | 根/child 分别保存。主流程自身 20/12、全树 65/39 与记录求和一致；所有用量事件按 requestId/agentId 唯一。以上是替身 token 数，不是实际模型计费。                                   |
| 发现并修复的问题     | 先 spawn 时根标题误取内部通知 JSON。修复为仅用户原文/child 委派任务生成标题，占位标题可继续更新；单元回归和第三次实际 pnpm dev 均通过，独立复审无遗留问题。                      |

共 18 项手动流程通过，18 次本地替身请求，**真实网络模型请求为 0**。
证据在本次云端环境 `/tmp/agent-manual-e2e/report.json`、同目录的
`terminal-1.typescript` / `terminal-2.typescript` / `terminal-3.typescript`、
源码哈希和恢复前后会话快照；具体路径在 report 的 artifacts 中。
测试文件只存在于专用隔离目录。

官方 DeepSeek **未执行**：云端有效配置是 `provider: fake` / `model: demo`，
项目 `.env` 不存在，进程没有 `DEEPSEEK_API_KEY`。仅检查相关配置字段和变量
存在性，不读取/输出密钥，不检查无关凭据。需要当前项目的 `provider: openai`、
`baseURL: https://api.deepseek.com`、`apiKeyEnv: DEEPSEEK_API_KEY`，以及对应
模型 ID 和该变量的凭据；凭据缺失时未探测网络。未新增持久凭据或更改仓库本机配置。
原生 Windows、真实模型响应及服务端流式取消仍未实测。

## 明确限制

Linux 上的 Windows 字符串测试不能代替原生 Windows 验收。原生 Windows 项目内 read_file/glob/grep 在通过通用检查后可于 auto/yolo 直接放行；写入、敏感、项目外、歧义路径与 Shell 仍沿用现有保护。Bash 仅对完整验证的只读执行计划确定性放行；动态展开、未知参数及不支持的仓库配置仍需审批。本轮 Shell 运行证据来自 Linux，不等于 macOS 或 Windows 实机验收。

没有 OS 沙箱、在线插件安装器、任意热卸载或真实模型安全准确率保证。文件系统前提会重验，但不是针对恶意外部进程的原子隔离。缺失用量记为未知，不声称零费用。明确目录授权的确定性放行不能推导为任意任务都降低成本。
