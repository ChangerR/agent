# App 与缓存运行时的隔离集成

## 依赖与状态

- App 独立 PR：#47，基于 #45，最初 head 为 7c554f9；后续 review / Node 验收修正也需包含。
- 缓存实际运行时：6f73abc8d0001de09fafd9a0f339312c4c88f798，包含 a0562c0 schema 与后续运行时、cache 稀疏继承修复。
- 隔离分支：integration/macos-cache-settings。本分支本地合并上述来源，未修改两个原分支，未合并远端 PR。
- 额外接入修正独立提交，可在依赖重排后 cherry-pick；最终树已包含接线，用户无需手动填写 schema 或 ownedFields。

#47 单独部署时只开放其实际 schema 的字段。合并缓存依赖与本接入修正后，以下全部字段可从实际 React 表单配置：

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
node desktop/scripts/ui-cache-smoke.mjs
```

缓存分支若继续改变运行时，应以最终 head 重跑本文件的测试；不把只读 schema 快照误报为已接入。
