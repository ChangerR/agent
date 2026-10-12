# 计划交互与全树并行验收记录

日期：2026-10-12。基线：远端 master `2745436`。
工作分支：`feat/compact-plan-tree-parallel`。Linux、Node 24.19.0、pnpm 11.25.0。
两条实施及交叉复审任务均使用 Astra high，同时最多两个 child。

## 已实现与核验

- 默认一行摘要，Ctrl+T 展开/收起、Alt+↑/↓ 浏览；窄屏入口缩写为 `^T`。
  具体完成/阻塞/中断步骤、长原因和依据可浏览；新计划和会话恢复默认收起。
- 140×40、40×14 的真实 Linux PTY 启动原样 `pnpm dev`，覆盖父输入、草稿、root/child
  审批焦点、展开/滚动/收起、暂停/取消、设置即时保存、Esc 不写配置、重启和恢复不请求模型。
  另用真实 TUI 渲染器检查 24/40/120 列的 Unicode 长文本与阻塞摘要。
- 默认全树最多两个 child；child 加 grandchild 同样占用这两个位置。显式设置 4 保留；
  下调上限不取消已有 child，新任务受新限额约束，设置通过原有 CAS 原子保存。
- 受控 provider 通过默认 createAgent 装配，先读共享约定，再由父工具实际启动两个 child，
  两者同时进入模型阶段且父已开始等待后才释放测试闸门；第三个任务被限额拒绝。
  两份真实读取结果核对后才执行汇总，子模型继承当前选择。取消、失败、恢复使用既有 Supervisor。
- 只读审查范围与后代约束取交集，模型的显式 false 或已有宽权限 child 不能放宽它。
  only 仍禁止 spawn/send，未扩大“只规划”的范围。
- 拒绝保留具体 child/步骤来源；无父计划、已完成父计划收到后台拒绝均有可恢复的阻塞状态。
  拒绝后的改写、重试、换 child 不再触发审批或执行；显式恢复仍需正常审批。
  单调拒绝世代使旧批准不能跨拒绝/恢复边界复用，普通进度不会使父响应或审批失效。

官方产品源码、提交与观察见 [交互参考](PLAN-INTERACTION-REFERENCES.md)。
本次没有真实模型 API 调用，受控 provider 证明机制与生命周期，不证明真实模型一定正确拆分所有任务。

## 执行结果

命令在隔离测试 HOME/项目下运行；外层 pnpm 使用 `XDG_DATA_HOME=/tmp/agentlab-pnpm-data`。
首次只按 frozen lockfile 补装环境缺失的 `tree-sitter-powershell@0.26.4`，依赖声明和锁文件未修改。

| 检查                            | 结果                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| `pnpm format:check`             | 通过；顺手修正 master 原有 auto-fallback 测试一处断言换行，无逻辑变化 |
| `pnpm typecheck`                | 通过                                                                  |
| `pnpm build`                    | 通过                                                                  |
| core/runtime 专项 5 文件        | 156/156 通过                                                          |
| planning TUI、planning PTY、CLI | 45/45 通过                                                            |
| 双 child 真 PTY                 | 1/1 通过                                                              |
| 审批历史与搜索权限矩阵          | 60/60 通过；独立场景显式开始新任务，原安全断言保留                    |
| 最终 `pnpm test`                | 72 文件：65 通过、7 失败；1338 项：1263 通过、73 失败、2 跳过         |
| `git diff --check`              | 通过                                                                  |

**全量未全绿，不能宣称全量验收通过。** 最初 8 文件 74 项失败在未修改的 master 对照
工作区 `/tmp/agent-master-baseline` 上按相同用例名称复现。本次修复了相关 subagents PTY
离线剧本未识别规划请求的问题，最终剩余以下 73 项；最终失败名称是基线失败名称的子集，没有新增失败。

| 基线失败文件                                | 剩余失败数 |
| ------------------------------------------- | ---------: |
| `tests/shell-runtime.test.ts`               |         62 |
| `tests/powershell-permission-chain.test.ts` |          6 |
| `tests/session.test.ts`                     |          1 |
| `tests/permission-settings.test.ts`         |          1 |
| `tests/mcp.test.ts`                         |          1 |
| `tests/cli-pty.test.ts`                     |          1 |
| `tests/powershell-permission-pty.test.ts`   |          1 |

这些失败主要涉及旧权限预期与现行 ask→review 行为、旧离线脚本被规划请求消耗。
没有通过修改 Bash 只读分析或 reviewer payload 来消除它们；该范围仍由另一线程负责。
旧提交 `55539b1` 不在本地对象库，未假定其已合入，也未复制/迁移其实现。

## 独立复审与证据

UI 与 runtime 实施者交换范围做只读复审。无父计划时 child 拒绝漏锁、已完成父计划收到
迟到拒绝的两项问题均经独立脚本复现、修复并复验；前者实际审批次数由 2 降为 1。
兄弟审批及拒绝→恢复→旧批准的 ABA 竞态有额外受控回归和独立复审。最终无未处理的本次复审问题。

此环境完整证据目录：`/workspace/agent-evidence/`：

- `planning-{140x40,40x14}.ansi` / `.jsonl`：原始真实终端字节和事件，包含重启/恢复段。
- `subagents-140x40.ansi` / `.jsonl`：两个 child 的真实终端进度、父输入、补充、取消与设置保存。
- `denial-review-fixed.json`、`denial-completed-root-fixed.json`：独立复现修复后的状态。
- `full-tests-final.log`、`master-baseline-failures.log`、`final-baseline-comparison.json`：全量结果及基线对照。
- `format-check.log`、`typecheck.log`、`build.log`：格式、类型和构建结果。

无真实 API、无推送、无 PR、无合并。原生 Windows/macOS 终端未在本环境实测。
