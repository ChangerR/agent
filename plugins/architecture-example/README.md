# 可替换能力示例

这是受信任、同进程运行的本地插件示例。它不是操作系统沙箱；不要载入不信任的 JavaScript。

只修改项目配置即可：将 `agent.config.example.json` 的字段合并到项目自己的 `agent.config.json`，确认 `pluginEntries` 指向 `plugin.mjs`。然后运行 `pnpm dev`。离线 `architecture-demo` provider 会调用示例工具，不访问外部模型。

这个单独的 ESM 文件提供：

- `example-policy`：仅允许示例 echo 工具，输入 `blocked` 时拒绝。其他工具也拒绝。
- `example-noop`：接收深不可变历史，原样返回候选，不压缩。
- `example-memory`：进程内会话存储，保存/删除都使用 revision 与墓碑保护。退出后数据消失，不能代替需要持久化的数据备份。
- `example_echo` 工具，以及 `/example`、`/example-echo` 命令。命令通过 `invokeTool` 进入与模型调用相同的审批、取消和结果协议。
- `example-state` 设置项：显示调用计数和配置后的前缀。
- 带来源和稳定性标记的上下文段，以及离线 provider。

插件不持有可变 Agent，也不导入 core、默认插件或终端。TypeScript 插件可从 `agentlab/sdk` 导入 `definePlugin` 与公开契约；本 `.mjs` 示例直接导出同样的插件对象，便于独立加载。

## 配置与替换

`pluginEntries` 负责发现；`capabilities` 显式选择单例实现；`pluginConfig[插件完整 ID]` 提供参数。仅注册替代实现不会让它自动覆盖默认实现。同 ID 重复注册、命令 alias 冲突、缺少依赖都报错。更换实现于新会话生效，不热卸载。

## 回归证据

- `tests/plugin-replacement.test.ts` 真正从项目 JSON 配置加载此 ESM 文件，验证替代能力被 runtime 消费、保存/恢复不写会话文件、命令和模型共享工具执行路径。
- 同文件比较兼容构造入口与默认 preset 的规范化事件轨迹，剔除随机请求 ID、耗时和新增审计事件，保留用量、正文、工具调用/结果、审批类别和结束原因。
- `tests/plugin-context-capabilities.test.ts` 覆盖取消、过期/非法候选、不完整工具交换、深不可变输入与返回引用隔离。
- `tests/plugin-session-capabilities.test.ts` 覆盖替代存储 CAS、v1 导入、v2 独立版本、未知可选状态保留、安全状态缺失拒绝和恢复失败回滚。
- `tests/plugin-architecture.test.ts` 检查 core/runtime 可执行依赖图，并在独立 Node 进程中拦截 TUI 包解析以验证 headless 导入。

## 兼容门面范围

以下旧路径仅为已有调用者保留，生产 runtime 不经过这些路径；架构守卫对这十个文件作精确例外：

- `src/core/context/manager.ts`
- `src/core/context/system-prompt.ts`
- `src/core/debug-log.ts`
- `src/core/plugin.ts`
- `src/core/permission/engine.ts`
- `src/core/permission/judge.ts`
- `src/core/permission/review-context.ts`
- `src/core/permission-config.ts`
- `src/core/session/manager.ts`
- `src/core/session/store.ts`

新上下文和存储使用 `core/context/coordinator.ts` 与 `core/session/coordinator.ts` 的注入式构造。`core/config.ts` 保留旧模型目录常量作为兼容导出；实际模型信息由选中的 `ModelCatalog` 提供。

新会话使用 `schemaVersion: 2`，分别保存 runtime、policy 和 pluginStates 版本，旧 v1 二进制会明确拒绝。未知可选状态原样保存；未知/缺失的安全必需状态拒绝恢复，不执行其中内容。v1 权限规则只由兼容 legacy 策略导入，不隐式迁移到本示例策略。

默认 JSONL 只写元数据。完整正文需显式设置 `pluginConfig["agentlab.telemetry-jsonl"].includeBodies: true`；旧 `attachDebugLogger` 是保留完整正文行为的兼容 API。

## v1 迁移备份和恢复

首次将已有 v1 会话保存为 v2 时，文件存储在原会话锁内先把原始字节保存到 `<会话>.json.v1.bak`，验证后才替换 `.json`。备份排他创建、后续保存不覆盖。已有备份必须是同一会话、项目及 provider/endpoint 的有效 v1 文件；创建或验证失败就停止升级，保留原文件。

若必须使用旧版程序：先退出所有使用该项目的 agent，另行保留当前 v2 `.json`，再将对应 `.json.v1.bak` 复制回原 `.json` 路径，然后用原 provider/endpoint 启动旧版。备份是首次升级之前的历史，不包含升级之后的新消息。不要直接用旧版读写 v2 文件，也不要在 agent 运行时手工替换会话。

## 取消与未确认写入

压缩器有独立取消/超时边界。生成或改写的用户正文只能标为摘要，不能制造真实用户授权；保留工具证据必须来自原历史且顺序不变。它收到隔离的事件总线，只允许转发本次 compact 请求与用量，不能读取主运行的审批 resolver。

SessionStore 的异步方法接收可选 AbortSignal。文件后端在提交前检查取消；原子提交开始后仍返回真实提交结果。若替代后端无视取消，协调器停止等待并明确报告“结果尚未确认，可能仍会提交”，继续跟踪原操作，不假定回滚、不自动重试。关闭期间存储插件资源保持可用，待已启动的操作真实结算后再释放。
