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
