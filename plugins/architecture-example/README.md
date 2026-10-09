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
- `tests/plugin-context-capabilities.test.ts` 覆盖取消、过期/非法候选、不完整工具交换、深不可变输入与返回引用隔离。
- `tests/plugin-session-capabilities.test.ts` 覆盖替代存储 CAS、当前 schema 与独立版本、未知可选状态保留、安全状态缺失拒绝和恢复失败回滚。
- `tests/plugin-architecture.test.ts` 检查 core/runtime 可执行依赖图，并在独立 Node 进程中拦截 TUI 包解析以验证 headless 导入。

## 当前架构与会话边界

上下文和存储使用 `core/context/coordinator.ts` 与 `core/session/coordinator.ts` 的注入式协调器。模型信息由选中的 `ModelCatalog` 提供；插件契约统一为 SDK 的 manifest/setup。

默认 preset 使用 `deterministic` 策略与严格 `model` 审批员。此示例通过显式能力选择替换默认策略，不改变默认产品语义。

会话只接受当前 schema，并分别校验 runtime、policy 和 pluginStates 版本以及 provider/endpoint 身份。未知可选状态原样保存；未知或缺失的安全必需状态拒绝恢复。历史会话不导入、不升级，也不生成迁移备份。

默认 JSONL 只写元数据。完整正文需显式设置 `pluginConfig["agentlab.telemetry-jsonl"].includeBodies: true`。

## 取消与未确认写入

压缩器有独立取消/超时边界。生成或改写的用户正文只能标为摘要，不能制造真实用户授权；保留工具证据必须来自原历史且顺序不变。它收到隔离的事件总线，只允许转发本次 compact 请求与用量，不能读取主运行的审批 resolver。

SessionStore 的异步方法接收可选 AbortSignal。文件后端在提交前检查取消；原子提交开始后仍返回真实提交结果。若替代后端无视取消，协调器停止等待并明确报告“结果尚未确认，可能仍会提交”，继续跟踪原操作，不假定回滚、不自动重试。关闭期间存储插件资源保持可用，待已启动的操作真实结算后再释放。
