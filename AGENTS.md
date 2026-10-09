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
pnpm dev        # Node + tsx loader 跑 TUI（按 provider 配 key；fake 可离线运行）
pnpm test       # vitest run
pnpm typecheck  # tsc --noEmit
pnpm build      # tsup → dist/
```

改完代码至少跑一遍 `pnpm typecheck` 和 `pnpm test`，再声称完成。

## 本机模型配置

- 使用 Node.js 22.19.0+（当前 TUI 依赖的最低要求）。先复制 `.env.example` 为 `.env`、`agent.config.example.json` 为
  `agent.config.json`；已有配置只做必要字段修改，不覆盖整份文件。配套步骤见 README 的“快速开始”。
- `.env` 只保存 key 等环境变量。`provider`、`model`、`baseURL`、`apiKeyEnv` 写在 JSON；
  `apiKeyEnv` 是变量名，不是 key。默认 Anthropic 读 `ANTHROPIC_API_KEY`，OpenAI 兼容
  适配器读 `OPENAI_API_KEY`。DeepSeek 可使用 `provider: "openai"`、
  `baseURL: "https://api.deepseek.com"`、`apiKeyEnv: "DEEPSEEK_API_KEY"`，
  搭配 `.env` 的 `DEEPSEEK_API_KEY`。模型 ID 按对应官方文档/账户确认，不从“Flash”等简称猜测。
- JSON 字段优先级：内置默认 < `~/.agent/config.json` < 项目 `agent.config.json` < SDK 会话覆盖。
  字段逐项继承；切换 provider 要同时核对 model、baseURL、apiKeyEnv，避免继承另一厂商的设置。
- runtime 装配 provider 前，只加载规范化项目根 `.env`；不加载子目录 `.env`、`.env.local` 或
  `~/.agent/.env`。已有进程变量优先，空字符串也会覆盖文件值。显式 JSON baseURL 优先于
  对应 provider 的 `*_BASE_URL` 环境变量。纯 `loadConfigWithSources()` 不加载 `.env`。
- `.env` 缺省正常；其他读取错误应明确报告路径/安全错误码，不吞掉，也不输出原始内容或 key。
  修改环境变量或 provider/key/端点配置后必须退出进程重新启动；`/model` 只改当前会话模型。
- 权限默认草稿的 Save 区分“仅保存启动默认”与“保存并应用模式”。后者必须再次精确确认，
  只应用本项目/全局合并后的有效 mode；规则、审批模型和插件实现仍需重启。不要把全局草稿值
  直接当作本项目有效模式，也不要在保存失败时先改当前会话。
- 回归使用隔离 HOME、临时项目、固定假 key 和 mock SDK；绝不探测用户真实 key 或发送真实模型请求。
  `.env` 加载回归见 `tests/environment.test.ts`，启动和端点身份回归见对应测试文件。

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
