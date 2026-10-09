# AgentLab 插件架构

AgentLab 仍是单个 npm 包。`agentlab/sdk` 提供契约；`PluginHost` 负责发现后的依赖排序、事务注册和清理；`createAgent` 选择默认 preset；内核只负责协议、状态、取消、历史和执行门。

## 一次调用的路径

模型调用、命令的 `context.invokeTool`、`agent.invokeTool` 和工具内部的 `context.invokeTool` 全部进入 `ToolExecutor`：

1. 校验 JSON 参数及 schema，运行参数变换，再次校验。
2. 固定工具身份/版本、最终参数、会话、run、策略和配置 revision。
3. 收集分析事实，执行选定 policy。只有 `review` 可以调用 reviewer。
4. `ask` 交给人工 responder。只有观察者、不提供 responder 时立即返回 `approval_required`。
5. 执行前重新检查绑定、取消和分析器环境前提。发生变化重新评估，不复用旧批准。
6. 执行一次，返回一个 ToolResult。观测或渲染失败不会重做已经发生的副作用。

插件是受信任的同进程 JavaScript。它们仍能自行导入 fs、child_process 或读取环境。描述符、secretRef 和 TypeScript 不是操作系统沙箱。本文的“统一入口”是受支持的 runtime 调用协议，不声称能限制恶意插件的任意 OS 访问。

## 最小插件

```ts
import { definePlugin } from 'agentlab/sdk';

export default definePlugin({
  manifest: { id: 'example.greeting', version: '1.0.0', apiVersion: 1 },
  setup(ctx) {
    ctx.provide.command('hello', {
      description: '显示问候',
      inputSchema: { type: 'object', properties: { args: { type: 'string' } } },
      handler(input, context) {
        context.signal.throwIfAborted();
        return { type: 'text', text: `hello ${input.args ?? ''}` };
      },
    });
  },
});
```

项目配置：

```json
{
  "pluginEntries": ["./plugins/greeting.mjs"]
}
```

新命令自动出现在 `/help` 和补全中。`agentlab --command '/hello world' --json` 使用同一 registry，执行该命令不加载 pi-tui。需要交互但没有 responder 的命令返回结构化 interaction_required，不自动授权。

插件源必须是可导入的本地 ESM（编译后的 JS，或在支持 TS loader 的开发进程中运行 TS）。运行插件相当于信任其代码；本期没有在线安装器或插件市场。

## 能力与选择

多值能力包括 provider、tool、analyzer、contextSource、skillSource、command、settings、telemetry、可选 tui 描述符。policy、reviewer、compactor、cacheStrategy、modelCatalog、sessionStore 使用显式选择。

```json
{
  "pluginEntries": ["./plugins/architecture-example/plugin.mjs"],
  "capabilities": {
    "policy": "example-policy",
    "reviewer": false,
    "compactor": "example-noop",
    "sessionStore": "example-memory"
  },
  "pluginConfig": {
    "example.replace-capabilities": { "prefix": "configured" }
  }
}
```

可运行完整例子见 `plugins/architecture-example/`。它在不编辑 core/index/CLI 的情况下替换 policy、compactor、store，增加工具、命令、设置、上下文和 provider。内存 store 只是替换证明，不是新增长期记忆产品。

重复插件 ID、能力 ID 或 alias 会失败。多个单例实现未选定也会失败，不采用最后加载覆盖。默认 preset 选择 `deterministic` 策略和严格 `model` 审批员；外部替代必须修改 `capabilities`。关闭内置工具可设置 `pluginConfig["agentlab.local-tools"].disabled`；替代同名工具需先关闭旧工具再注册新工具。`disabledPlugins` 在新会话生效；缺少仍被选定的关键能力会启动失败。

## 生命周期与依赖

清单支持 `requires` 与 `optional` 的稳定 semver 范围（精确、^、~、比较、x、||）；不认识的范围报错。配置顺序决定无依赖项的稳定次序，依赖先加载。

`setup` 的注册写入暂存事务，全部 setup 和 activate 成功后才公布能力图。中途失败不会留下可调用的工具、命令、hook 或订阅。资源分配后立即 `ctx.onDispose`，或用 `ctx.withResource` 先登记释放再初始化。宿主事务只回滚注册和登记资源，无法撤销任意外部副作用。

`ctx.dependencies` 只能读取声明过的依赖。工具依赖只提供描述，不提供 execute；调用工具用运行时的 invokeTool。不要在 setup 执行用户操作。

退出先停止接收、取消并等待活动调用，完成必要持久化，再逆依赖释放。单个 cleanup 失败仍继续其他 cleanup；超时会报告 `cleanup_timeout`，状态为 failed，不声称资源已经释放。没有运行中热卸载。

## 配置和设置

配置分为 pluginEntries（发现）、capabilities（选择）、pluginConfig（插件专属参数）；插件只接受 SDK 的 manifest/setup 契约。

插件可声明 defaults、schema、允许 scopes、敏感字段、字段 merge 和 applyMode。默认数组替换；明确的 append 才拼接。层级是 defaults → global → project → session/CLI。插件 schema 校验当前参数，不自动转换历史格式；manifest 的 API/插件版本及依赖范围仍须通过校验。敏感字段只接受 `env:NAME` 引用，不保存明文密钥。

SettingsSection 是可发现的元数据与 read/draft/commit API。`scopeTargets` 声明实际支持的作用域及保存路径；read/draft/commit 的可选 scope 参数选择原始配置层，草稿与该层绑定，不能跨层提交。内置持久化设置的默认 API 作用域仍为项目层；未声明 scope 的第三方设置保持原调用合同，界面标为“插件定义（未声明保存目标）”，不推断其是否持久化。通用 TUI 默认项目作用域，允许明确切换到全局，显示真实路径，读取原始层值；不会把已合并的项目权限或能力选择自动存入全局。TUI 的通用编辑器在一次有效 JSON 提交中依次执行 draft 和 commit，没有独立 Save 或重复确认，Esc 未提交不写；复杂权限编辑器复用同一注册入口。`PluginConfigStore` 提供 schema 校验、未知字段保留、文件身份/CAS、符号链接保护和原子写。插件仍需选择适合自己领域的提交语义，不能把 applyMode 标签误当作自动热更新。

配置定义可用 `ownedFields` 明确声明插件管理的顶层字段，提交时须把同一定义传给 `store.commit`。解析结果中省略或为 `undefined` 的已声明字段会从该插件当前选定作用域的配置删除（例如删掉严格 reviewer 的 `provider` 后恢复继承）；schema 提供默认值的字段则保存其解析后的默认值。其他未知字段、其他插件命名空间和顶层未知配置保持不变。不声明 `ownedFields` 时沿用补丁合并，省略字段不删除。schema 只需实现 `parse`，宿主不会依赖 zod 的 `shape` 或其他实现细节；嵌套对象仍按顶层字段整体替换。

权限只从顶层 `permissionMode`、`permissions` 读取；列表按 global 后 project 拼接，同 action 类别 session 优先，跨 action deny 与明确 ask 优先。`judgeModel`、`compactThreshold` 等顶层运行配置不在 pluginConfig 中提供别名。启动读取配置，不重写原文件。

`judgeModel` 三态保持：缺省继承；最终未指定或空字符串跟随当前主模型；非空固定模型。默认 permissionMode 仍是 ask。关闭 reviewer 要显式 `capabilities.reviewer=false`，不是把 judgeModel 清空。

## 会话、上下文与观测

SessionStore 的实现替换不改变内核校验。文件后端保留锁、CAS、revision、原子提交和删除/重建语义。当前版本 envelope 分开记录 runtime schema、policy id/version、插件状态 schema。未知可选状态原样保留但不执行；缺少或不兼容安全状态拒绝恢复。恢复只导入历史，不重放工具。

恢复只接受当前会话 schema，要求 provider/endpoint 身份与 policy id/version、必要安全状态匹配。缺失身份、历史格式或不兼容状态明确拒绝，不导入、不升级、不生成历史备份。

Compactor 只返回候选历史。内核检查不可变输入、取消、陈旧提案、消息 schema 和工具交换配对；新增摘要不能伪造真实用户授权。ContextSource 保留来源和稳定性标记，不能通过得到的工具描述修改 runtime。

默认 JSONL telemetry 只写白名单元数据，保留用途、模型、判定来源、reasonCode、执行标识与用量。正文需显式 `pluginConfig["agentlab.telemetry-jsonl"].includeBodies=true`。日志不外发。telemetry/renderer 异常隔离为诊断。

TUI entry 独立按需加载。外部 entry 获得 UI 操作、只读目录、dispatchCommand 和守门的 invokeTool，不获得可变 Agent。没有 entry 时仍可通过通用命令/设置/工具结果工作；headless 不导入终端模块。

## 运行时边界

- 重名注册失败；能力替换在 startup 配置完成，运行时能力图冻结。
- `agent.tools` 与 `agent.plugins` 是只读描述目录，不暴露 execute/注册/释放。调用工具使用 `agent.invokeTool`，子工具使用 `context.invokeTool`。
- 外部插件只用 `agentlab/sdk` 的 manifest/setup。宿主事务公布完整能力图，失败不会留下半成品注册。
- 参数 schema、批准绑定、无 responder 终止和观察者隔离始终生效。默认日志脱敏。
- core 只依赖契约与协调器，领域实现属于 builtin；不保留转发 facade。

## 设计到源码

| 设计能力 | 实际入口 | 主要证据 |
| --- | --- | --- |
| SDK 与宿主 | src/sdk、runtime/plugin-host、capability-registry | plugin-host.test.ts |
| 默认装配 | builtin/default-preset、runtime/create-agent | bootstrap、plugin-replacement |
| 唯一工具门 | core/tool-executor、permission/contracts | tool-executor、loop、runtime-boundaries |
| 策略/审批员 | builtin/policy、builtin/reviewer-model | deterministic-policy、reviewer-contract、policy-runtime |
| 上下文/压缩/cache/catalog | core/context、对应 builtin | context、cache、plugin-context-capabilities |
| 会话与文件 store | core/session/coordinator/envelope、builtin/session-file | session、endpoint-session、plugin-session-capabilities |
| 命令/设置/呈现 | runtime/commands、builtin/commands、cli/tui-plugins | cli、permission-settings、plugin-cli-capabilities |
| 日志 | builtin/telemetry-jsonl | plugin-telemetry |

## 验证方式

`pnpm test`、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 针对最终树执行。测试覆盖当前默认装配、配置、锁/并发、失败、取消、窄终端和外部替换，不再以历史行为相等作为验收要求。

此实现不使用真实付费模型做安全证明，不把模型间一致当成安全性。确定性策略与严格审批员的语义见 [POLICY.md](POLICY.md) 和 [REVIEWER.md](REVIEWER.md)。
