# AgentLab

## 插件架构与确定性策略

默认使用 `deterministic` 策略、严格 `model` 审批员和 `ask` 模式。插件使用 `agentlab/sdk`，通过 `pluginEntries` 加载，`capabilities` 明确选择实现。

- [插件 API、配置和生命周期](docs/PLUGINS.md)
- [确定性策略与显式目录写入授权](docs/POLICY.md)
- [严格模型审批与用途统计](docs/REVIEWER.md)
- [外部替换示例](plugins/architecture-example/README.md)

`/settings` 可浏览插件设置与下一会话实现选择。Bash 先由 tree-sitter-bash 解析完整语法树，再逐命令验证参数、目标与副作用；受控的项目内只读组合可在 auto 直接放行，动态或未知语义继续审批。原生 Windows 不做确定性文件授予：auto/yolo 下内置 read_file/glob/grep 的项目内读取交给模型审批（模型返回 ask、超时或失败时回落人工），写入、Shell、ask 模式及敏感/项目外目标仍要求人工确认。插件是受信任进程内代码，不是 OS 沙箱。


仿 Claude Code 的**插件式 coding agent 教学实现**（TypeScript + Node.js）。

核心设计：一切皆为插件 —— provider、工具、MCP、skill 都通过统一的 `Plugin` 接口挂载到 core 的注册表上。详细原理讲解见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 功能

- 事件驱动的 **agent loop**（core 不碰 UI，TUI 只是事件订阅者）
- **规范化协议层** + 两个 provider 参考实现：Anthropic Messages API、OpenAI 兼容 API（DeepSeek/Kimi/通义/vLLM…）
- **工具系统**：read_file / write_file / edit_file / bash / glob / grep，只读工具并行执行
- **权限引擎**：deny → 不可降级约束 → ask → 已验证精确授权 → 模式默认值的决策管线；ask/auto/yolo 三模式；"始终允许"会话规则；审计日志
- **钩子**：PreToolUse / PostToolUse / UserPromptSubmit / TurnEnd
- **MCP**：stdio + streamable-http，工具以 `mcp__server__tool` 桥接
- **Skill**：渐进式披露（清单进 system prompt，全文按需 `use_skill` 加载）
- **上下文压缩**：超阈值自动摘要老消息
- **[pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) TUI**：消息区独立滚动、固定输入框、Markdown 流式输出、工具结果合并与折叠、权限确认弹层、slash 命令补全、阶段与耗时提示

## 快速开始

需要 Node.js 22.19.0 或更新版本（当前 TUI 依赖的最低要求；`.env` 使用 Node 原生加载）和 pnpm。在项目根目录执行：

```bash
pnpm install
cp .env.example .env
cp agent.config.example.json agent.config.json
```

已有这两个文件时直接编辑，不要覆盖。`.env` 放密钥，`agent.config.json` 放 provider、模型和端点；根据实际服务选择下面一种配套配置。示例里的 key 和模型占位符必须替换后才能发送消息。

### Anthropic 官方

在 `.env` 中取消注释并填写：

```dotenv
ANTHROPIC_API_KEY=replace-with-your-anthropic-key
```

在 `agent.config.json` 中设置（与其他需要保留的配置字段合并）：

```json
{
  "provider": "anthropic",
  "model": "替换为该账户可用的完整模型ID",
  "apiKeyEnv": "ANTHROPIC_API_KEY",
  "baseURL": "https://api.anthropic.com",
  "permissionMode": "ask"
}
```

仓库内置默认模型为 `claude-sonnet-4-5`；这只是代码默认值，不保证你的账户仍可使用。若使用代理或兼容服务，端点、key 和模型 ID 必须属于同一服务。

### DeepSeek 官方（OpenAI 兼容接口）

在 `.env` 中取消注释并填写：

```dotenv
DEEPSEEK_API_KEY=replace-with-your-deepseek-key
```

在 `agent.config.json` 中设置：

```json
{
  "provider": "openai",
  "model": "替换为DeepSeek实际支持的完整模型ID",
  "baseURL": "https://api.deepseek.com",
  "apiKeyEnv": "DEEPSEEK_API_KEY",
  "permissionMode": "ask"
}
```

这里的 `openai` 是协议适配器名称，实际请求发送到 `baseURL` 指向的 DeepSeek 官方端点。端点已对照 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/) 核验（2026-10-09）；模型 ID 请从该官方文档或你账户的模型列表确认，不能凭“Flash”等简称推断，也不要照搬其他厂商的模型名。上面的模型字段是明确的待替换占位符。

### OpenAI 或其他 OpenAI 兼容服务

使用 `provider: "openai"`，并填写该服务的完整 `model` 和 `baseURL`。默认 key 变量名是 `OPENAI_API_KEY`；若使用 `.env` 中的 `MY_MODEL_KEY=...`，JSON 里就写 `"apiKeyEnv": "MY_MODEL_KEY"`。`apiKeyEnv` 填变量名，不填密钥本身。OpenAI 官方默认端点为 `https://api.openai.com/v1`；其他服务应显式填写其接入文档要求的地址，不要让兼容服务的 key 误发到默认端点。

### 启动与检查

配置完成后运行 `pnpm dev`。修改 `.env`、provider、baseURL、apiKeyEnv 或启动默认 model 后，退出当前进程再重新运行。只在界面中切换 `/model` 不会重新加载 key 或切换 provider/端点。

排查“填了 key 仍不生效”时按顺序检查：

1. 文件名确实是项目根的 `.env`，不是 `.env.example`、`.env.txt`、`.env.local` 或 `~/.agent/.env`。从项目子目录启动时仍加载规范化项目根的 `.env`，不加载子目录中的同名文件。
2. JSON 的 `apiKeyEnv` 与 `.env` 左侧变量名完全一致。省略 `apiKeyEnv` 时，`anthropic` 默认用 `ANTHROPIC_API_KEY`，`openai` 默认用 `OPENAI_API_KEY`。仅设置 `DEEPSEEK_API_KEY` 而没有对应 `apiKeyEnv` 不会被自动识别；key 也不会自动选择 provider/model。
3. 已有进程环境变量优先于 `.env`，包括空字符串。若 shell 中已 export 同名变量，更新或取消那个变量，再重新启动。项目 JSON 中显式 `baseURL` 优先于对应的 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`；未配置时才使用环境变量或 SDK 默认端点。
4. 全局配置可能仍有其他厂商的 `apiKeyEnv`、`baseURL` 或 `model`。字段逐项继承，改 provider 不会清除其他字段；切换服务时请一起核对这四项，并确认模型 ID 与端点匹配。
5. `.env` 可缺省，允许只用 shell 环境变量；如果存在但不可读取，启动会显示应检查的文件路径和错误码，不回显密钥。不要把 `.env` 内容、完整环境变量或真实 key 粘贴到日志/聊天中。

显式设置 `apiKeyEnv` 后，首次使用该 provider 发请求前会检查变量名和 key：变量名为空/纯空白，或对应变量缺失、为空/纯空白，都会明确报错；不会回退到默认 key。错误只提示配置项和修复步骤，不回显变量名原值或 key。先核对配置中的变量名，再在项目根 `.env` 或 shell 中设置对应的非空值，并重新启动。该检查不会阻止无 key 启动或打开配置菜单，`fake` 也不需要真实 key。

`apiKeyEnv` 和 `baseURL` 只配置 JSON 中 `provider` 对应的内置适配器。审批插件等若实际调用另一个内置 provider，它仍使用自己的默认 key 变量与端点，不会继承主 provider 的自定义 key。显式为 Anthropic 设置 `apiKeyEnv` 时，只发送该 key，不会同时附带默认 `ANTHROPIC_AUTH_TOKEN`；省略 `apiKeyEnv` 时保留 SDK 原有默认认证行为。

配置加载与菜单检查不需要模型请求：`node --import tsx src/cli/index.ts --command /permissions --json` 会查看本机权限配置，不能验证 key 是否有效。要完整试用离线界面，可在独立测试项目中设置 `"provider": "fake", "model": "demo"`，无需填写 key。发送真实模型消息才会调用 API；这不是免费连通性检查。

### 可选：自动审批

`auto` 模式默认使用当前主模型审核未命中规则的写入与执行操作，无需另配审批模型；已完整验证的项目内只读操作直接放行：普通文件读取（含不存在的文件、目录路径，结果由工具自身报错；pnpm `node_modules` 内的硬链接文件；AGENTS.md / CLAUDE.md / agent.config.json / `plugins/` 下的文件）以及内置 grep/glob 项目搜索（含指向项目内的绝对路径 pattern，枚举时跳过无权限目录）。`.env*`、密钥/凭据、mcp.json、`.git` 元数据、已配置插件入口、项目外路径与链接逃逸仍需人工确认。原生 Windows 上上述只读放行改为交给审批模型，并在审批上下文中注明“Windows 平台未做文件系统校验”。搜索排除敏感文件与链接，遵守项目及嵌套 `.gitignore`；明确 ask/deny 规则仍优先。审批失败或不确定时会询问，deny、危险检测与明确的 ask 规则继续优先生效。

可用 `judgeModel` 指定兼容同一 provider / endpoint 的独立审批模型。项目未写该字段时继承全局配置，最终未指定时跟随当前模型；`"judgeModel": ""` 则明确跟随当前模型并覆盖全局指定值。跟随模式会随 `/model` 和恢复会话更新，显式指定的审批模型保持不变。`/permissions` 可查看实际加载的审批模型及来源；需要未命中规则的操作都询问时使用 `ask` 模式。

## 配置目录与作用域

- 全局默认：`~/.agent/config.json`；项目只保留需要覆盖的 `<项目根>/agent.config.json`。首次运行 `pnpm dev` / CLI 会创建用户配置与本项目的 sessions / logs 状态目录；配置只写静态内置默认（默认 ask），不复制项目权限、环境变量或密钥，已有文件原样保留。`--help`、参数错误和 SDK 只读配置加载不创建文件。
- 向上寻找最近的项目边界：`agent.config.json`、`.git`（含 worktree 的文件形式）或 `package.json`。内层项目不会被外层 Git 仓库吞并；不会越过用户目录、系统临时目录或文件系统根来推断项目（直接在这些目录启动除外）；没有标记则使用启动目录。路径会解析符号链接，同一项目从子目录启动仍共用配置和会话，工具执行目录统一为该项目根。
- 用户运行状态：`~/.agent/state/projects/<规范化项目路径的 SHA-256>/sessions/` 和 `logs/`。不同项目即使会话 ID 相同也互不相通；移动项目得到新的身份。启动不会迁移或导入旧目录。
- 优先级：内置默认 → 全局 → 项目 → 程序调用时的会话覆盖。全局与项目权限列表拼接；SDK 显式传入会话 `permissions` 时替换该合并列表。插件参数和能力选择逐字段合并；普通数组替换。省略某层字段表示继承，不能靠保存合并结果把其他层授权复制过来。
- `modelsFile`、`mcpConfig`、`pluginEntries` 的相对路径按声明它们的配置文件目录解析，绝对路径保持。默认模型/MCP 文件为 `~/.agent/models.json`、`~/.agent/mcp.json`。项目使用本地文件时显式配置 `"modelsFile": "./models.json"`、`"mcpConfig": "./mcp.json"`。

`/settings` 默认编辑本项目，界面显示实际配置文件。选择模式后自动保存并立即用于后续权限检查；没有独立 Save 页面或二次确认。也可以直接输入 `/mode auto`，当前模式和项目启动默认一起改变，退出重启后仍保留。已经弹出的工具审批仍需处理，deny、危险检测等执行保护不会因此移除。

- `/model` 和 `/think` 同样自动保存到项目配置，并在下一次模型请求生效。切换模型只改变模型 ID，不切换 provider、端点或 key；模型必须与当前服务兼容。
- 权限规则、审批模型以及插件实现等启动设置，在选择或提交有效输入时自动保存，界面明确提示需要重启；不会假称当前已加载引擎被热替换。
- 文本/JSON 编辑按一次 Enter 提交；Esc 放弃尚未提交的输入。浏览菜单不写文件；选择完成后已经保存的设置不会因为退出菜单而撤销。
- 只有明确进入“全局”才修改全局文件。全局值仍可能被项目值覆盖，界面显示有效模式和覆盖关系；项目模式选择“继承”会删除本层覆盖并应用继承后的模式。不会把合并后的规则或项目授权复制进全局。`writeRoots` 仍仅支持项目层。
- 写入错误或配置被外部修改时明确报错，不显示虚假成功，也不先修改当前模式。修复问题后重新打开设置重做选择。

恢复当前格式的已保存会话可能还原该会话保存的模型、思考等级、模式与会话规则。SDK 的 `agent.paths`、`agent.configSources` 和 `loadConfigWithSources()` 可诊断真实路径和字段来源；配置来源描述启动时读取的快照，设置菜单显示当前保存目标。

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
import { definePlugin } from 'agentlab/sdk';

export default definePlugin({
  manifest: { id: 'example.hello', version: '1.0.0', apiVersion: 1 },
  setup(ctx) {
    ctx.provide.command('hello', {
      description: '显示问候',
      inputSchema: { type: 'object', properties: {} },
      handler() { return { type: 'text', text: 'hello' }; },
    });
  },
});
```

编译为本地 ESM 后，在 `agent.config.json` 中添加 `"pluginEntries": ["./plugins/my-plugin/index.js"]`。完整示例见 [插件文档](docs/PLUGINS.md) 和 [plugins/example/index.ts](plugins/example/index.ts)。

资源清理通过 `ctx.onDispose()` 登记；宿主按逆依赖顺序等待清理，setup 失败也会释放已经登记的资源。

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
pnpm dev          # Node + tsx loader 跑 TUI
pnpm test         # vitest（含 FakeProvider 全链路、内存终端交互与真实 MCP 桥接）
pnpm typecheck
pnpm build        # tsup → dist/
```

真实键盘回归与其他测试统一使用 `pnpm test`，单独定位可用 `pnpm test tests/cli-pty.test.ts`。
Linux 真 PTY 专项需要系统自带或安装 `util-linux`（提供 `script`）；Linux 缺少该工具会明确失败，非 Linux 明确跳过该专项，不代表 macOS/Windows 已通过实机验收。其他 TypeScript 设置、搜索与运行时测试照常执行。

PTY 测试在隔离 HOME/项目中复制仓库原样的 package.json、启动源码及已安装依赖，校验源码哈希，直接执行原定义的 `pnpm dev`，通过键盘验证单选即保存、取消、重启、只读 shell 与 grep/glob、失败及中断后的恢复。模型为本地离线替身，不使用真实 key 或 API。只增加一个共享 Node PTY helper，不引入额外 npm 依赖或终端模拟器；无需 Python 测试脚本。
