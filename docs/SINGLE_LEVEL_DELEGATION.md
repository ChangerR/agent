# 单层委派与 child 零规划请求

用户进一步明确：父任务已经分配范围，child 直接执行并回传结果，不重复规划，也不再拆分子任务。本次基于 PR42 的 `d347d9c` 继续修正；核实远端 master 仍为 PR41 合并提交 `b679e5a`，未更新 PR42 或推送。

## 事实与根因

- 原 master 实测基线的三个 child 各调用一次规划器，合计三个 child planner 请求。一个 child 尝试 `agent_spawn`，执行结果为 `Tool is outside child allowedTools`。这证明重复规划和嵌套委派尝试，不证明成功创建孙任务。
- PR42 缩小了 child 规划提示，但仍调用独立规划器，仍允许 child 建立本地结构化计划。它没有完全实现“直接执行”的产品要求。
- 原实现默认 maxDepth=1，但允许配置为 2–4，并且宿主支持 child spawn 和向其他 child send；默认深度限制不是固定单层约束。

## 本次行为

- 核心 AgentLoop 按宿主绑定的 agentId 跳过 child planner，首次执行、显式 follow-up、恢复后的续跑都不发规划请求；不依赖模型返回 null。父任务的 auto、only、显式执行与计划进度保留。
- 默认 preset 将规划与 agent 控制工具标为 rootOnly，child 工具列表和执行检查使用同一可信 owner/name 判断；显式 allowedTools 不能覆盖该限制，伪造调用也不能执行。child 不建立本地计划，父计划负责步骤、等待及汇总。
- Supervisor 的 spawn/send 独立检查调用者为 root；配置只接受 maxDepth=1，恢复也拒绝多层树。默认最多两个 child 并发不变，没有新调度层、递归工作流或自动重试。
- child 按原授权与只读限制执行真实工具，保留活动、取消、结果和终态。权限拒绝仍可用现有状态对象展示和持久化；只有根任务已经通过真实继续与权限检查后的显式 send 才清理 child 的阻塞展示状态，随后直接执行，不恢复结构化计划。
- 普通浏览不强制委派；父任务仅在范围独立且确有收益时按需拆分。子任务内部推理不需要额外的结构化规划调用。

## 验证范围

回归覆盖 child 零 planner、显式 force 标记、恢复与 follow-up、隐藏工具的伪造调用、深度配置拒绝、宿主直接 spawn/send 拒绝、父当前/下一步骤准确性、只读与真实拒绝、取消及结果汇总。真实 `pnpm dev` PTY 使用默认 auto/reviewer 与受控 provider，父任务读取实际仓库、委派有限 child、等待结果、完成汇总，结束后继续响应输入。

前轮验收仍按 [历史报告](PROJECT_BROWSE_SETTLEMENT.md) 与原账本保留。本轮复用 `/tmp/agent-browse1000-n43rC0/budget.json`，起始累计 374/1000，绝不重置或扩大；最终真实复验结果单独记录，不改写先前版本的成功或失败。
