# agentlab

以项目为入口的本地 Agent 工作台。现有 Electron/React 框架已补充 macOS 代码适配；macOS 原生验收仍需独立 Mac。前端使用 React，Electron 提供窗口与目录选择，独立 Node 进程装配现有 createAgent()；core 和原有 CLI 保持解耦。

## 运行

SSH 远程项目现已支持首轮实现：本地显示消息并代理模型 API，远程执行 AgentLoop、工具与审批管线。离线服务包构建、使用步骤、测试范围与当前限制见 [SSH 远程工作区](../docs/SSH-REMOTE.md)。

构建 Windows 应用后可在项目根目录双击 **启动 agentlab.cmd** 打开已打包的桌面应用。脚本按自身位置定位程序，无需切换目录；应用已打开时会聚焦原窗口。

当前打包命名对应的 Windows 应用目录为 `desktop/release/agentlab-win32-x64/`，双击其中的 **agentlab.exe**。请完整保留同目录文件；应用已包含 Node 运行时，无需另装 Node 来启动它。本次云端交付为源码和验证证据，没有发布新的安装包。

从源码启动：

```powershell
pnpm install
# pnpm 未执行 Electron 的安装脚本时，先下载官方运行时：
node node_modules/electron/install.js
pnpm desktop
```

源码启动要求 Node.js 22.19.0+。`node desktop/scripts/run.mjs` 和普通 `desktop:build` 使用开发暂存；当前 Node 安装没有 LICENSE 也可开发启动，不需要重装 Node、设置环境变量或联网下载。

`desktop:package`（包括 `--validate`）另走分发构建，必须附同版本完整 Node LICENSE。自动发现限定在真实 Node 安装目录及其 `share/doc/node`、`share/doc/nodejs`、Homebrew `share/doc/node@主版本` 下，支持版本管理器及符号链接，不搜索其他 Node 安装。仓库 assets/node-LICENSE.txt 只对应 v22.23.2。找不到时会给出当前版本的官方文件链接和显式路径指引；不会自动下载、把旧版本许可套给新版或把无许可开发产物当成可分发包。

```powershell
pnpm desktop:build     # 构建 React、Electron 与独立 agent 进程
pnpm desktop:smoke     # 验证构建产物的原生模块、真实审批写入与保存
pnpm desktop:package   # 生成当前机器平台与架构的应用目录
pnpm desktop:package --validate # 仅校验打包输入，不生成应用包
pnpm desktop:web       # 免构建的 Web 开发模式，监听 127.0.0.1:4175
pnpm desktop:web -- --real # 使用当前项目和真实后端能力
pnpm desktop:preview   # 使用 desktop/dist 的静态浏览器预览
```

日常调整 React/CSS 推荐直接运行 `pnpm desktop:web`，浏览器打开 http://127.0.0.1:4175。该模式不需要先运行 `desktop:build`：worker 从源码打包到 `desktop/.web` 并使用当前 Node 与根依赖，renderer 通过 Vite 提供热更新，HMR 与页面共用同一端口；可用 `AGENTLAB_PREVIEW_PORT` 修改端口。worker 或 Electron 主进程改动仍需重启命令。

需要调试真实能力时运行 `pnpm desktop:web -- --real`。该模式启动当前项目及真实 HOME 中的全局配置，恢复已有会话，并保留工具、权限、MCP、模型连接和调试记录；只监听本机回环地址。模型请求只在你提交任务后产生，设置修改会写入对应的真实配置，请按需使用。

默认浏览器预览使用两个新建的临时项目、隔离 HOME 和固定假凭据，只允许 FakeProvider，可验证项目切换与会话恢复。真实项目的原生目录选择由 Electron 提供。只有 `desktop:preview` 需要先运行 `desktop:build`。macOS 原生菜单、AppKit、Retina 与 .app 启动仍需独立 Mac 验收。

## 使用自己的 agent

### 简单配置模型

打开 App 的“设置 → 模型配置”，默认显示简单配置，无需先建服务连接或模型目录：

- **DeepSeek 官方**：粘贴官方 API Key，点“保存并设为默认”。地址、协议和默认模型自动填写；“更换模型”里可选其他内置官方模型。
- **Kimi 官方**：粘贴开放平台 API Key，点“保存并设为默认”。默认使用中国站；国际站 Key 在“API Key 来源”选择国际站。Kimi Code 订阅 Key 不是开放平台 Key。
- **自定义服务**：在同一页填写 API 基础地址、协议、模型 ID 和 Key。OpenAI 兼容协议适用于大多数中转服务，也支持 Anthropic Messages。

一次保存会更新全局默认模型和命名连接，Key 仍经系统 safeStorage 加密。切回已配置的服务可留空复用它的 Key；更换端点或协议必须重新输入。保存只写本机配置，不产生模型调用；重新打开项目、重新装配或重启 App 后采用。项目显式配置仍优先于全局，可在作用域菜单选择项目覆盖检查。

旧的环境变量、模型规格和插件配置在“高级设置”及原有分组中保留。简单配置与高级入口共用同一份配置，不增加别名或迁移格式。官方预设按 [DeepSeek 文档](https://api-docs.deepseek.com/quick_start/pricing/)、[Kimi 模型文档](https://platform.kimi.ai/docs/models) 和 [Moonshot 官方端点示例](https://github.com/MoonshotAI/Kimi-Vendor-Verifier/blob/main/verify_params.py) 核对于 2026-10-24。Kimi K3.1 保留多轮推理历史，并使用 `max_completion_tokens`；默认输出预算采用官方默认 131072，为输入留出空间。

开发验收：`node desktop/scripts/model-setup-smoke.mjs`（先运行 `pnpm desktop:build`）。使用独立 HOME、独立 Electron userData 和固定假 Key，覆盖一次保存、厂商切换、自定义服务、重启恢复及窄窗口，不发送模型请求。截图写入忽略目录 `desktop/.validation/model-setup/`。

1. 从“所有项目”添加本地文件夹，或点击已添加的项目进入工作区。
2. 继续沿用该项目的 agent.config.json、项目 .env、全局配置、MCP 与 skills；应用不会覆盖整份配置。
3. 发送任务，等待流式回复和工具结果；出现审批时查看完整参数，再选择仅本次允许或拒绝。
4. 在右侧刷新文件列表、打开文件，或检查 Git 差异。
5. 侧栏在项目下列出会话，提供新建会话和全局设置入口。切回项目自动恢复上次保存的会话；点击当前项目保留正在使用的会话。
6. 输入区可切当前会话的模型 ID、权限模式和思考等级，成功保存项目配置后应用；设置弹窗只编辑全局默认，不重复显示这些会话控件。
7. 输入 `/stats` 可直接查看当前会话累计 token、缓存读写与命中率，无需模型请求或自动规划；无输入用量时显示暂无数据。

设置弹窗固定为全局配置，默认只展示模型、权限、MCP/工具和外观等常用项；Provider 能力、预算、插件装配等收在“高级设置”。无需先打开项目或会话。Provider 连接页可直接输入 API key，由 Electron safeStorage 加密后保存到 ~/.agentlab/credentials.enc.json，配置仅存随机引用；读取只返回已设置状态。Linux basic_text/未解锁后端拒绝保存，不降级为明文。环境变量引用保留为高级方式：只加载项目根 .env，进程变量优先。更改连接/key 后新打开项目、重新装配或重启采用，已有会话不被热替换。详见 [全局设置与安全存储](../docs/CONFIGURATION-SETTINGS.md)。

无需真实凭据时，选择“打开离线演示”。演示在应用自己的专用目录读取 README.md，并在用户批准后创建 demo-note.txt。新会话还提供“表格与代码示例”，可离线查看实际消息的 Markdown 排版。规划在演示中关闭，真实项目继续使用其原有规划配置。

## 已实现

- Windows 原生窗口、文件夹选择、持久化项目列表与项目首页。
- 项目 → 会话的侧栏层级，文件、改动与设置绑定当前项目；切换清空前端文件缓存与输入草稿。
- 项目会话列表、新建与恢复；复用原有会话身份、原子保存和版本冲突语义。
- 流式 Markdown（含 GFM 表格、任务列表与删除线）、折叠思考、工具参数/结果、耗时、执行记录和真实停止。宽表格和长代码在自身区域滚动，保留代码缩进。
- 固定底部人工审批，完整参数、拒绝反馈、一次性批准、取消失效。
- 文件搜索/预览通过 glob、read_file 与唯一 ToolExecutor。
- Git 检查通过 manifest/setup 插件挂载，嵌套的读取仍走相同执行器。
- 项目模型/模式/思考设置复用现有命令提交；权限模式不处理已弹出的审批。
- 黑白灰、深色石墨、冷灰蓝主题，外观偏好与 agent 配置分开。
- 采用接近 Codex App 的紧凑侧栏、项目/会话层级、单列对话与圆角输入框；空会话居中呈现，右侧工作区默认收起，可按需打开。侧栏可独立收起，窄窗口的工作区使用浮层。
- 字体优先使用本机 Segoe UI Variable Text 和 Noto Sans SC，中文回退到 Microsoft YaHei UI；不下载字体。聊天正文为 15px，代码与界面标签分别使用独立字号与等宽字体。
- 已加载工具/插件/命令目录；聊天中的 /命令复用现有命令分发。

首版同一时间只有一个活跃顶层会话。运行中先停止并等待结算，再切换项目、恢复或新建会话；当前会话中的新输入保留为草稿。浏览项目首页不会停止当前任务。普通空闲切换也等待保存和 dispose。界面显示最近 500 条展示记录，完整 agent 历史仍由原有上下文/会话机制管理。

桌面偏好只保存项目目录及上次已保存会话的 ID；会话内容继续由原有 SessionManager 按项目隔离，agent 配置仍写对应项目。新建的空会话不会覆盖项目的上次已保存会话记录。上次会话恢复失败时保留原文件并显示错误。

设置页现可编辑用户 / 项目两层的连接、预算、权限默认、MCP 和插件参数；即时模型 / 模式 / 思考仍在聊天输入区。完整覆盖、迁移与 macOS 验证见 [配置设置](../docs/CONFIGURATION-SETTINGS.md)。需要特定 TUI 渲染器的交互视图尚未移植，终端界面继续可用。

## 检查范围

Git 视图比较 HEAD 和最多 200 个已授权、现存普通文件，包含用户原有改动；忽略/隐藏/受保护/已删除/未跟踪文件不在范围。目录必须已有 Git 提交，并在宿主 PATH 中安装 Git。它使用项目外解析出的 Git 绝对路径、字面路径参数、禁用外部 diff/textconv 与受控 Git 环境。

所有候选文件先通过 glob 枚举，再经 read_file 授权检查；显式 deny/ask 继续生效。文件工具本来就会直接修改磁盘，检查面板没有额外“接受改动”或一键回滚。

应用随包提供 Node，并将其目录加入 agent 子进程 PATH。MCP 配置引用的其他运行时或外部程序仍需自行安装。应用不是操作系统沙箱，不防御恶意宿主程序或全部并发文件替换竞态。

## 会话调试（学习 Agent 的执行过程）

进入项目会话后，点击顶部 **调试**。页面在任务运行中也可打开；返回聊天会保留输入草稿，不停止任务，查看记录不会批准工具。

- 主页面采用 API 日志表格：时间、模型、用途、Provider、HTTP 状态、输入/输出 Token、缓存命中率与耗时。支持日期、Provider、模型、用途、状态和关键词筛选；先筛选整个会话再分页，可按执行顺序排列。
- 点击 **详情** 打开抽屉。**API 请求**展示 SDK 实际发送的方法、地址、脱敏请求头及格式化 JSON 请求体，可复制 JSON。
- **API 响应**展示实际 HTTP 状态、响应头和 SDK 解析后的 SSE JSON 事件；每次 HTTP 重试单独列出。SDK 未暴露的失败重试正文会明确提示，SSE 展示不等同于逐字节 HTTP 报文。
- **Agent 上下文**：系统指令、逐条消息历史、可用工具及 JSON Schema、思考/输出参数与预算估算，便于对照统一协议与实际请求体。
- **模型返回**：服务实际返回的文本、可见思考、工具参数、结束原因和流事件数；失败、取消、未完整结束及输出上限分别标明。
- **工具与审批**：从工具提议到参数校验、影响分析、策略判定、模型/人工审批、执行和结果回填。先显示阶段说明与结论，ID、版本等技术字段按需展开。
- **规范化数据**：带缩进的脱敏事件，便于对照代码。下方完整时间线还可查看用户提交、计划变化、保存与压缩事件。
- 任务结算后可 **导出 Markdown 报告**，包含所有已记录请求和完整时间线，不受当前分页限制。

桌面通过 SDK manifest/setup 注册 `agentlab.desktop-debug` telemetry 插件，复用 EventBus；core 提供通用 `model_response`、`model_transport` 事件。Provider 在实际 SDK fetch 边界观测传输，以 AsyncLocalStorage 隔离并发调用，不修改全局 fetch、不增加请求。响应按 requestId 关联，工具使用 toolUseId/toolCallId 关联，子 Agent 保留身份，审批模型关联触发它的工具请求。页面不猜测服务未返回的隐藏思考；FakeProvider、旧日志和未接入观测的插件明确显示没有 HTTP 数据。

脱敏记录按项目/会话保存到 `~/.agentlab/state/projects/<projectId>/debug/<sessionId>.jsonl`，重开会话可继续查看。旧会话缺失的过程不会从聊天历史补造；恢复后未结束的旧请求标成中断。文件损坏、权限或空间错误只暂停调试记录，并在页面提示，不改变 Agent 执行结果。

记录和报告保留用于学习的会话正文与文件内容；API Key、常见认证字段、环境变量及 URL 凭据会脱敏。请求/响应头仅保留明确允许的内容类型、请求 ID 等字段值，其余值隐藏；自由文本不能保证识别所有秘密，分享报告前应检查。单次规范化响应调试副本最多保留 100 万字符，SDK 响应副本最多 200 万字符或 2 万个事件，单个持久化事件文本预算 150 万字符；超过限制会明确标记省略。执行用的原内容不受影响。普通 JSONL telemetry 默认仍只写元数据。

离线验收：先 `pnpm desktop:build`，再 `node desktop/scripts/session-debug-smoke.mjs`。使用独立 HOME、独立 Electron userData 和 FakeProvider，检查真实审批、表格筛选、请求详情、报告下载、重启恢复以及窄窗/125%缩放。`tests/api-transport.test.ts` 以实际 SDK 和内存 fetch 验证序列化、SSE、重试、并发和错误，不请求外部服务。该测试可通过 `AGENTLAB_DEBUG_FIXTURE` 输出隔离样本日志，传给 smoke 脚本的第一个参数可追加 API 表格与详情验收。证据位于忽略目录 `desktop/.validation/session-debug/`。

## 进程与协议

- main：窗口、白名单 IPC、目录选择、项目目录与最近会话、Node 进程生命周期。
- preload：仅暴露固定 DesktopBridge；不暴露原始 IPC、任意磁盘或 shell。
- worker：createAgent 装配、命令、会话、审批 resolver 和展示快照。
- renderer：React 展示，仅接收脱敏调试副本，不接收凭据或插件实现。

审批使用专用 permission_request responder，resolve 与 AbortSignal 留在 worker。请求绑定 generation + sessionId，审批 ID 一次性消费。取消、关闭或旧会话的迟到响应不能执行工具。

worker 发送带单调 seq 的完整展示快照；main 包装为单调 revision 的全窗口状态。前端先订阅再读取快照，并丢弃旧 revision，因此无需重放增量。仅文本/思考约 50ms 合并，其余边界立即刷新。run 的 Promise 和保存结算完成后才回到空闲。

正常关闭先停止、等待并 dispose；保存或清理失败时保留窗口并显示错误。进程中断不自动重试工具。多个应用实例使用 Electron 单实例锁，避免重复写最近项目。

规划格式无效时只纠正一次，纠正请求包含前次回复和明确的格式要求。仍无效、返回不完整或达到输出上限时保留会话并展示具体原因，不开始工具执行；脱敏日志只记录固定规划原因码，不记录模型正文或原始 SDK 错误。

## 验证

本轮增加了真实 Electron 图形设置验收：启动实际 run.mjs、点击表单，经 preload / worker 保存，关闭重启后采用模型/Provider/MCP，并验证敏感值、作用域、审批与会话。所有请求仅使用隔离 FakeProvider；完整字段矩阵、截图、命令及结果见 [配置设置](../docs/CONFIGURATION-SETTINGS.md) 和 [本轮证据](../docs/evidence/graphical-settings)。旧 Windows/浏览器记录在 [历史验证](VALIDATION.md)，不能冒充本轮结果或 Mac 实机通过。

## macOS 与分层设置

菜单 agentlab → 设置（Cmd+,），文件 → 打开项目（Cmd+O）、新建会话（Cmd+N）。
原生窗口保留系统交通灯，标题栏空白可拖动；编辑 / 显示菜单提供系统快捷键与缩放。
关闭窗口先结算 worker，Dock 可重新打开窗口，Cmd+Q 退出应用。

设置默认编辑全局层，项目覆盖是显式高级选择，显示实际文件路径、继承来源与当前会话值。覆盖开关区分继承与显式值，
每节提交一次；清除只改变草稿，未提交导航或关闭时提示放弃。连接和插件默认值需重启，
App 重新装配并新建会话也会重建 runtime；CLI 需重启。当前会话来源、已有审批和真实工具权限继续沿用后端语义。外观可立即跟随系统暗色。

macOS 源码构建须在 macOS 对应架构运行 pnpm desktop:build / desktop:smoke / desktop:package。
--validate 仅验证输入；随包 Node / 原生模块必须与目标平台和架构一致。没有签名、公证或发布流程。
开发 build/run 不要求 Node LICENSE；正式分发 package 才验证同版本完整许可证，必要时使用 AGENTLAB_NODE_LICENSE 显式提供。
Linux 浏览器预览和平台注入测试不等于原生 macOS 通过。

设置交互区分：外观以及“当前会话”的模型 / 权限模式 / 思考选择即保存，继续调用原后端命令；模型与思考在下一请求采用，模式不处理已有审批。连接组合、缓存费用选项、权限规则和其他结构化启动默认值显式提交并重启；其草稿放弃提醒不等于额外的工具授权。验收工具统一为 Node / Playwright。
