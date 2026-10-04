# AgentLab 架构与内部原理

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

核心原则：**一切皆为插件**。core 不认识任何具体的模型厂商、工具或 skill —— 所有能力都通过 `Plugin.register(ctx)` 挂载到注册表上。内置的 6 个工具和第三方插件走的是同一条路。

## 1. 规范化协议层 `src/core/protocol/types.ts`

为什么需要它？如果 loop 直接用 Anthropic 的消息格式，换成 OpenAI 就要重写一切。协议层定义了厂商中立的三种类型：

- **`Message`**：持久化的对话历史。AssistantMessage 的内容是 content blocks（`text | thinking | tool_use`），工具结果以 `tool_result` block 包在 user 消息里回填 —— 这是 Anthropic 的建模方式，OpenAI 侧由 adapter 转译。
- **`StreamEvent`**：流式增量。关键设计是把 tool_use 的输入建模为 **JSON 字符串增量**（`tool_use_delta.input`），与 Anthropic 的 `input_json_delta` 对齐；OpenAI 的 arguments 分片也能自然映射。
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
4. 聚合成 AssistantMessage 入历史，发 `turn_end`（带 token 用量）
5. 没有 tool_use → `loop_end`，结束
6. 有 tool_use → 逐个（连续的只读工具并行）：
   - `PreToolUse` 钩子：可改写参数、可 veto
   - `PermissionEngine.check()` → allow / ask / deny
   - ask → 发 `permission_request` 事件并**挂起 Promise**，UI 决策后 resolve
   - 执行 → `PostToolUse` 钩子 → 发 `tool_result` 事件
7. 所有 tool_result 包成一条 user 消息回填 → 回到 2

几个值得注意的设计：

- **用户拒绝也是 tool_result**（`isError: true`）。模型看到"用户拒绝了 + 理由"，会自己调整策略 —— 人在回路不是异常分支，只是另一种工具结果。
- **中断**用 AbortController 贯穿：loop 检查 signal，bash 工具 kill 子进程，provider 的 HTTP 请求也被 abort。
- **并行策略**：连续的可并行工具（只读）组成一个 batch 用 `Promise.all` 执行，写/执行类串行 —— 与 Claude Code 的行为一致。

## 5. 权限引擎 `src/core/permission/engine.ts`（重点）

决策管线，命中即返回：

```
1. deny 规则       —— 最高优先级，yolo 也不可逾越
2. 危险命令检测     —— 工具 analyzeInput 标 dangerous → 强制 ask（dangerForceAsk 可关）
3. allow 规则      —— 命中即静默放行 ← "自动审批"的主力
4. ask 规则        —— 命中即询问
5. 模式默认值       —— yolo→allow / auto→只读放行 / ask→全部询问
```

规则语法：`bash(npm test *)`、`edit_file(src/**)`、`read_file`。匹配用的是工具自己提供的"靶子"字符串 + minimatch glob。

**自动审批的四条路径**：

| 路径 | 机制 | 适用 |
|------|------|------|
| 预授权规则 | allow 规则命中即静默放行 | 已知安全的固定操作（如 `bash(npm test *)`） |
| 会话级"始终允许" | 用户在弹层选 remember → `addSessionRule` 写入会话规则，排在所有规则最前 | 越用越顺的渐进授权 |
| auto 模式 | 按工具风险级别放行只读操作 | 日常编码 |
| LLM 审批员（可选） | auto 模式下，管线判 ask 的操作交给小模型复核，明显安全才放行 | 减少打断，又不想全开 yolo |
| yolo 模式 | 全部放行（deny 与危险检测仍生效） | 沙箱/容器内无人值守 |

**LLM 审批员**（`src/core/permission/judge.ts`，配置 `judgeModel` 启用）：定位为确定性管线的"兜底顾问"而非替代品——只在判定来源是模式默认值时介入，deny 规则与危险命令检测永远先于它；审批员判 allow 才放行，判 ask / 不确定 / 调用失败一律回落询问用户（保守倾向：宁可多问，不可错放）。审批结果写入审计日志（source: `judge`）。

**ask 的异步机制**是 core/UI 解耦的关键：`check()` 返回 `kind: 'ask'` 后，loop 发出 `permission_request` 事件，事件里带一个 `resolve` 回调；TUI 弹层、用户选择、`resolve(decision)` 回传 —— loop 全程不知道 UI 的存在，测试里也可以直接模拟用户点击（见 `tests/loop.test.ts` 的 ask 用例）。

每次判定都进审计日志（命中规则、来源、理由），TUI 里 `/permissions` 可查。

## 6. 钩子系统 `src/core/hooks.ts`

四个钩子点：`PreToolUse`（在权限管线第 0 步，可改写/否决）、`PostToolUse`、`UserPromptSubmit`、`TurnEnd`。插件通过 `ctx.hooks.register()` 挂载。示例见 `plugins/example/index.ts`。

## 7. MCP `src/mcp/`

- `mcp.json` 声明 server（stdio 或 streamable-http）
- `McpClientManager` 用官方 SDK 建连，`listTools()` 拿到远端工具清单
- 每个远端工具桥接为本地 Tool，命名 `mcp__<server>__<tool>`

桥接之后，MCP 工具与内置工具完全同构：同样的权限规则、同样的事件、同样的回填路径。这展示了插件架构的威力 —— loop 不需要知道 MCP 的存在。

验证：`tests/mcp.test.ts` 会真实拉起 `examples/mcp-server.ts`（stdio），调用 `mcp__demo__add` 并断言结果。

## 8. Skill `src/skills/`

渐进式披露（progressive disclosure）——Claude Code skill 系统的精髓：

1. `SkillLoader` 扫描 `~/.agent/skills/*/SKILL.md` 和 `.agent/skills/*/SKILL.md`，只解析 frontmatter（name + description）
2. system prompt 里**只注入清单**，不注入全文 —— 上下文经济
3. 模型判断需要时调用 `use_skill(name)` 工具，全文才作为 tool_result 进入上下文

也就是说，"使用 skill"这个动本身就是一次普通的工具调用，没有任何特权路径。

## 9. 上下文管理 `src/core/context/`

- `estimateTokens`：~3 字符/token 的启发式估算
- 超阈值 → 把最早一半消息交给 LLM 总结成摘要块，替换原消息；LLM 不可用时降级为硬截断占位
- `buildSystemPrompt`：环境信息 + 工具清单 + skill 清单 + 项目 AGENTS.md

**模型规格注册表**（`models.json` + 内置 `MODEL_PRESETS`）：每个模型可声明 `contextWindow` 与 `maxOutputTokens`。`loop.setModel()` 时自动联动：压缩阈值压到 `min(配置值, contextWindow × 80%)`，请求的 `maxTokens` 用模型的输出上限。未知模型回退到全局配置值。

## 10. 插件 API 与装配 `src/core/plugin.ts` + `src/index.ts`

```ts
interface Plugin { name: string; register(ctx: PluginContext): void | Promise<void> }
// PluginContext: { providers, tools, hooks, config }
```

`createAgent()` 的装配顺序即架构分层：providers → 内置工具 → skills → MCP → `config.plugins` 里的外部插件（动态 import ESM 模块，默认导出 Plugin）。

**想验证插件机制？** 在 `agent.config.json` 加 `"plugins": ["plugins/example/index.ts"]`，启动后 `/tools` 能看到 `current_time`。

## 11. TUI `src/cli/`

[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) 实现（命令式组件模型 + 差分渲染，无 React）。整个入口只做两件事：订阅 EventBus 渲染、把用户输入交给 `loop.run()`。权限询问用 `SelectList` overlay 弹层，助手输出用 `Markdown` 组件流式渲染，输入框是带 slash 命令补全的 `Editor`。换成 Web 前端只需要重写这一层。

## 12. 建议的阅读顺序

1. `src/core/protocol/types.ts` —— 地基
2. `src/providers/fake.ts` + `tests/loop.test.ts` —— 看 loop 行为如何被精确验证
3. `src/core/loop.ts` —— 心脏
4. `src/core/permission/engine.ts` + `tests/permission.test.ts` —— 决策管线
5. `src/providers/anthropic.ts` vs `openai.ts` —— 协议翻译
6. `src/mcp/plugin.ts` —— 插件架构的真实案例
7. `src/index.ts` —— 装配全景
