# AgentLab

## 插件架构与可选 v2

默认仍是 `legacy-v1`、`model-v1` 和 `ask` 模式。新插件使用 `agentlab/sdk`，通过 `pluginEntries` 加载，`capabilities` 明确选择实现。

- [插件 API、配置、生命周期和迁移](docs/PLUGINS.md)
- [确定性 v2 与显式目录写入授权](docs/POLICY-V2.md)
- [严格模型审批与用途统计](docs/REVIEWER.md)
- [只读 shadow、迁移预览和离线复现](docs/POLICY-SHADOW.md)
- [外部替换示例](plugins/architecture-example/README.md)

`/settings` 可浏览插件设置与下一会话实现选择；`/policy-migrate preview` 只读展示 v1/v2 差异。`pnpm exec tsx scripts/policy-shadow.ts --cwd .` 不执行工具或调用模型。原始 Shell 不做确定性放行；原生 Windows 的 v2 文件系统授予暂时保守询问。插件是受信任进程内代码，不是 OS 沙箱。


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

程序启动时会自动加载规范化项目根目录下的 `.env`（Node 原生支持，无需 dotenv）。也可以用传统方式 `export ANTHROPIC_API_KEY=sk-...`。

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

## 配置目录与作用域

- 全局默认：`~/.agent/config.json`；项目只保留需要覆盖的 `<项目根>/agent.config.json`。
- 向上寻找最近的项目边界：`agent.config.json`、`.git`（含 worktree 的文件形式）或 `package.json`。内层项目不会被外层 Git 仓库吞并；不会越过用户目录、系统临时目录或文件系统根来推断项目（直接在这些目录启动除外）；没有标记则使用启动目录。路径会解析符号链接，同一项目从子目录启动仍共用配置和会话，工具执行目录统一为该项目根。
- 用户运行状态：`~/.agent/state/projects/<规范化项目路径的 SHA-256>/sessions/` 和 `logs/`。不同项目即使会话 ID 相同也互不相通；移动项目得到新的身份。启动不会迁移或导入旧目录。
- 优先级：内置默认 → 全局 → 项目 → 程序调用时的会话覆盖。全局与项目权限列表拼接；SDK 显式传入会话 `permissions` 时替换该合并列表。插件参数和能力选择逐字段合并；普通数组替换。省略某层字段表示继承，不能靠保存合并结果把其他层授权复制过来。
- `modelsFile`、`mcpConfig`、`plugins`、`pluginEntries` 的相对路径按声明它们的配置文件目录解析，绝对路径保持。默认模型/MCP 文件为 `~/.agent/models.json`、`~/.agent/mcp.json`。项目使用本地文件时显式配置 `"modelsFile": "./models.json"`、`"mcpConfig": "./mcp.json"`。

`/settings` 中可持久化的实现选择、严格 reviewer 参数可明确选择“本项目”或“全局”，并显示真实保存文件；`/permissions` 同样提供独立的全局/项目草稿。先查看更改，再确认 Save；取消不写盘。项目设置不会自动提升到全局，`writeRoots` 的目录授权仍只提供本项目编辑，也拒绝从全局配置加载。保存配置在重启时生效，当前运行中的能力不会热替换。

`/model`、`/think`、`/mode` 修改本次会话，保存/恢复会话可保留这些选择，但不会修改全局或项目默认。要设启动默认，可在对应配置文件写 `model`、`thinking`、`permissionMode`。SDK 的 `agent.paths`、`agent.configSources` 和 `loadConfigWithSources()` 可诊断真实路径和字段来源；界面同时显示启动来源与保存目标。

API key 仍通过 `apiKeyEnv` 指定环境变量（或 provider 默认变量）；插件声明的敏感字段只接受 `env:NAME` 引用。配置编辑器不会把环境变量值展开后保存。MCP 的 `env`/`headers` 仍是 MCP 独立配置内容，请不要将密钥写进共享的项目文件。本实现未增加 XDG、`AGENT_HOME`、`--config` 或 `--cwd` 开关。

## TUI 命令

`/help` `/model`（不带参数弹出选择器）`/mode`（同上）`/think off|low|medium|high`（思考等级）`/permissions` `/skills` `/tools` `/exit`。

默认使用全屏视口：消息区可以独立滚动，底部保留输入框与状态。思考内容和长工具输出默认收起，`/details` 展开或收起，`/stats` 查看 token、缓存命中率与日志路径。运行中发送的消息会排队，`/queue` 查看数量，`/queue clear` 清空。Esc 中断当前轮并清空排队；审批弹层中 Esc 只拒绝当前操作，Ctrl+C 中断整轮并关闭审批；空闲时 Ctrl+C 退出。

如果希望沿用终端原生滚动历史，可使用 `AGENTLAB_SCREEN=main pnpm dev`。画面残留时可输入 `/redraw`，或用 `AGENTLAB_FULL_REDRAW=1 pnpm dev` 启用全量重绘。

思考等级的映射：Anthropic → `thinking.budget_tokens`（low 2048 / medium 8192 / high 32768，`max_tokens` 自动抬到 budget 之上）；OpenAI 系 → `reasoning_effort`。启动默认值可用全局或项目配置的 `thinking` 字段。

## MCP

默认读取 `~/.agent/mcp.json`。若使用项目 MCP，在项目配置中写 `"mcpConfig": "./mcp.json"`，并在项目根目录创建 `mcp.json`（参考 [examples/mcp-server.ts](examples/mcp-server.ts)）：

```json
{
  "mcpServers": {
    "demo": { "command": "npx", "args": ["tsx", "examples/mcp-server.ts"] }
  }
}
```

MCP stdio 子进程工作目录为实际 MCP 配置文件所在目录；相对脚本参数按该目录解释，不受启动目录影响。启动后 `/tools` 可见 `mcp__demo__add` 等工具。

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

`reason` 区分正常结束、轮数上限、输出截断、中断和错误；正常结束不等于任务评测通过。每个会话的 `~/.agent/state/projects/<项目 ID>/logs/*.jsonl` 默认记录请求元数据和用量，`model_request` / `model_usage` 用 `requestId` 关联，`purpose` 区分主模型（`agent`）、压缩（`compact`）与审批（`judge`）。累计用量包含辅助调用，便于比较运行成本。仅显式启用 `pluginConfig["agentlab.telemetry-jsonl"].includeBodies` 才记录对话正文和工具参数。

## 开发

```bash
pnpm dev          # tsx 直接跑 TUI
pnpm test         # vitest（含 FakeProvider 全链路、内存终端交互与真实 MCP 桥接）
pnpm typecheck
pnpm build        # tsup → dist/
```
