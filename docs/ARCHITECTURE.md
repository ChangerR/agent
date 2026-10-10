# AgentLab 架构与内部原理

> 当前架构使用 SDK 插件宿主、唯一 ToolExecutor、确定性策略和严格模型审批员。配置与能力入口见 [PLUGINS.md](PLUGINS.md)，权限语义见 [POLICY.md](POLICY.md)。


本文档逐模块讲解 AgentLab 的实现原理。AgentLab 是一个仿 Claude Code 的教学版 coding agent，设计目标是把"一个 agent 到底是怎么运转的"讲清楚。

## 0. 一张图看懂全局

```
用户输入 ──▶ AgentLoop ──▶ Provider.stream(messages, tools)
                              │
                              ▼
                     规范化 StreamEvent（text/thinking/tool_use 增量）
                              │
                              ▼
                   collectStreamAsync 聚合成 AssistantMessage
                              │
                    有 tool_use? ──否──▶ 一轮结束
                              │是
                              ▼
              PreToolUse 钩子 → 权限决策管线 → 执行工具 → PostToolUse 钩子
                              │
                              ▼
              tool_result 作为 user 消息回填 ──▶ 回到第一步（下一轮）
```

核心原则：**一切皆为插件**。core 不认识任何具体的模型厂商、工具或 skill —— 所有能力都通过 `Plugin.setup(ctx)` 挂载到注册表上。内置的 6 个工具和第三方插件走的是同一条路。

## 1. 规范化协议层 `src/core/protocol/types.ts`

为什么需要它？如果 loop 直接用 Anthropic 的消息格式，换成 OpenAI 就要重写一切。协议层定义了厂商中立的三种类型：

- **`Message`**：持久化的对话历史。AssistantMessage 的内容是 content blocks（`text | thinking | tool_use`），工具结果以 `tool_result` block 包在 user 消息里回填 —— 这是 Anthropic 的建模方式，OpenAI 侧由 adapter 转译。
- **`StreamEvent`**：流式增量。关键设计是把 tool_use 的输入建模为 **JSON 字符串增量**（`tool_use_delta.input`），与 Anthropic 的 `input_json_delta` 对齐；OpenAI 的 arguments 分片也能自然映射。每个工具增量和结束事件都必须带 `id`，聚合器按 ID 独立缓存参数；缺少或引用未知 ID 时拒绝处理。Anthropic adapter 将 wire block index 关联到真实调用 ID，OpenAI adapter 将分片 index 关联到调用 ID。参数不是合法 JSON 时直接报错，不会把错误参数交给工具执行。
- **`collectStreamAsync`**：把增量流聚合成完整消息的状态机，是"流式 → 结构化"的通用归约器，loop 和测试共用。

**学习要点**：读 `tests/protocol.test.ts`，看同一个规范化消息如何被翻译成两家厂商格式，以及 OpenAI 分片 tool_calls 如何被重新聚合。

## 2. Provider 插件 `src/providers/`

```ts
interface Provider {
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
```

Provider 只做翻译，不做决策。三个实现对应三种角色：

| Provider | 角色 |
|----------|------|
| `anthropic.ts` | 真实模型（Messages API） |
| `openai.ts` | 真实模型（OpenAI 兼容协议，一套代码接 DeepSeek/Kimi/通义/vLLM…） |
| `fake.ts` | **脚本化假 provider** —— 无网络、确定性地测试整条 loop |

`FakeProvider` 是教学的核心工具：你给它一个"剧本"（每轮返回什么事件），就能断言 loop 是否正确执行了工具、是否正确回填了结果。见 `tests/loop.test.ts`。

两家协议的翻译差异本身就值得对照阅读：
- Anthropic：tool_result 是 user 消息的 content block；流式按 content_block 分段。
- OpenAI：tool_result 是独立的 `role: 'tool'` 消息；流式 tool_calls 按 index 增量下发，id/name 只在第一片出现 —— 所以 `OpenAIStreamTranslator` 是有状态的。

## 3. 工具系统 `src/core/registry.ts` + `src/tools/`

```ts
interface Tool {
  name; description; inputSchema;      // 发给模型的部分
  risk: 'read' | 'write' | 'execute';  // 权限引擎用
  isConcurrencySafe?;                  // 只读工具可并行
  analyzeInput?(input);                // 权限引擎用：规则匹配靶子 + 危险标记 + 展示摘要
  execute(input, ctx);                 // 真正干活的部分
}
```

一个工具 = 给模型看的 schema + 给权限引擎看的元数据 + 执行体。三者分离是这个设计的要点：模型看到的是 JSON Schema，权限引擎看到的是风险级别和"匹配靶子"（bash 是命令串、文件工具是路径），执行体才触碰真实世界。

## 4. Agent Loop `src/core/loop.ts`

loop 是一台不碰 UI 的状态机，所有对外沟通走 `EventBus`。一次 `run(userInput)` 的完整路径：

1. `UserPromptSubmit` 钩子 → 用户消息入历史
2. 检查是否需要压缩上下文（超阈值 → 总结老消息）
3. `provider.stream()`，边收边把 text/thinking 增量转发成 UI 事件
4. 聚合成 AssistantMessage 入历史，发 `turn_end`（带 token 用量），通知 `TurnEnd` 钩子
5. 没有 tool_use → `loop_end`，结束
6. 有 tool_use → 逐个（连续的只读工具并行）：
   - `PreToolUse` 钩子：可改写参数、可 veto
   - `ToolExecutor` → policy 判定 → 必要时 reviewer 或人工确认
   - ask → 发 `permission_request` 事件并**挂起 Promise**，UI 决策后 resolve
   - 执行 → `PostToolUse` 钩子 → 发 `tool_result` 事件
7. 所有 tool_result 包成一条 user 消息回填 → 回到 2

几个值得注意的设计：

- **用户拒绝也是 tool_result**（`isError: true`）。模型看到"用户拒绝了 + 理由"，会自己调整策略 —— 人在回路不是异常分支，只是另一种工具结果。
- **中断**用 AbortController 贯穿：loop 检查 signal，bash 工具 kill 子进程，provider 的 HTTP 请求也被 abort。
- **并行策略**：连续的可并行工具（只读）组成一个 batch 用 `Promise.all` 执行，写/执行类串行 —— 与 Claude Code 的行为一致。

`run()` 返回 `AgentRunResult`：`reason` 区分 `completed / max_turns / max_tokens / aborted / error`，同时提供模型轮数、累计用量和错误信息。`completed` 只代表循环正常结束，研究中的任务成功率应由外部评测器判断。没有 UI 或 `error` 事件订阅者时，模型失败也能返回 `error` 终态。

每次主模型、压缩器和审批员调用都通过 `observedStream` 发出 `model_request` 与 `model_usage`，使用 `requestId` 关联，并用 `purpose: agent / compact / judge` 区分用途。请求记录是调用时的独立快照，不随后续历史修改而变化。`turn_end.usage` 是单次主模型响应的用量；`AgentRunResult.usage` 和 TUI 统计包含本次运行中的辅助调用。失败或取消时只能统计 provider 已经报告的用量。装配入口把这些事件写入 `~/.agent/state/projects/<项目 ID>/logs/*.jsonl`。

## 5. 权限策略与唯一执行门

`src/core/tool-executor.ts` 是所有受支持工具调用的唯一入口；`src/builtin/policy/` 实现默认确定性策略，`src/builtin/reviewer-model/` 实现严格模型审批。默认能力 ID 为 `deterministic` / `model`，默认模式是 `ask`。

审批按顺序处理 deny、不可降级约束、明确 ask、完整验证的精确目标授权，再应用模式默认。`ask` 默认询问；`auto` 对完整验证的项目内只读操作（普通文件、不存在路径与目录的 read_file，pnpm `node_modules` 硬链接文件，受控 glob/grep 搜索）及显式 `writeRoots` 范围写入可确定性放行；AGENTS/CLAUDE 说明、agent.config.json 与 `plugins/` 只在写入方向视为敏感，其余不确定操作交给 reviewer；`yolo` 仅跳过完整验证的普通项目文件写入，未知工具和动态 Shell 仍询问。敏感目标、项目外路径、未验收平台、特殊文件、硬链接和危险 Shell 不会交给模型降级。唯一的平台例外：原生 Windows 上 auto/yolo 的内置 read_file/glob/grep 在通过通用项目边界与敏感检查后交给 reviewer（`platform_read_review`），审批上下文注明“Windows 平台未做文件系统校验”，reviewer 不确定时回落人工；Windows 写入与 Shell 仍为人工确认。

Bash 的语法与授权分开：`tree-sitter-bash` 解析命令、逻辑连接、管道、重定向和展开等完整 Bash 语法；`tools/shell-readonly.ts` 对可证明的字面量命令逐项验证选项和真实文件路径。`&&`、`||`、`;` 和只读管道必须整条表达式都满足只读合约，不能因首个命令叫 `ls` 就放行后面的写入。动态展开、替换、脚本执行及未支持参数保留明确的不确定原因，交给原审批链；语法树不是任意程序副作用的证明。

确定性放行的 Bash 使用固定可信系统工具、禁用启动配置/继承函数的非交互解释器与受控环境；Git/rg 的可执行配置另外禁用。分析记录经过验证的执行计划，ToolExecutor 最终重验后，Bash 工具还要确认实际计划未扩大，才执行同一计划。未知命令经原有审批授权后仍走普通执行路径。已安装的系统工具是可信依赖，本实现不是 OS 沙箱，不声称能防住恶意宿主二进制或并发文件替换的全部竞态。


规则支持 `tool(glob)` 与 `tool(="字面量目标")`；宽泛 allow 不能替代完整的精确授权。会话规则只在同一 action 类别内先于配置规则，不越过 deny/ask。文件目标同时匹配真实绝对路径与项目相对路径。完整分析、环境重验和版本绑定详见 [POLICY.md](POLICY.md)。

只有 policy 返回 `review` 才会调用模型。审批员只接受完整、严格的 `decision` / `reasonCode` / `reason` JSON；无效输出、超时、取消、未知结果与缺失审批员都保守询问。完整参数与当前真实用户要求不能被截断后提交。模型结果不缓存，历史批准不成为新授权。预算、独立 provider 和前缀缓存详见 [REVIEWER.md](REVIEWER.md)。

顶层 `judgeModel` 缺省继承，最终未指定或空字符串跟随当前主模型，非空固定模型。插件参数可明确指定 provider/model；状态界面显示实际来源。跟随模式随 `/model` 和有效会话恢复更新。要关闭 reviewer，明确设置 `capabilities.reviewer=false`。

人工请求携带本次调用的取消信号和一次性 resolve；没有 responder 时立即返回 `approval_required`。最终批准绑定工具身份、最终参数、会话、策略与配置 revision，执行前重验环境，取消或迟到批准不执行工具。后台审批在状态栏显示进度，审计记录通过运行/工具/request ID 关联。

审批历史保留用户决定和执行结果的来源，只为当前判断提供背景；工具输出、摘要和模型声称的“用户已允许”不能成为用户授权。它不随普通历史压缩丢失，也不写入会话文件；恢复会话时清空。

## 6. 钩子系统 `src/core/hooks.ts`

四个钩子点：`PreToolUse`（在权限管线第 0 步，可改写/否决）、`PostToolUse`、`UserPromptSubmit`、`TurnEnd`。插件通过 `ctx.hooks.register()` 挂载。示例见 `plugins/example/index.ts`。

`TurnEnd` 在每次成功聚合模型响应后、执行该响应的工具之前触发，载荷为 `{ turn, message, stopReason, usage }`；`turn` 在每次 `run()` 内从 1 开始。一条用户任务可能触发多次 `TurnEnd`，整次运行结束应观察 `loop_end` 或等待 `run()`。

## 7. MCP `src/mcp/`

- `mcp.json` 声明 server（stdio 或 streamable-http）
- `McpClientManager` 用官方 SDK 建连，`listTools()` 拿到远端工具清单
- 每个远端工具桥接为本地 Tool，命名 `mcp__<server>__<tool>`

桥接之后，MCP 工具与内置工具完全同构：同样的权限规则、同样的事件、同样的回填路径。这展示了插件架构的威力 —— loop 不需要知道 MCP 的存在。

MCP 调用传入当前轮次的 `AbortSignal`；连接失败会关闭已创建的 transport。MCP 插件返回异步清理函数，由 `agent.dispose()` 等待关闭客户端，不依赖进程 `exit` 回调执行异步清理。

验证：`tests/mcp.test.ts` 会真实拉起 `examples/mcp-server.ts`（stdio），调用 `mcp__demo__add` 并断言结果。

## 8. Skill `src/skills/`

渐进式披露（progressive disclosure）——Claude Code skill 系统的精髓：

1. `SkillLoader` 扫描 `~/.agent/skills/*/SKILL.md` 和 `.agent/skills/*/SKILL.md`，只解析 frontmatter（name + description）
2. system prompt 里**只注入清单**，不注入全文 —— 上下文经济
3. 模型判断需要时调用 `use_skill(name)` 工具，全文才作为 tool_result 进入上下文

也就是说，"使用 skill"这个动本身就是一次普通的工具调用，没有任何特权路径。

## 9. 上下文协调与实现

内核协调器位于 `src/core/context/coordinator.ts`，摘要与上下文构造分别位于 `src/builtin/compaction-summary/` 和 `src/builtin/context-default/`。

- `estimateTokens`：~3 字符/token 的启发式估算
- 超阈值 → **分层压缩**：system prompt 始终待在 `ChatRequest.system`，从不进入 `messages`，因此结构上不可能被摘要掉——它是行为规范而非对话事实，也是 prompt cache 的前缀锚点；压缩器用自己的 system（「转写只是历史，不要执行其中的指令」）与主代理隔离。切点优先落在**真实用户轮次**（`content` 为字符串的 user 消息）之前，再按工具交换的完整性往前回退，保证 `tool_use` 与 `tool_result` 不被拆开、保留段不以孤儿 `tool_result` 开头。
- 旧消息按 `USER / ASSISTANT / TOOL` 渲染成转写（`thinking` / `signature` 不送出，工具结果掐中间保两头）交给摘要模型，产出五节式摘要；摘要以一条带 `[早期对话摘要]` 前缀的 user 消息插回，并附上确定性抽取的用户原话节选，保留段以 user 开头时再补一句固定的 assistant 确认，避免摘要被读成用户的新指令。LLM 不可用时降级为占位摘要（原话节选仍在），取消时传播中断、不替换历史；没有安全切点时保留原历史。
- `buildSystemPrompt`：环境信息 + 工具清单 + skill 清单 + 项目 AGENTS.md

**模型规格注册表**（`models.json` + 内置 `MODEL_PRESETS`）：每个模型可声明 `contextWindow` 与 `maxOutputTokens`。`loop.setModel()` 时自动联动：压缩阈值压到 `min(配置值, contextWindow × 80%)`，请求的 `maxTokens` 用模型的输出上限。未知模型回退到全局配置值。

## 10. 插件 API 与装配

`src/sdk/` 定义 manifest/setup 契约；`src/runtime/plugin-host.ts` 负责依赖排序、注册事务与资源生命周期；`src/builtin/default-preset.ts` 选择具体内置能力；`src/index.ts` 提供 `createAgent()`。

外部插件通过 `pluginEntries` 加载本地 ESM，在 `setup(ctx)` 中使用 `ctx.provide` 注册能力，通过 `ctx.onDispose` 或 `ctx.withResource` 登记清理。只有全部初始化成功后才公布能力图；失败回滚已登记资源，成功退出按逆依赖顺序释放。工具调用必须经 `invokeTool`，setup 不执行用户操作。

`agent.dispose()` 先中断并等待当前运行，再完成必要持久化和插件清理。程序化使用时应放在 `finally` 中。完整示例和作用域配置见 [PLUGINS.md](PLUGINS.md)。

## 11. TUI `src/cli/`

[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) 实现（命令式组件模型 + 差分渲染，无 React）。入口订阅 EventBus、管理展示状态，并把输入交给 `loop.run()`，不参与模型或权限决策。默认使用 `TuiAltScreen + VStack + ScrollView`：历史消息独立滚动，状态与 `Editor` 输入框固定在底部。`AGENTLAB_SCREEN=main` 切回终端原生滚动历史。

`src/cli/messages.ts` 负责流式块和工具消息：60ms 合并增量，切换正文/思考前刷新旧块，收到完整消息后校准内容。用户发言、Agent 回复、思考、工具与权限记录分别显示身份/类型标题；工具结果按 `toolUseId` 更新，展示运行/完成/失败和耗时。思考默认显示近期一行，工具默认显示输出预览；`Ctrl+O` 或 `/details` 切换全部展开，`/details <编号>` 在底部单独查看完整思考、工具参数/结果或审批理由。编号只属于 UI，恢复会话时重新分配。

`src/cli/turn-queue.ts` 在上一轮 `run()` 的 Promise 完全结束后才发送下一条输入，不能在 `loop_end` 回调中重入，因为旧轮次的清理尚未结束。

模型、模式、思考等级、会话选择与权限审批使用 `src/cli/interaction-panel.ts` 的固定底部面板，临时替换输入框，不再使用浮动弹层。面板按终端高度限制尺寸，优先保留选项和确认提示，长正文用 `Tab` 切入详情、`↑↓` 或鼠标滚轮查看，`Tab/Enter` 返回选项；浏览详情时 Enter 不会批准操作。模型选择预选当前模型，直接输入可筛选，窄屏也能查看所选项的完整说明。审批优先于其他选择器，结束后恢复之前的筛选；并行请求排队逐个显示。底栏固定显示模型/模式/思考设置与当前任务阶段，后台工具更新不会覆盖等待人工确认状态。

`permission_request` 携带所属轮次的 `AbortSignal`：core 中断时结束审批等待，UI 同步关闭面板并更新权限记录；过期的允许回调不会执行工具或添加规则。`startTui()` 支持注入 `Terminal` 并返回停止函数，`tests/cli.test.ts` 用内存终端验证真实渲染、按键、长正文和尺寸变化，不依赖真实模型或交互终端。可设置 `AGENTLAB_TUI_SNAPSHOT_DIR` 保存测试的实际屏幕文本供人工查看。换成 Web 前端仍只需要重写这一层。

## 12. 会话持久化 `src/core/session/`

一个会话属于规范化的项目根，落在 `~/.agent/state/projects/<项目根路径的 SHA-256>/sessions/<id>.json`。配置与状态分开；子目录和符号链接入口解析到相同项目身份，其他项目不能通过相同 id 访问该会话。不扫描或迁移旧目录。id 用本地时间加 4 位十六进制（`s-YYYYMMDD-HHmmss-xxxx`），避开 Windows 文件名里的冒号。没有 index，列表就是扫目录里的 `*.json`，坏文件进 `broken` 但不删。

当前 envelope 记录 runtime schema、provider/endpoint 身份、policy id/version 和插件状态 schema，以及压缩后的当前历史、模型、思考等级、会话级权限规则、权限模式、累计用量和统计。不放进行中的 run、`toolsSnapshot`、MCP / skill、system prompt 全文、项目配置里的权限、审计日志、半截流式块，也不放 API key。恢复后 system prompt 仍由 `buildSystemPrompt` 现装，工具列表在下一轮按当前注册表重新快照。

历史有两条硬约束：`tool_use.id` 与 `tool_result.toolUseId` 必须成对；思考签名和打码 data 原样往返。`[早期对话摘要]` 开头的摘要消息原样读写。保存前 `trimToSafeTail` 裁掉未完成的工具调用和头部孤儿结果，空历史不落盘。校验失败不碰磁盘。

写入是同目录临时文件再 `rename` 覆盖；失败删掉临时文件，旧文件保持原样。同一路径的写入串行。加载先校验再改内存：目录对不上、配对失败、规则语法不合法时，loop 和权限引擎都保持原样。会话规则照原样恢复。权限模式只在保存值不比当前更宽时才 `setMode`（ask < auto < yolo），避免重启后自动放宽。恢复后的调用仍走唯一 ToolExecutor 与当前选定策略。

`AgentLoop` 只提供 `exportSession` / `importSession`，不认识磁盘。`SessionManager` 订阅 `loop_end` 做自动保存——回调发出时 `running` 仍为 true，自动保存不能因此被拒绝。TUI 的 `/save`、`/sessions`、`/resume` 只跟 manager 和事件打交道；恢复后用 `renderHistory` 重画，不重放工具。

## 13. 建议的阅读顺序

1. `src/core/protocol/types.ts` —— 地基
2. `src/providers/fake.ts` + `tests/loop.test.ts` —— 看 loop 行为如何被精确验证
3. `src/core/loop.ts` —— 心脏
4. `src/builtin/policy/index.ts` + `tests/deterministic-policy.test.ts` —— 决策管线
5. `src/providers/anthropic.ts` vs `openai.ts` —— 协议翻译
6. `src/builtin/mcp.ts` —— 插件架构的真实案例
7. `src/index.ts` —— 装配全景
8. `src/core/session/coordinator.ts` —— 会话怎么存、怎么在不放宽权限的前提下恢复

会话恢复需要保存的 provider 名与 endpoint 指纹匹配当前配置，检查通过前不替换内存。会话不保存 endpoint 原文或 API 凭证。只接受当前 schema 和完整身份，不提供历史格式导入或绕过身份检查的恢复选项。

自动摘要使用 user 消息的 `source: "summary"` 标记；前缀只用于展示。无标记的历史按原始用户消息处理（不猜测旧摘要来源）。工具历史必须按调用后结果的顺序一对一配对，在结果完整前不能插入正文或下一次 assistant 响应。

自动保存是 loop 完成任务的一部分：`loop.run()` 等到本轮快照保存结束，保存失败时拒绝 Promise，同时发出 TUI error 事件。`session.flush()` 等待本管理器全部会话的保存并报告错误。默认 `agent.dispose()` 在等待当前轮次后保存最终模型、思考等级与权限设置，再清理全部插件，聚合保存与清理失败；`autoSaveSessions: false` 继续禁用自动和退出保存。异步保存的返回摘要来自该次不可变快照。

会话保存使用进程内队列加跨进程 `.json.lock` 独占文件锁，在同一锁内比较最后观察到的 `revision` 再原子写入。过期写入报 `SessionError(code: "conflict")`，不覆盖磁盘也不丢内存；调用方应先保留内存快照，再选择恢复最新历史。底层 `saveSession` 更新已有会话必须带加载得到的版本，`saveSessionVersioned` 返回新版本，`SessionManager` 自动维护自己的串行保存版本。

删除也进入同一路径队列与锁，使用 `.json.deleted` 删除版本标记防止其他进程的旧保存在删除后复活。标记保留并被会话列表忽略，重建后的版本继续递增。通过当前管理器成功删除后，下一次明确保存仅能重建该次删除，不能跨越其他写入者后续的重建与删除。底层调用方可显式传 `{ recreate: true }`，仅允许删除标记版本恰为快照 `revision + 1` 的重建。`saveSession` 不修改传入快照的版本，因此首次保存后不能直接复用无版本的原对象来重建，须使用最后加载或提交的版本。需要从旧内存历史显式删除当前磁盘版本再重建时，可用 `deleteSessionVersioned` 获取锁内提交的删除版本，并在删除成功后传入 `{ recreate: true, recreateRevision: result.revision }`；该授权只匹配那一次删除。`deleteSession` 仍返回布尔值。锁等待最多约 2 秒；崩溃留下的锁不会自动抢占，需确认原进程退出后人工移除。仅同一共享目录内遵循本协议的进程受保护，未验证网络文件系统的锁语义。
