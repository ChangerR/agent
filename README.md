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
- **[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) TUI**：差分渲染、Markdown 流式输出、权限确认弹层、slash 命令补全、状态栏

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

## TUI 命令

`/help` `/model`（不带参数弹出选择器）`/mode`（同上）`/think off|low|medium|high`（思考等级）`/permissions` `/skills` `/tools` `/exit`，Esc 中断当前轮，Ctrl+C 中断/退出。

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

## 开发

```bash
pnpm dev          # tsx 直接跑 TUI
pnpm test         # vitest（39 个测试，含 FakeProvider 全链路与真实 MCP 桥接）
pnpm typecheck
pnpm build        # tsup → dist/
```
