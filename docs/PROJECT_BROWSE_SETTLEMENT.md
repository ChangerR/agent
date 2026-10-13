# 真实仓库浏览的重复委派与计划结案

## 复现范围

2026-10-12，核实 PR41 已合并，远端 master 为 `b679e5a33944a3e100a66aa8ef6904977a1f4d20`。本次分支从该提交创建，不修改前轮 Bash 审批证据。

真实验收使用 AgentLab 仓库的独立 checkout、独立 HOME 和实际依赖，原样启动 `pnpm dev`，输入精确文本：

> 浏览一下当前项目，看看优化点

使用现有 `deepseek-flash` / 官方 DeepSeek 端点及原凭据，仅在进程环境传递凭据，不复制 `.env` 或用户配置。保留默认规划、默认 reviewer 和正常 auto；未调整 maxTurns、child 上限、模型输出上限或审批预算。观测插件只记录事件，外部 watchdog 只负责记录与安全停止。新增 1000 次请求预算独立于历史 20/100 次，在 SDK 调用前与每次实际 transport（含重试）执行共享硬上限。

## 实际根因

基线发出 **78 次请求（planner 4、main 33、child 41）**，耗时 **438.954 秒**，创建三个 child，其终态为 failed / limited / failed，父计划最终 blocked。模型最终输出了建议，因此这次没有证实永远不返回的锁死；复现的是严重的无效扩展、重复委派与结案失败，不能把有限观测说成已证明无限循环。

1. **白名单和子计划冲突。** 父模型用 `allowedTools: [read_file, glob, grep]` 创建只读 child，runtime 仍让 child 进行 auto 规划，但 `plan_update` / `plan_status` 被同一白名单拒绝。真实事件连续出现 `Tool is outside child allowedTools`，之后 child 耗尽 16 轮或在未完成计划的情况下返回，被 supervisor 标为 limited / failed。
2. **默认提示强制扩大任务。** 原提示要求所有独立仓库审查都创建两个方向的 child；child 也继承同一要求，实际又尝试 agent_spawn。父模型看到失败后新建了第三个同方向 child，后者重复失败。用户的普通浏览被扩展成全面审查。
3. **综合步骤没有结案通路。** `PlanController.update()` 要求本步骤有成功执行，不能引用前面已完成步骤的真实证据。已读源码后的纯分析/汇总会得到 `No successful execution evidence for this step`，诱发仅为结案的额外读取。独立 TypeScript 复现和真实日志均确认。
4. **额外往返。** 同一模型响应内多个 plan_update 使用同一 revision，后续调用得到 plan_stale；已委派任务又拆为四至五个本地步骤，消耗默认 child 轮次。这些有真实证据，但并非已证明的工作区锁死。

`agent_wait` 已是控制工具，不持有工作区 scheduler 租约。本轮没有发现因它持锁而等待 child 的确定性死锁；已有 child 也确实完成了失败/受限状态结算。

## 修复边界

- preset 按可信 `ownerPlugin + name` 标记仅管理当前任务的本地计划工具。受限 child 可使用这两个控制工具；模型可见工具与执行期可用性用同一判断。该标记不是权限 allow，显式 deny/ask、只读约束和唯一 ToolExecutor 保持生效，write_file、agent_spawn/send 等没有获得白名单例外。
- 只读分析步骤可通过 `evidenceStepIds` 引用当前计划中更早、已完成且有证据的步骤，引用持久保存在计划中。普通实施计划不能使用该通路；本步未结算调用、失败或仍活动的 child、only 模式、真实权限拒绝依然阻止结案。不是任意 evidence 文本即可伪造成功。
- 宿主来源明确区分已委派子任务与新的用户任务。有限子任务可由规划器返回 null 直接检查；确需阶段依赖时仍可建计划，only/显式 force 不改变。没有全局关闭 planning 或 reviewer。
- 普通项目浏览默认抽查少量关键路径并提供优先建议，不强制穷尽模块或创建 child；确有独立验证需要时仍可委派。提示说明消费既有 child 结果、避免重复派发，以及串行使用计划 revision。

## 验证及限制

中间版本的失败保留在请求账本中：第一次修复的两次运行分别用了 28 / 79 次请求，后者仍发生 child 限额及重复 follow-up；增加委派范围提示后的另一次用了 65 次请求，仍有一个 child limited，计划 blocked。不能将这些改写为最终版本成功。

最终候选源码下的重复真实验收和精确分类见 [请求证据](evidence/project-browse-settlement.json)。每轮均使用新的隔离会话和原始提示。检查实际建议、计划终态、child 终态，以及结束五秒后无新增请求且 `/help` 可响应；没有用 watchdog 或 maxTurns 截断来伪装完成。

| 最终版本运行 | planner / main / child 请求 | 总请求 | 耗时       | 计划终态  |
| ------------ | --------------------------- | ------ | ---------- | --------- |
| fixed-4      | 1 / 31 / 0                  | 32     | 134.783 秒 | completed |
| fixed-5      | 1 / 16 / 0                  | 17     | 65.910 秒  | completed |

两轮源码摘要均为 `9ef73d5ea56a24e0702748e9ad278a7e1ae8f14487d5027808b6f5b284655235`，零人工审批、零 judge 调用，输出了具体源码建议。全程累计 **299/1000** 次实际 transport，包含基线和失败的中间版本，不继续消耗剩余预算。证据中的 `readyRendered` 只检测发送 `/help` 后的增量输出是否重绘“就绪”，不能用它判断先前状态是否就绪；结束证据为真实 `loop_end`、计划 completed、无活动 child、五秒内请求数不变与帮助命令响应。模型最终建议原文仅作为实际输出证据，不代表本修复独立验证了其中每一项性能判断。

完整 PTY 记录另确认两轮在 `/help` 后均渲染了“就绪”（`fullTerminalReadyAfterHelp: true`），原增量观测字段保留以免改写历史。

最终独立复审后只调整了一处通用 child 系统提示：将“只检查本次分配的范围”改为“只处理本次分配的范围，按授权完成任务”，避免误导合法实施子任务；未改变权限或执行逻辑。上述两轮未创建 child，因此未走到该提示，但不能把它们描述成提交源码逐字相同的实测。该最后调整通过离线完整回归，没有额外真实模型请求。提交源码摘要为 `44faf2a5690ee37b8dae7c136f7ed78d37639f37247153c800004a24475e5591`。

离线验证：正常 auto/default reviewer 下的真实 runtime 回归覆盖受限 child 自己完成计划、真正 deny、强行调用隐藏写入/委派工具、禁止非只读引用、不能越过未完成 child。新的 Linux 真 PTY 测试使用仓库实际源码，沿父读取、child 执行、等待、综合结案走完全链路，结束后响应 `/help`，零人工/零 judge。它是受控 provider 回归，与真实 DeepSeek 验收分开记载。

最终代码格式、类型、build、完整测试通过：79 文件，1545 passed / 2 个原生 Windows 平台测试 skipped。独立代码审查与相关测试已完成，发现的新测试注册位置和提示步数冲突均已纠正。Linux 真 PTY 不能替代 Windows/macOS 原生验收；随机模型仍可能选择不同检查路径或遇到真实阻塞，不承诺所有提示和环境都能必然完成。

本次基于最新 master 的独立修复分支按后续授权提交 Draft PR，不合并。完整去秘密的请求、流事件、工具/计划/child 事件与 PTY 记录保留在云端 `/tmp/agent-browse1000-n43rC0`；提交的证据记录请求分类、事件摘要、最终输出及完整日志哈希，不包含凭据。
