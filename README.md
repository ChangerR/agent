# AgentLab

仿 Claude Code 的**插件式 coding agent 教学实现**（TypeScript + Node.js）。

核心设计：一切皆为插件 —— provider、工具、MCP、skill 都通过统一的 `Plugin` 接口挂载到 core 的注册表上。详细原理讲解见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 功能

- 事件驱动的 **agent loop**（core 不碰 UI，TUI 只是事件订阅者）
- **规范化协议层** + 两个 provider 参考实现：Anthropic Messages API、OpenAI 兼容 API（DeepSeek/Kimi/通义/vLLM…）
- **工具系统**：read_file / write_file / edit_file / bash / glob / grep，只读工具并行执行
- **权限引擎**：deny → 危险检测 → allow → ask → 模式默认值的决策管线；ask/auto/yolo 三模式；"始终允许"会话规则；审计日志
- **钩子**：PreToolUse / PostToolUse / UserPromptSubmit / TurnEnd
- **MCP**：stdio + streamable-http，工具以 `mcp__server__tool` 桥接
- **Skill**：渐进式披露（清单进 system prompt，全文按需 `use_skill` 加载）
- **上下文压缩**：超阈值自动摘要老消息
- **[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) TUI**：消息区独立滚动、固定输入框、Markdown 流式输出、工具结果合并与折叠、权限确认弹层、slash 命令补全、阶段与耗时提示

## 快速开始

```bash
pnpm install
cp .env.example .env   # 然后在 .env 里填入你的 ANTHROPIC_API_KEY
pnpm dev
```

程序启动时会自动加载工作目录下的 `.env`（Node 原生支持，无需 dotenv）。也可以用传统方式 `export ANTHROPIC_API_KEY=sk-...`。

OpenAI 兼容端点示例（`agent.config.json`）：

```json
{
  "provider": "openai",
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com",
  "permissionMode": "auto",
  "permissions": {
    "allow": ["bash(npm test *)", "read_file"],
    "deny": ["bash(git push *)"]
  }
}
```

`auto` 模式默认使用当前主模型审核未命中规则的写入与执行操作，无需另配审批模型；普通只读操作仍直接放行。审批失败或不确定时会询问，deny、危险检测与明确的 ask 规则继续优先生效。

可用 `judgeModel` 指定兼容同一 provider / endpoint 的独立审批模型。项目未写该字段时继承全局配置，最终未指定时跟随当前模型；`"judgeModel": ""` 则明确跟随当前模型并覆盖全局指定值。跟随模式会随 `/model` 和恢复会话更新，显式指定的审批模型保持不变。`/permissions` 可查看实际加载的审批模型及来源；需要未命中规则的操作都询问时使用 `ask` 模式。

## TUI 命令

`/help` `/model`（不带参数弹出选择器）`/mode`（同上）`/think off|low|medium|high`（思考等级）`/permissions` `/skills` `/tools` `/exit`。

默认使用全屏视口：消息区可以独立滚动，底部保留输入框与状态。思考内容和长工具输出默认收起，`/details` 展开或收起，`/stats` 查看 token、缓存命中率与日志路径。运行中发送的消息会排队，`/queue` 查看数量，`/queue clear` 清空。Esc 中断当前轮并清空排队；审批弹层中 Esc 只拒绝当前操作，Ctrl+C 中断整轮并关闭审批；空闲时 Ctrl+C 退出。

如果希望沿用终端原生滚动历史，可使用 `AGENTLAB_SCREEN=main pnpm dev`。画面残留时可输入 `/redraw`，或用 `AGENTLAB_FULL_REDRAW=1 pnpm dev` 启用全量重绘。

思考等级的映射：Anthropic → `thinking.budget_tokens`（low 2048 / medium 8192 / high 32768，`max_tokens` 自动抬到 budget 之上）；OpenAI 系 → `reasoning_effort`。配置默认值用 `agent.config.json` 的 `thinking` 字段。

## MCP

在项目根目录创建 `mcp.json`（参考 [examples/mcp-server.ts](examples/mcp-server.ts)）：

```json
{
  "mcpServers": {
    "demo": { "command": "npx", "args": ["tsx", "examples/mcp-server.ts"] }
  }
}
```

启动后 `/tools` 可见 `mcp__demo__add` 等工具。

## Skill

在 `.agent/skills/<name>/SKILL.md` 创建：

```markdown
---
name: deploy
description: 部署应用到生产环境
---

步骤：1. pnpm build 2. ...
```

模型会在需要时通过 `use_skill` 工具加载全文。

## 外部插件

```ts
// plugins/my-plugin/index.ts
import type { Plugin } from '../../src/index.js';
export default {
  name: 'my-plugin',
  register(ctx) {
    ctx.tools.register(/* ... */);
    ctx.hooks.register('PreToolUse', (payload) => { /* ... */ });
  },
} satisfies Plugin;
```

`agent.config.json` 里加 `"plugins": ["plugins/my-plugin/index.ts"]`。完整示例：[plugins/example/index.ts](plugins/example/index.ts)。

有连接或后台任务的插件可在 `register()` 返回清理函数（支持 async），agent 退出时会按注册逆序等待清理。

## 程序化运行与研究记录

```ts
import { createAgent } from './src/index.js';

const agent = await createAgent(process.cwd());
// 无交互界面的脚本也要处理审批事件；此例拒绝所有需要人工确认的操作。
agent.events.on('permission_request', ({ resolve }) => resolve({ allow: false }));
try {
  const result = await agent.loop.run('读取 README.md 并概括项目');
  console.log(result.reason, result.turns, result.usage);
} finally {
  await agent.dispose();
}
```

`reason` 区分正常结束、轮数上限、输出截断、中断和错误；正常结束不等于任务评测通过。每个会话的 `.agentlab/logs/*.jsonl` 记录请求快照和用量，`model_request` / `model_usage` 用 `requestId` 关联，`purpose` 区分主模型（`agent`）、压缩（`compact`）与审批（`judge`）。累计用量包含辅助调用，便于比较运行成本。请求记录包含对话和工具参数。

## 开发

```bash
pnpm dev          # tsx 直接跑 TUI
pnpm test         # vitest（含 FakeProvider 全链路、内存终端交互与真实 MCP 桥接）
pnpm typecheck
pnpm build        # tsup → dist/
```
