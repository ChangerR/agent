# Windows 桌面首版交付验证

日期：2026-10-18。平台：Windows x64；构建 Node v22.23.2、Electron v44.8.0。

## 会话规划失败修复验证（2026-10-18 22:00）

- 格式纠正请求包含前次无效回复与运行时格式要求，历史与来源不变；空回复有明确占位，不向 provider 发送空文本块。仅一次格式纠正，网络失败、截断、取消不自动重试。
- 规划无效、不完整与输出截断使用固定原因码；桌面保留具体提示。真实 runtime 的观察快照与脱敏 JSONL 已验证原因码可到达日志，原始模型正文、SDK message 与未知 code 不进入脱敏输出。
- `/stats` 由会话命令插件直接读取累计 token 与缓存命中率，不调用模型或等待 TUI 交互；零用量、命中率分母及失败后同一会话继续均有回归。
- pnpm typecheck 通过；相关 33 项回归通过。全量 pnpm test：1228 通过、44 失败、410 跳过。失败条目与修复前 appearance-tests.log 完全一致；最新日志在本机 desktop/.validation/session-stop-tests.log。
- 完整 desktop:build 在覆盖既有 tree-sitter 原生模块时被 EPERM 阻止；使用正式构建相同参数单独重建 worker，不替换原生模块。源码产物与已打包 resources/app 的 worker 均通过扩展后的 smoke（含 `/stats`）。
- 已更新 desktop/release/AgentLab Desktop-win32-x64/resources/app/worker/index.mjs，并核对 SHA256 与构建产物一致；原 worker 备份在本机 desktop/.validation/worker-before-session-stop.mjs。未关闭正在运行的应用，重启后加载修复；用户配置与会话文件未修改。

## 已完成的检查

- pnpm typecheck：通过，包含根项目与 desktop/tsconfig.json。
- Prettier：桌面源码、脚本、测试和文档通过。
- 桌面新增回归：16/16 通过（10 项宿主/生命周期，2 项 Git 授权边界，1 项跨项目隔离与恢复，3 项 Markdown 渲染）。
- pnpm desktop:package：生成 desktop/release/AgentLab Desktop-win32-x64。
- 直接对打包后的 resources/app 运行 smoke：原生 tree-sitter/grammar 加载、审批前无写入、批准后真实写入、会话保存、过期批准拒绝，均通过。
- Windows exe 已启动，进程窗口标题 AgentLab Desktop，Responding=True；保持首页，没有打开用户真实项目或发送模型请求。
- 浏览器验证同一构建的离线工作台：启动专用项目、发送、真实审批、保存、glob 刷新、read_file 预览成功。
- 项目入口验证：所有项目首页、项目下的会话与设置、切换至第二个独立项目、返回第一个项目自动恢复原会话；文件面板切换时清空缓存，只读取当前项目。
- 排版修复验证：启用 remark-gfm；实际聊天消息输出表格单元格、对齐、任务列表、删除线与引用。长代码保持缩进，横向滚动限于代码块；实测聊天区域 clientWidth 与 scrollWidth 均为 574，代码块分别为 516 与 773。
- 本次渲染修复的 main/preload 与原应用哈希相同，仅更新 renderer 和演示 worker 产物；不终止正在打开的窗口或任务，重启应用后加载新界面。
- 外观调整：252px 紧凑项目侧栏、56px 顶栏、760px 对话阅读区、圆角输入框、统一 SVG 图标；默认收起右侧工作区。实际验证侧栏/工作区切换、空会话居中布局、深浅主题与工具审批拒绝结算。界面没有横向溢出；审批卡片和输入区均在视口内。
- 字体调整：检查本机已安装 Segoe UI Variable Text、Noto Sans SC、Microsoft YaHei UI 与 Cascadia Code；使用本地字体回退栈。正文 15px / 1.75，界面 14px / 1.5，主要标签不小于 12px；标题收回负字距，代码禁用连字。没有安装或分发额外字体。
- 打包目录检查没有 .env、agent.config.json 或 mcp.json。

## 全量回归结果

pnpm test 已执行，完整日志位于本机 desktop/.validation/full-tests.log；外观调整后的结果位于 desktop/.validation/appearance-tests.log（均忽略，不提交）：

- 测试文件：58 通过、16 失败、12 跳过。
- 测试：1220 通过、44 失败、410 跳过。
- 四个桌面测试文件全部通过。其他失败涉及已有 Windows 路径/链接权限、权限断言、CLI 启动和会话存储等回归；本次没有修改 src/core 或其他既有业务实现，也没有把失败测试跳过或放宽。

因此只能确认桌面新增闭环、当前机打包产物和类型检查通过，不能宣称仓库全量测试通过或已完成跨机器验证。

## 验证边界

使用 FakeProvider、隔离 HOME、临时项目和固定假凭据。未读取用户真实 key，未发送真实模型请求。真实模型的端点与凭据由用户在项目配置后主动使用。

交付是完整的可运行 Windows 应用目录。首版不包含安装向导、自动更新、完整 IDE/手动终端，以及尚未移植的 TUI 专有视图；详见 README.md。

## 独立云端 macOS 适配与设置增强（2026-10-22）

本次在 Linux 独立云端复用 #45，纳入 master@cb64528；没有使用用户电脑或真实模型。
以下结果覆盖叠加后的源码，不以原 Windows 记录替代本次验证：

- pnpm typecheck：根工程与 desktop 工程均通过。
- pnpm test --maxWorkers=2 --minWorkers=1：93 文件通过，1720 passed / 2 平台相关 skipped。
- pnpm build、desktop:build：通过；Node v24.19.0，随包 LICENSE 来自同版本官方 Node 源码。
- desktop:smoke：实际随包 Node 加载原生模块，审批前无写入，批准后写入、保存、迟到批准拒绝，/stats 无模型请求。
- desktop:package --validate：Linux/x64 输入校验通过；darwin bundle 声明与平台 / 架构不匹配拒绝另经断言验证。没有签名、公证、发布或外发安装包。
- desktop/scripts/ui-smoke.mjs：真实 Chromium 操作 React 和构建 worker，覆盖设置提交、失败反馈、用户 / 项目隔离、未保存导航拦截、重置草稿、系统暗色和 900px / DPR 2 布局，无页面 JS 错误。
- git diff --check：通过。

截图和结构化结果在 [evidence](../docs/evidence/macos-app-settings/)，完整设置覆盖、并行缓存字段状态及 macOS 原生待验清单在 [配置文档](../docs/CONFIGURATION-SETTINGS.md)。

限制：Linux Chromium UI / CSS 平台注入和 worker 测试不能证明 AppKit、原生菜单 / 目录、Retina 显示器切换、Dock 生命周期或 macOS .app 实际启动通过。macOS 尚无实机验证。

设置交互区分：外观以及“当前会话”的模型 / 权限模式 / 思考选择即保存，继续调用原后端命令；模型与思考在下一请求采用，模式不处理已有审批。连接组合、缓存费用选项、权限规则和其他结构化启动默认值显式提交并重启；其草稿放弃提醒不等于额外的工具授权。验收工具统一为 Node / Playwright。

### Review 与 Node 验收修正

三项 P2 已补回归：清除空对象后删除覆盖以恢复继承；重选当前节不丢失 dirty 状态；连续相同校验失败使用独立反馈 revision 保持提示。当前会话模型 / 模式 / 思考提供选择即保存入口，结构化默认值继续显式提交。新增验收脚本已替换为 Node / Playwright，仓库不再使用新增 Python UI 脚本。完整回归 93 文件，1722 passed / 2 skipped；Node UI 冒烟与 sidecar smoke 通过。
