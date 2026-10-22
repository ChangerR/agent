# 缓存与模型调用配置

这些配置沿用内置默认 → 全局 `~/.agent/config.json` → 项目 `agent.config.json` → SDK 会话覆盖。
插件字段存放在 `pluginConfig[插件ID]`。设置编辑器只保存用户在该层明确填写的值；删除字段表示继承，不能把有效默认值写回该层。
插件声明 `applyMode: newSession` 的字段在重新装配 runtime（重启或重新调用 `createAgent`）后生效；单独 `/new`、`/resume` 不重新加载插件。
规划 `mode` 仍支持现有即时命令与设置流程，其余新增角色配置需重新装配。

## 顶层配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `replayToolArguments` | `false` | 可选原始工具参数协议回放，来源路由/模型及解析对象不匹配时失效；钩子改写也使其失效。执行始终使用校验后的对象。 |
| `cache.enabled` | `true` | 控制 Anthropic 显式缓存，不能关闭 DeepSeek/OpenAI 服务端自动缓存。 |
| `cache.ttl` | `5m` | 会话消息边界的保留期，`5m` 或 `1h`。 |
| `cache.staticTtl` | 继承 `ttl` | tools 与静态 system 的保留期；可以静态 `1h`、会话 `5m`，反向顺序会被拒绝。 |
| `cache.ttlStrategy` | `fixed` | 默认固定保留期。`legacy-reactive` 才根据上一批工具耗时升级下一次请求。 |
| `cache.escalateAfterMs` | `0` | 仅用于 `legacy-reactive`；事后升级不能挽回已经过期的缓存，并可能增加写入费用。 |

Anthropic system 分为静态规则和环境块，静态块末尾有独立边界；环境仍是 system 内容，不改变权限层级。
tools、静态 system、上一轮消息末尾和本轮末尾最多四个边界，长 TTL 在短 TTL 之前。
不要为达到缓存长度阈值填充无用内容，也不要为命中率保留无用历史。

## 辅助角色

| 插件 | 字段与有效默认 |
| --- | --- |
| `agentlab.planning` | `mode=auto`；`provider`、`model`、`thinking` 省略时继承当前主模型；`maxOutputTokens` 省略时调用使用 `4096`；`maxRequestBytes` 可选。 |
| `agentlab.compaction-summary` | `provider`、`model` 省略时继承执行路由；`thinking` 省略时保留厂商默认；`maxOutputTokens=2048`；`maxRequestBytes` 可选；`strategy=isolated`。 |
| `agentlab.reviewer-model` | `provider` 省略时跟随当前 provider；`model` 省略时沿用 `judgeModel`，空字符串跟随主模型；`thinking` 省略时保留厂商默认；`maxOutputTokens=8192`、`maxRequestBytes=32768`、`maxResponseBytes=65536`、`timeoutMs=30000`。 |

所有输出均受实际路由的模型上限约束。所有角色共用最终请求 token 检查，字节上限另行检查。
容量未知时不会假装已证明请求可容纳；缺省输出预留明确设为 8192。Thinking 扩大后的输出超过模型上限时拒绝请求，不自动降低质量。
审批的 `prefixCache.enabled=false`、`prefixCache.ttl=5m` 保持现有默认；此配置只缓存静态提示，不缓存批准结果。

`strategy=prefix` 显式开启原前缀摘要。只有同一路由、同一模型、可确认的原请求包络和 adapter 明确支持时才使用：保留 system/tools/历史，设置 `toolChoice=none`，只消费摘要文本，绝不交给工具执行器。
工具响应、截断、预算失败或不支持的协议均回退隔离转写。真实用户原文仍作为有来源的历史证据保留，不能变成新授权。
当前内置明确支持该策略的是 DeepSeek Chat Completions 路由；其他适配器默认回退。此策略没有在线质量或费用保证。

## 模型/API 能力

`agentlab.provider-openai.models`、`agentlab.provider-anthropic.models` 是精确模型 ID → 能力的映射，默认 `{}`。
每项需要 `api`（`chat-completions`、`messages` 或 `generic`），并可设置：

- `thinkingLevels`: 支持的 `off/low/medium/high` 子集。
- `outputParameter`: `max_tokens` 或 `max_completion_tokens`，仅用于 Chat Completions。
- `offEffort`: `none`，仅在 API 明确支持时用于关闭 reasoning。
- `thinkingMode`: `budget` 或 `adaptive`，用于 Messages API；adaptive 的 off 会显式发送 disabled。
- `rawToolArguments`: 是否支持原始工具参数字符串回放。
- `prefixCompaction`: 是否允许保留原包络的可选摘要。不要在未经验证的代理上开启。

`agentlab.provider-openai.dialect=auto` 仍只识别官方 DeepSeek HTTPS 端点；代理需显式 `deepseek` 或 `generic`。
未识别的兼容厂商保留原有参数行为，不从模型名猜厂商。内置能力目录是有限集合，可用精确配置覆盖；不宣称覆盖所有未来模型。
模型窗口/输出规格仍由 `models.json` 提供，可用 `模型ID`、`provider/模型ID` 或 `routeId/模型ID`；越具体优先级越高。
`routeId` 是端点身份的脱敏摘要，不是服务端 cache key，不包含凭据值。

## MCP 结果

`agentlab.mcp` 配置 schema 位于 `src/mcp/result-config.ts`：

| 字段 | 默认 | 范围/行为 |
| --- | --- | --- |
| `maxInlineChars` | `24000` | 1024–1000000 个 Unicode 码点；当前结果预算可进一步收紧。 |
| `maxAgeDays` | `30` | 0–36500；0 禁用按年龄清理。 |
| `maxStoredBytes` | `268435456` | 正文与索引的逻辑字节软上限；0 禁用容量清理。 |
| `deduplicate` | `false` | 显式开启时只在当前项目复用相同正文，不跨项目。 |
| `maxSearchChars` | `1000000` | 每次字面检索扫描的码点上限，8192–10000000；可用 continuation 继续。 |

正文仍是 `mcp-results/<UUID>.txt`，新增 `<UUID>.index.json`。旧正文第一次续读时流式建立索引；结果 ID 与历史预览不变。
`mcp_read_result` 按 Unicode 偏移局部读盘，`mcp_search_result` 返回有界相关片段与真实偏移。检索为大小写敏感的字面量，不执行正则。
两者经过原有唯一权限门及父子工具范围限制；服务器离线时本地结果仍可恢复。

清理保护所有当前进程活跃租约，以及项目中已保存会话引用。为保守保护未保存的活跃历史，租约会保留该 runtime 已返回的结果直到关闭。
因此容量是软上限：被引用结果不会为了配额被删除，超限会出现在 MCP 状态中。清理只回收无引用结果，且有十分钟新文件宽限期；引用、索引或锁状态不明时停止清理。
默认在结果入库后维护；同项目的其他存活进程也受租约保护。移动/删除文件不是缓存命中优化，请不要绕过引用检查手动清空活跃目录。

## 统计与验证

默认脱敏 JSONL 增加路由、角色、模型、最终请求估算、TTFT、耗时、输入估算偏差及厂商报告的按 TTL 写入桶，不添加请求原文或密钥日志。
缺失 usage、TTL 分桶或 TTFT 均为未知，不能按零解释。恢复前未保留的统计也不猜测。
usage 锚点只保存计数与指纹；仅相同路由/包络、严格追加的完整历史前缀可复用。换模型、改 system/tools 或压缩后不会沿用旧锚点；校准不降低启发式安全下界。

DeepSeek 按已持久化的 prefix unit 命中，构建是 best effort；任意公共前缀不保证第二次立即命中。
Anthropic 输入总量是 uncached + cache read + cache write；OpenAI 字段按 API/模型解释，不能把 Responses API 字段直接发给兼容 Chat Completions 端点。
比较费用时需累计整项任务的输入、写入、输出/thinking、失败及辅助调用，不能用命中率变化代替费用结论。

本功能不预热缓存，不调用付费 API 做验证。离线 SDK/SSE 回归证明请求和安全边界，真实命中、质量、延迟与费用收益仍需用户另行授权在线实验。
