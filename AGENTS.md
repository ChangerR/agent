# AgentLab

仿 Claude Code 的**插件式 coding agent 教学实现**，TypeScript + Node.js（ESM）。
目标是把"一个 agent 内部怎么运转"讲清楚：事件驱动的 loop、规范化的模型协议层、
权限决策管线、MCP / skill 的挂载方式。架构逐模块讲解见 `docs/ARCHITECTURE.md`。

## 最核心的约定

- **一切皆为插件。** core 不认识任何具体厂商、工具或 skill —— 所有能力都通过
  `Plugin.register(ctx)` 挂到注册表上（内置的 6 个工具和外部插件走同一条路）。
  不要在 `src/core/` 里 import 具体 provider 或工具。
- **Provider 只做翻译，不做决策。** 厂商差异全部收敛在 `src/providers/`，
  对外只吐出规范化的 `StreamEvent`（`src/core/protocol/types.ts`）。
- **core 不碰 UI。** loop 的所有对外沟通走 `EventBus`，TUI 只是事件订阅者；
  Web 前端只需重写 `src/cli/` 这一层。
- 新能力想清楚挂在哪：provider / 工具 / MCP / skill / 钩子，都是插件点。

## 常用命令

```bash
pnpm dev        # tsx 直接跑 TUI（需 .env 里的 ANTHROPIC_API_KEY）
pnpm test       # vitest run
pnpm typecheck  # tsc --noEmit
pnpm build      # tsup → dist/
```

改完代码至少跑一遍 `pnpm typecheck` 和 `pnpm test`，再声称完成。

## 目录

- `src/core/` — loop、插件与注册表、协议层、权限引擎（`permission/`）、上下文（`context/`）、钩子
- `src/providers/` — anthropic / openai / fake 三个 provider；`fake.ts` 是脚本化假 provider
- `src/tools/` — read_file / write_file / edit_file / bash / glob / grep
- `src/mcp/`、`src/skills/` — MCP 桥接、skill 渐进式披露
- `src/cli/` — pi-tui 终端界面
- `tests/` — vitest，`tests/loop.test.ts` 是理解 loop 行为的入口
- `plugins/example/` — 外部插件示例；`examples/` — MCP server、离线 demo

## 代码约定

- **ESM：相对 import 一律带 `.js` 后缀**（TS 源文件里也写 `.js`，如 `from './loop.js'`）。
- TS `strict`，项目 `type: module`。
- 注释和文档用中文。
- 一个 Tool = 给模型看的 `inputSchema` + 给权限引擎看的元数据（`risk` /
  `analyzeInput` / `isConcurrencySafe`）+ `execute`。三者分离，别把它们揉在一起。
- 测试用 `FakeProvider` 脚本化断言 loop 行为，**不要打真实网络**；MCP 测试可真实拉起
  `examples/mcp-server.ts`。

## 改动时的注意点

- 权限判定走 `src/core/permission/engine.ts` 的管线：deny 规则与危险命令检测优先级最高，
  yolo 也不能逾越；新增放行路径要挂进这条管线，不要绕开它。
- 模型规格（`contextWindow` / `maxOutputTokens`）声明在 `models.json` + 内置 `MODEL_PRESETS`，
  `loop.setModel()` 时联动压缩阈值和 `maxTokens`。
- `agent.config.json` / `mcp.json` / `.env` 在 `.gitignore` 里（是本机配置），
  改配置示例请改对应的 `*.example.*`。
