# agentlab 设计提案

状态：首版已实现，运行与验证说明见 [desktop/README.md](../desktop/README.md)。下文保留产品设计与后续路线；配套 [交互原型](design/desktop-prototype.html) 仍使用固定演示数据。2026-10-18。

## 当前实现与设计的差异

正式界面在 desktop/renderer，Electron main/preload 通过白名单桥连接独立 Node 进程。打包时携带当前已验证的 Node 和原生依赖，避免改变现有 CLI 的 tree-sitter ABI。首版使用完整展示快照和单调 revision；任务期间保留草稿，停止结算后再切换项目/会话。Git 检查只包含最多 200 个现存、已授权普通文件，明确排除未跟踪/已删除等未覆盖范围。完整编辑器、手动终端、安装向导和更新仍在后续路线。

项目是第一层入口：首页列出所有已添加项目；侧栏按“项目 → 会话”组织，新建会话与设置位于对应项目下。切回项目恢复上次已保存的会话，文件面板清空后按当前项目重新读取。目录与会话 ID 存在桌面偏好中，会话正文仍由现有 SessionManager 管理。浏览项目首页不会停止当前任务。

正式界面随后采用接近 Codex App 的轻量桌面布局：紧凑项目侧栏、单行面包屑顶栏、居中的新会话输入区与更宽的消息阅读区。右侧检查栏默认收起，侧栏可独立收放；图标使用统一 SVG，主题继续保持中性黑白灰与深色石墨。

## 产品定位与首版范围

面向 Windows 的本地 coding agent 聊天工作台：选择项目 → 描述任务 → 观察执行 → 处理审批 → 检查改动。桌面与 TUI 共用 agentlab runtime、配置、插件和会话存储。

首版包含项目入口、单会话聊天、工具过程、人工审批、文件预览、Git 差异与项目设置。完整代码编辑器、交互式终端、内置浏览器、自动更新、云同步与并行顶层会话留到后续。

参考 Kimi Code Desktop 的本地项目、对话和结果检查工作流；界面与能力按 agentlab 现有契约设计。[Kimi 官方快速开始](https://www.kimi.com/help/kimi-code/desktop-getting-started)。

## 界面与视觉

- 左侧约 236px：所有项目入口、添加本地项目、项目树；活跃项目展开其会话、新建会话和项目设置。底部是外观与演示入口。规范化项目根决定会话身份。
- 中间自适应：会话标题、任务阶段、聊天记录、固定输入区。工具卡默认折叠，显示工具名、摘要、状态和耗时；思考仅展示 provider 实际提供的可展示内容。
- 右侧约 360–440px：改动、文件、执行记录；可以收起。点击文件路径打开预览。执行记录展示命令与输出，首版没有终端输入。
- 输入区：项目上下文、模型、权限模式与思考等级；Enter 发送、Shift+Enter 换行。运行时显示停止；后续输入明确排队，取消排队与停止当前任务分开。
- 设置默认作用于项目，全局入口明确范围、覆盖来源和生效方式。

视觉建议：默认黑白灰浅色主题，白色内容面、中性灰侧栏、石墨文字与主按钮；去除暖黄底色和橄榄绿强调色。原型顶部可比较“黑白灰 / 深色石墨 / 冷灰蓝”，切换覆盖背景、边线、控件和差异区域，不保存本机设置。代码差异保留新增/删除语义颜色。正文 Windows 系统字体 14px，辅助信息 12px，代码 Cascadia Code / Consolas。保留原生窗口按钮、缩放与系统菜单。默认窗口约 1440 × 900，最小宽度建议 1024px。

## 关键交互

### 打开项目与连接模型

原生选目录 → 后端规范化项目根 → 读取配置与装配 runtime → 返回能力和配置来源。项目列表是桌面外壳偏好，不改变 agent 配置格式。

把 provider、model、baseURL、apiKeyEnv 作为连接身份整体展示。apiKeyEnv 明确为变量名。首版不新增凭证保险库，key 继续通过进程环境或项目 .env 提供；renderer 不接收 key、环境变量或 .env 正文。缺凭证时提示配置步骤，不自动发送探测请求。错误只展示路径、安全错误码和可采取动作。

### 任务、停止与会话切换

状态：就绪 → 生成回复 / 执行工具 / 模型审批 / 等待人工 → 结算保存 → 就绪。中断先显示“正在停止”，等底层和保存真正结算后显示终态。

worker 管理 FIFO，等 loop.run() Promise 完全结束才发下一条；不能在 loop_end 回调重入。model_usage 按 requestId 去重、按 agent / compact / judge 区分，不能再叠加 turn_end.usage。失败或取消仅统计 provider 已报告用量。

首版只有一个活跃顶层会话 runtime。任务中切项目或会话，提供“留在当前会话”与“停止后切换”；用户选择后先停止、结算保存、dispose，再装配或恢复。空闲切换同样等待保存与释放。

### 人工审批

审批在聊天底部专用区域，展示项目、所属任务、后端摘要、实际解释器、完整参数、目标和原因。详情可滚动。

首版只有“仅允许本次”和“拒绝”，拒绝可附反馈。记住规则后续由后端计算可用性与 scope，不复制 TUI 私有条件。模式切换不能处理已有审批；后台更新不能覆盖等待状态。并行请求排队。取消或会话变化使请求失效，迟到点击不得执行。

### 改动与文件检查

区分“本轮工具写入前后”与“Git 工作区差异”。现有 tool_result 不保证携带原内容，不能声称已有完整修改快照。

首版先提供只读 Git 工作区差异，明确包含用户原有修改，不能归因于 agent。非 Git 项目提供受限文件预览，无基线时不伪造差异。后续通过插件钩子采集工具触及文件的前后快照，注明范围与截断；任意 shell / MCP 副作用不能保证全捕获。

Git 检查新增为注册的只读能力，经 agent.invokeTool() 和唯一 ToolExecutor；禁用 external diff、textconv 与不必要的可执行配置。文件预览、搜索通过现有或新增注册工具，不直接访问磁盘。检查触发审批时仍遵守原流程。

首版不设“接受改动”：文件已被工具修改。也不设一键回滚，以免覆盖用户原有或期间产生的修改。

### 设置与恢复

模型、模式、思考等级复用项目原子写/CAS，选中即保存，成功才应用。文本/JSON 一次提交，Esc 未提交不写；不设统一 Save 页面。

同 provider 切模型立即生效；运行中设置变更在任务安全边界串行应用。provider、端点、key 环境变量与插件实现变更明确提示重启。若凭证来自父进程环境，必须退出重启整个应用，仅重建 runtime 不会刷新继承环境。

恢复通过 SessionManager 校验项目、provider/endpoint 与 schema，不通过时保留原内存。冲突先保留内存快照，再选择恢复磁盘版本，不盲目覆盖或提高权限。CLI/桌面顺序使用可共享会话；同时编辑同一会话由 revision/锁报告冲突，首版不做实时同步。

## 技术架构

建议 Electron + React + TypeScript + Vite。现有后端为 Node.js ESM，依赖 tree-sitter 原生模块、stdio MCP 和子进程工具，这个方案优先复用现有运行与调试链路。Tauri 仍需分发 Node sidecar 和维护另一套宿主通信，可后续再评估体积收益。

进程结构：

    React renderer（聊天、工具卡、设置、差异）
        ↕ preload 类型化白名单 API
    Electron main（窗口、目录选择、IPC 校验、生命周期）
        ↕ 版本化 DTO / 请求响应 / 事件序列
    Agent worker（随包 Node 子进程，首版一个活跃 runtime）
        ↕ createAgent(projectRoot)
    runtime → 插件宿主 → AgentLoop → 唯一 ToolExecutor

core 保持无 UI。桌面通信是宿主适配层，不将 Electron 放进 core；Git 检查、快照等业务能力继续通过 manifest/setup 注册。

renderer 开启 contextIsolation、禁用 Node integration、启用 sandbox；preload 不暴露原始 ipcRenderer、任意磁盘操作或任意 shell。main 校验窗口/frame、参数 schema、项目/会话归属和生命周期，实际工具授权仍走执行器。Markdown/工具输出按不可信文本渲染；外链校验协议后交系统浏览器。

首版通过随包 Node 子进程和 IPC 消息通信，不要求更换原生模块 ABI；这仍然不是工具执行的 OS 沙箱。窗口隔离继续遵循 [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)。

建议新增 desktop/main、preload、worker、shared、renderer。起步保持根包 CLI 构建不变，desktop 用独立 package/tsconfig/build，先通过私有源码适配接入根项目；发布前统一 runtime 构建产物。不为设计稿提前拆多包。

## 通信与现有 API 对接

以下是新设计 API，尚未实现：

- projects.pick：main 选目录，worker 规范化并装配。
- sessions.list/open/new：适配 agent.session 与现有命令；运行中先结算。
- runs.submit/stop：worker 调用 loop.run / loop.abort_current；invocationId 防止重复提交执行。
- commands.list/execute：复用 commands / dispatchCommand，将 InteractionRequest 转成前端交互 DTO。
- approvals.respond：以 opaque approvalId 一次性处理，后端校验 owner、signal、有效期。
- settings.describe/submit：来源于 agent.settings 和命令目录。现有部分 TUI 设置逻辑需抽取共享语义入口，桌面不 import src/cli/app.ts。
- inspection.read：只经注册工具提供文件预览和 Git 检查。
- events.subscribe / state.snapshot：展示快照与事件流。

协议包含 version、workerGeneration、projectId、sessionId、invocationId/requestId；事件有单调 seq。隔离切换或重启后的旧事件。流式文本可约 40–60ms 合并，在 block/工具/终态边界 flush。缺号时补快照；先订阅缓冲、再取含 lastSeq 的快照、按序去重，避免订阅与快照之间丢事件。

permission_request 有 resolve 与 AbortSignal，不能整体 structured clone。worker 专门通过 events.on('permission_request') 注册 responder，把 resolver 留在 Map，仅发 JSON 摘要与审批 ID；取消发失效事件、清理 Map。onAll 观测不算 responder。

Error、函数、插件实现、完整 config、model_request.request 都不直接转发。模型请求可能含完整对话与工具定义；前端只接收必要模型、目的、用量和诊断元数据。能力目录也需转换为可序列化 DTO。

窗口崩溃/连接断开时停止活跃任务、撤销未决审批并等待结算。正常退出 await agent.dispose()。worker 崩溃显示“运行中断”，从有效持久化快照显式恢复，不自动重试可能已经执行的工具。

## 实施顺序

1. 技术验证：Electron worker 用 FakeProvider 验证读取→审批→写入→取消→dispose；验证 tree-sitter-bash / tree-sitter-powershell 在目标 Electron ABI 下加载，在干净 Windows 机器验证安装包。Node 版本满足根包要求。
2. 最小闭环：选项目、会话、新建/恢复、流式对话、停止、工具卡、仅本次审批。先离线端到端演示，再由用户配置真实模型。
3. 检查与设置：文件预览、只读 Git 差异、模型/模式/思考、配置来源与重启提示。
4. 发布验证：关闭/崩溃、空格与中文路径、安装目录只读、stdio MCP/PowerShell、会话冲突、长输出与窄窗口。安装包不带 .env、本机配置、会话或日志。

原生模块针对 Electron 重建，.node 与资源正确解包到 asar 外并验证路径。开发机能跑不代表安装包可用。utilityProcess 验证失败再考虑随包分发固定 Node runtime，不要求用户手动安装 Node。[Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)。

验收：过期审批不执行；取消贯穿 provider/工具/审批；恢复不放宽权限；保存失败不显示成功；旧事件不串会话；并发保存明确冲突；所有 UI 工具操作经唯一执行器。测试使用临时项目、隔离 HOME、mock SDK，不发送真实模型请求。

## 原型边界

审批、改动/文件/记录切换、项目设置、发送/停止和新建会话均为 UI 模拟。预置差异并非仓库当前改动；设置不写入本机文件；项目切换不读取真实目录。正式接入先完成技术验证。

## 设计阶段验证（历史）

- 根项目 pnpm typecheck 通过；配套 Canvas 独立 TypeScript 检查通过。
- 浏览器实际检查审批、模式选择、文件预览、项目设置、新建会话、发送与停止；原型脚本语法检查通过。
- pnpm test 已执行：38 个文件通过、32 个失败、12 个跳过；971 个测试通过、171 个失败、516 个跳过，另有 2 个错误。输出包含 Windows 沙箱 rename/symlink 的 EPERM，以及路径、权限等断言失败。本次未改业务源码，失败原因没有逐项排查，不能视为全量回归通过。
