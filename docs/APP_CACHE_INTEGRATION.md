# App 与缓存运行时的隔离集成

## 依赖与状态

- 2026-10-22 核实 master 为 9fbffd634adb8b228b0f5fe9c147343fd914e24c，已包含 #45 的原 App 和 #48 的缓存运行时。
- #47 已合并关闭，但目标是旧 App 分支 codex/desktop-session-recovery；其设置 / macOS 增强未随 #45 进入 master。
- #48 于 06:24:41 UTC 合入 master；#49 于 06:24:59 UTC 合入 feature/cache-runtime-budget-and-reuse，实际集成 tip 为 bed0728c3f29a540430da40d014b7600712bc1d4。#49 的合并没有把 App 增强带入 master。
- 核实时没有开放的收尾 PR。本轮从实际集成 tip 建立 feature/app-macos-settings-to-master，普通 merge 最新 master，直接以 master 为 PR base；不再依赖人工 integration/app-cache-base。
- 本轮 merge 无文件冲突；清理一处仅有顺序差异的规划 import，同时保留 PlanningError 与 PresetContext。完整保留用户历史，未修改已合并 PR，未 force push 或合并任何远端 PR。
- 相对 master 的差异仅含 App / macOS / 设置接入、相关测试与文档；src/core、src/providers、src/mcp 和 policy 没有重复差异。收尾 PR 尚未合并，不能把它描述为 master 已具备这些 App 设置。

收尾分支已包含实际缓存 schema / ownedFields 和接入修正，以下全部字段可从实际 React 表单配置：

| 字段组                                                                             | 实际注册与 App 入口                                                        | 生效                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ |
| replayToolArguments                                                                | 顶层 AgentConfigSchema → 其他运行配置                                      | 重建 runtime                         |
| cache.staticTtl / ttlStrategy                                                      | 顶层 cache 对象 → 上下文与缓存预算                                         | 重建 runtime                         |
| planning.provider / model / thinking / maxOutputTokens / maxRequestBytes           | PlanningConfigSchema + 六个 ownedFields → 主任务规划                       | 重建 runtime；已有 mode 命令继续即时 |
| summary.provider / model / thinking / strategy / maxOutputTokens / maxRequestBytes | SummaryConfigSchema + ownedFields → 摘要模型与预算                         | 重建 runtime                         |
| reviewer.thinking 与既有 judge 预算 / prefixCache                                  | ReviewerConfigSchema + ownedFields → 审批模型与预算                        | 重建 runtime                         |
| 两个 provider 的 models 能力映射                                                   | ProviderModelsSchema + ownedFields → OpenAI / Anthropic 模型能力 JSON 编辑 | 重建 runtime                         |
| MCP maxInlineChars / maxAgeDays / maxStoredBytes / deduplicate / maxSearchChars    | McpResultConfig + ownedFields → MCP 结果预算                               | 重建 runtime                         |

“重建 runtime”对 App 指退出并重新启动；单独新建或恢复会话不承诺重载这些插件配置。

## 自动装配与冲突解法

保留 App 的 plugins 数组收集，再以 runtimeSettingsPlugin(input, plugins) 注册配置入口。
保留缓存所需的三个参数：builtinMcpPlugin(config.mcpConfig, cwd)、createCompactionSummaryPlugin(input)、planningPlugin(services, cwd, input)。
规划 import 同时保留 PlanningError 与 PresetContext，不能用一侧覆盖另一侧。

接入修正还让 ZodRecord / Union 生成 JSON schema；模型能力映射现在使用对象初值和真实子项约束。
只投影 schema 已知字段，保留现有模型项内部的未知字段；未知正文不会传入 renderer。
不复制缓存 schema，不另造配置别名，不绕过工具权限。

## 已执行的集成验证

- worker 的实际设置目录包含所有上述字段，并标明重启；打开不创建或重写配置。
- App 只保存项目 cache.staticTtl，磁盘没有 enabled / ttl 默认回填，loader 仍继承全局 enabled=false / ttl=5m。
- summary.strategy、reviewer.prefixCache、MCP deduplicate、replayToolArguments 不会被打开设置或其他字段提交自动开启。
- App 保存角色配置，dispose 后重新 createAgent；FakeProvider 实际接收到配置的 planner / summary 模型、thinking 和输出预算，judge 状态采用配置模型。
- 模型能力映射的未知嵌套字段保留，非法 api 被拒绝；重启后 adapter.modelCapabilities 真正采用保存内容。
- Node / Playwright 操作真实 React + 构建 worker，逐节提交 planner / summary / judge、双 provider 能力映射、MCP 存储与检索预算，并检查返回的原始层值。

所有输入均为隔离 HOME / 临时项目 / 固定假凭据；FakeProvider 不调用真实厂商。Linux Chromium 验收不等于 macOS AppKit 实机通过。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm desktop:build
pnpm desktop:smoke
AGENTLAB_PREVIEW_PORT=4176 pnpm desktop:preview
# 另一个终端，Node Playwright + Chromium：
AGENTLAB_UI_ORIGIN=http://127.0.0.1:4176 pnpm desktop:ui-smoke
AGENTLAB_UI_ORIGIN=http://127.0.0.1:4176 node desktop/scripts/ui-cache-smoke.mjs
```

缓存分支若继续改变运行时，应以最终 head 重跑本文件的测试；不把只读 schema 快照误报为已接入。

## 最终验证与交付

组合后的根工程 / desktop 类型检查、96 个测试文件全部通过（1755 passed / 2 平台相关 skipped），包括 MCP 活跃租约与文件身份回归。desktop:build、sidecar smoke 和两套 Node / Playwright UI 验收通过。未在 macOS 实机验证。

接入代码独立 commit：d2b4403。#49 曾叠加真实 #48 分支，现两者均已由用户合并。因为 #49 的目标仍是缓存分支，本轮另建面向 master 的收尾 feature；保留 #47 未落地的 App 代码，缓存预算、provider、MCP 引用保护及 core 权限实现均与 master 相同。本任务没有合并远端 PR。

[结构化验证](evidence/app-cache-integration/validation.json) · [缓存稀疏覆盖截图](evidence/app-cache-integration/cache-sparse-overrides.png) · [摘要角色配置截图](evidence/app-cache-integration/summary-role-settings.png)。截图为独立 Linux 云端 Chromium，不能替代 macOS AppKit / 原生菜单 / Retina 验收。

补充边界 commit 4748122：插件入口数组按 entry 身份保留未知元数据，重排不串接到其他插件。最终完整回归 96 文件 / 1755 passed / 2 skipped，打包输入验证与 sidecar smoke 再次通过。可重放的接入代码为 d2b4403 + 4748122；完整已解决依赖冲突的树在本 PR 分支。

## 前轮冲突整理验证（历史记录）

#48 合入 master@1520808 后保留全部历史，规划 import 同时保留 PlanningError 与 PresetContext。其完整回归为 93 文件 / 1732 passed / 2 skipped。#49 同步该真实依赖后业务代码与此前已验证 App 完全相同，完整组合回归为 96 文件 / 1755 passed / 2 skipped。两边根工程与 desktop 类型检查、CLI / 桌面构建、sidecar smoke 均通过；#49 两套 Node / Playwright UI 验收通过。未使用 force push 或修改已关闭 PR。

该轮 master@1520808 尚未包含 #48，因此 #49 保留真实缓存依赖并携带 #47 的设置增强；其对 #48 的比较没有 src/core、src/providers、src/mcp 或 policy 的重复差异。这是此前状态的证据；最新交付关系以本文顶部为准。

[本轮结构化验证](evidence/conflict-reconciliation/validation.json) · [Node UI](evidence/conflict-reconciliation/ui-smoke.json) · [缓存表单 UI](evidence/conflict-reconciliation/cache-ui-smoke.json)。原生 macOS 验收限制不变。
