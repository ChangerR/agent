# agentlab

以项目为入口的本地 Agent 工作台。现有 Electron/React 框架已补充 macOS 代码适配；macOS 原生验收仍需独立 Mac。前端使用 React，Electron 提供窗口与目录选择，独立 Node 进程装配现有 createAgent()；core 和原有 CLI 保持解耦。

## 运行

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
pnpm desktop:preview   # 浏览器中的隔离离线工作台，监听 127.0.0.1:4175
```

浏览器预览使用两个新建的临时项目、隔离 HOME 和固定假凭据，只允许 FakeProvider，可验证项目切换与会话恢复。真实项目的原生目录选择由 Electron 提供。预览前先运行 desktop:build。macOS 原生菜单、AppKit、Retina 与 .app 启动仍需独立 Mac 验收。

## 使用自己的 agent

1. 从“所有项目”添加本地文件夹，或点击已添加的项目进入工作区。
2. 继续沿用该项目的 agent.config.json、项目 .env、全局配置、MCP 与 skills；应用不会覆盖整份配置。
3. 发送任务，等待流式回复和工具结果；出现审批时查看完整参数，再选择仅本次允许或拒绝。
4. 在右侧刷新文件列表、打开文件，或检查 Git 差异。
5. 侧栏在项目下列出会话，提供新建会话和本项目设置入口。切回项目自动恢复上次保存的会话；点击当前项目保留正在使用的会话。
6. 设置页与输入区可切模型 ID、权限模式和思考等级，成功保存项目配置后应用。模型文本 Enter 提交，Esc 放弃。
7. 输入 `/stats` 可直接查看当前会话累计 token、缓存读写与命中率，无需模型请求或自动规划；无输入用量时显示暂无数据。

只加载规范化项目根 .env，进程变量优先。provider、model、baseURL、apiKeyEnv 配置方式见根 README；apiKeyEnv 填变量名。更改 provider、端点、key、审批规则或插件实现后，请关闭并重新启动应用。密钥不会传给 renderer。

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

## 进程与协议

- main：窗口、白名单 IPC、目录选择、项目目录与最近会话、Node 进程生命周期。
- preload：仅暴露固定 DesktopBridge；不暴露原始 IPC、任意磁盘或 shell。
- worker：createAgent 装配、命令、会话、审批 resolver 和展示快照。
- renderer：React 展示，不接收凭据、模型请求正文或插件实现。

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

设置默认编辑项目层，可切换用户层，显示实际文件路径与当前会话值。覆盖开关区分继承与显式值，
每节提交一次；清除只改变草稿，未提交导航或关闭时提示放弃。连接和插件默认值需重启，
App 重新装配并新建会话也会重建 runtime；CLI 需重启。当前会话来源、已有审批和真实工具权限继续沿用后端语义。外观可立即跟随系统暗色。

macOS 源码构建须在 macOS 对应架构运行 pnpm desktop:build / desktop:smoke / desktop:package。
--validate 仅验证输入；随包 Node / 原生模块必须与目标平台和架构一致。没有签名、公证或发布流程。
开发 build/run 不要求 Node LICENSE；正式分发 package 才验证同版本完整许可证，必要时使用 AGENTLAB_NODE_LICENSE 显式提供。
Linux 浏览器预览和平台注入测试不等于原生 macOS 通过。

设置交互区分：外观以及“当前会话”的模型 / 权限模式 / 思考选择即保存，继续调用原后端命令；模型与思考在下一请求采用，模式不处理已有审批。连接组合、缓存费用选项、权限规则和其他结构化启动默认值显式提交并重启；其草稿放弃提醒不等于额外的工具授权。验收工具统一为 Node / Playwright。
