# 插件架构实施与验收清单

本清单描述当前单一路径架构；验收应针对同一最终源码树执行，不沿用历史测试计数。

## 架构要求

- SDK 仅提供 manifest/setup 插件契约；外部配置只通过 pluginEntries 发现插件。
- PluginHost 负责依赖与版本检查、注册事务、所有权/alias、失败回滚和逆序清理。
- 默认内置 policy 为 `deterministic`（`agentlab.policy`），reviewer 为严格 `model`（`agentlab.reviewer-model`）。
- ToolExecutor 是唯一工具入口，执行前重验最终批准绑定；没有 responder 明确终止。
- 模式保留 ask / auto / yolo，默认 ask；deny、不可降级约束和明确 ask 优先。
- context、compactor、cache、model catalog、SessionStore 和 UI 通过契约替换，内核负责历史校验。
- 会话只接受当前 schema 和完整身份，保留锁/CAS、版本检查、原子写及删除/重建约束。
- reviewer 严格验证输出、预算、取消和用量关联，不缓存 allow。
- `.env` 只加载项目根，显式 key 配置严格检查，不泄露密钥；设置默认项目层并自动保存。
- provider 协议适配和跨平台工具执行继续保留，真实身份与版本检查不得删掉。

## 验收

运行 `pnpm test`、`pnpm typecheck`、`pnpm build` 和 `git diff --check`。覆盖安全边界、并发、会话、外部插件、headless、窄终端及真实键盘设置流程。只用 FakeProvider 或本地故障替身；不调用真实付费模型、不更改真实用户配置。

插件是受信任的同进程代码，不是 OS 沙箱；禁用/替换在新会话或重启生效。验收范围和限制见 [VALIDATION.md](VALIDATION.md)。
