# agentlab 图形设置与 macOS 适配

当前工作基于现有 Electron + React + 独立 Node worker App，没有替换框架。原 [#50](https://github.com/ChangerR/agent/pull/50) 已合并；本轮 [#51](https://github.com/ChangerR/agent/pull/51) 纠正全局入口、直接密钥输入、控件布局，并将设置拆为独立整页。验证仅使用独立 Linux 云端、本地 HTTP 假模型和虚构凭据，不连接用户电脑、不发送付费请求、不签名/公证/发布安装包。

## 从哪里进入

侧栏底部的“设置”、项目旁的设置按钮及原生菜单均打开真正设置页。macOS 菜单为 agentlab → 设置（Cmd+,）；其他平台为文件 → 设置（Ctrl+,）。收起侧栏时工具栏仍能进入设置。分类导航支持页面名称和字段名搜索；模型、Provider 和 MCP 服务器采用列表与详情编辑，其余配置按 schema 分组，无 JSON/YAML/文件编辑器兜底。

打开设置会替换整个可见App内容区域。设置有自己的“返回”、分类导航、搜索和作用域控件；原项目/会话侧栏、聊天和工作区工具栏不可见，也不能通过原侧栏toggle重新露出。返回恢复原项目/会话、聊天草稿、滚动和焦点；不重建会话。未保存返回先确认，取消保留设置草稿；重复菜单打开不重置草稿。无项目时同样可独立打开，项目覆盖通过设置自身作用域选择。

当前会话的模型、模式、思考和外观选择即保存。模型/思考于下一请求使用；模式用于后续权限检查，已有审批仍由用户处理。连接组合、缓存费用参数、权限规则、插件入口和凭据等结构化事务显式“保存更改”。外观经白名单 IPC 保存在应用自己的 desktop-preferences.json；保存失败保留原主题并反馈。浏览器预览使用自身 localStorage，CLI 配置不增加 UI 字段。

App 默认编辑 **全局配置**，没有项目或会话时也能维护连接、模型目录、角色、缓存、MCP、权限默认值和插件参数。独立设置 worker 只构建同一个 preset 的 schema/设置服务，不创建 Agent、会话、工具或网络连接。保存到 ~/.agentlab，两个项目默认继承；不会为查看/保存全局设置创建项目配置。项目覆盖必须在“项目覆盖 · 高级”中明确选择，取消覆盖并提交即可恢复全局继承。项目专用 `.env`、写入目录和会话动作仅在该作用域提供。

## 直接输入 API key 与存储边界

在主连接或 Provider 连接页的 **API key** 面板选择已保存连接，直接输入并点击“保存 API key”。可以先在无项目状态新增命名连接，再保存 key 和主任务模型。已有 key 仅返回“已保存”，密码输入在保存成功后清空，替换/清除须用户明确操作；清除共享 key 会影响所有引用它的项目下次装配。凭据与 provider、适配器类型及 endpoint 绑定；主进程与 worker 还会核对运行时实际端点，项目 `.env` 改变端点不能带走旧 key。

实际使用 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)：密文保存在 **~/.agentlab/credentials.enc.json**，普通 config.json 只有 `apiKeyRef` 随机引用。内置 provider 的引用在各自 pluginConfig 命名空间；命名连接在对应条目中。该引用由专用密钥面板管理，不能把明文放进普通配置。安全存储不可用/未解锁、Linux `basic_text` 或未知后端时拒绝保存和解密，不回退明文或其他凭据。配置与密文使用 CAS；配置失败回滚本次密文，回滚冲突明确提示。没有实现自有 Keychain 客户端，也没有 macOS 实测；不声称该平台已经验证。

CLI 保留原有 `.env`/shell + `apiKeyEnv` 高级方式，Node CLI 不依赖 Electron，已有配置和启动仍可使用。**App 保存的密钥引用需要 App 的可信解密宿主**；CLI 首次使用该连接时明确提示，不能自动解密或悄悄使用另一个环境变量 key。要改用 CLI 环境方式，先在 App 清除该连接的保存引用，再显式填写环境变量名。App 自己也支持此高级方式；不创建全局明文 `.env`，不替用户配置真实账户。清除 App key 会恢复原环境变量方式，包括 SDK 默认变量；已有环境变量不会被删除。

保存的新连接、模型、key 在新打开项目、重新装配或重启时采用；当前已建立的 SDK 客户端/会话不会热换 key。恢复旧会话可能保留旧模型，新的启动默认值不会改写旧会话。不同操作的实际生效提示在页内显示。

## 配置与产品更名（破坏性变更）

产品显示名、窗口标题、CLI 帮助、桌面包与可执行文件统一为小写 **agentlab**；根 package 和 CLI 命令原本已是 agentlab。GitHub 仓库仍为 ChangerR/agent，没有 npm 发布或旧命令 alias。

| 实际默认位置                                                                    | 用途                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `~/.agentlab/config.json`                                                       | 用户级静态配置                                     |
| `~/.agentlab/credentials.enc.json`                                              | App 系统安全存储加密的凭据，非明文/普通配置导出    |
| `<项目根>/agent.config.json`                                                    | 项目覆盖，保留既有格式和位置                       |
| `~/.agentlab/models.json`、`mcp.json`                                           | 没有显式覆盖引用时的默认领域文件                   |
| `~/.agentlab/state/projects/<项目路径 SHA-256>/sessions`、`logs`、`mcp-results` | 项目隔离的会话、日志及 MCP 缓存结果                |
| `~/.agentlab/skills`、`<项目根>/.agentlab/skills`                               | 用户/项目技能，项目同名项优先                      |
| `<项目根>/.env`                                                                 | 唯一自动加载的环境文件；既有进程变量优先，包括空值 |

不读取旧 `.agent` 配置/技能，不回退、双读双写、自动迁移或删除旧数据。旧目录仍在敏感路径保护清单中，保护它不等于读取它。项目根配置没有被搬进子目录；项目运行状态仍按当前架构集中在用户目录，不另建第二套存储。桌面操作系统 userData 由新的应用名 agentlab 定位，旧桌面偏好不自动导入。环境变量本来使用 `AGENTLAB_*`，保留此标准大写前缀；厂商的 OPENAI/ANTHROPIC 变量名不变。显式配置的路径仍按其声明层解析。

用户可以在图形表单手动建立新目录中的配置。程序不会替用户读取旧凭据；新默认值依然采用保守的原有权限模式。路径和技能的“不读取旧目录”回归见 `tests/agentlab-identity.test.ts`。

## 字段与控件覆盖

完整字段 → 控件 → 作用域 → 边界 → 生效矩阵由真实装配注册表生成，见 [SETTINGS-FIELD-COVERAGE.md](SETTINGS-FIELD-COVERAGE.md)。`AgentConfigSchema` 新字段自动进入“其他运行配置”；内置以及实际导入的外部插件以 schema / ownedFields 注册表单。外部只有 parse 契约的字段提供明确类型选择及递归键值/数组控件，保存仍调用其原验证器。

| 页面               | 完整字段组                                                                                                                   | 控件/校验                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 主任务与模型连接   | provider、model、baseURL、apiKeyEnv、thinking、judgeModel                                                                    | Provider 下拉、模型候选输入、Endpoint/变量名、枚举；无凭据 HTTP(S) Endpoint、变量名、非空 ID 校验    |
| Provider 连接      | 命名连接 CRUD：type、displayName、enabled；网络连接 baseURL、apiKeyEnv、models；OpenAI dialect                               | 列表/详情、适配器分支、文本/下拉/嵌套模型 map；实际使用已有 OpenAI/Anthropic/Fake 适配器，不探测账户 |
| 模型目录           | 模型 ID CRUD、displayName、contextWindow、maxOutputTokens                                                                    | 列表/详情、正整数输入；显示名不改变路由 ID                                                           |
| Provider 模型能力  | models[ID].api、thinkingLevels、rawToolArguments、prefixCompaction、outputParameter、thinkingMode、offEffort；OpenAI dialect | map 增删/改名、数组增删排序、真实 enum/bool；内置适配器和命名网络连接均可配置                        |
| 上下文与缓存       | maxTurns、compactThreshold；cache.enabled、ttl、staticTtl、ttlStrategy、escalateAfterMs                                      | 数值、下拉、嵌套覆盖；只设置 staticTtl 不回填 enabled/ttl                                            |
| 其他运行配置       | replayToolArguments                                                                                                          | 启用/关闭，默认不主动开启                                                                            |
| 主任务规划         | mode、provider、model、thinking、maxOutputTokens、maxRequestBytes                                                            | 真实角色 schema；另保留已有即时规划方式入口                                                          |
| 摘要模型与预算     | provider、model、thinking、strategy、maxOutputTokens、maxRequestBytes                                                        | 真实 schema，默认 isolated，不主动开启 prefix                                                        |
| 审批模型与预算     | provider、model、thinking、timeoutMs、maxRequestBytes、maxResponseBytes、maxOutputTokens、prefixCache.enabled/ttl            | 分组数值/枚举；不缓存批准结果，不绕过执行器                                                          |
| MCP 服务器         | 服务器名 CRUD；stdio command、args、env；HTTP url、headers                                                                   | 传输分支、程序路径、可排序参数、安全密码输入/键值 map；只允许一种传输，验证 URL/头/变量名            |
| MCP 结果预算       | maxInlineChars、maxAgeDays、maxStoredBytes、deduplicate、maxSearchChars                                                      | 原始上下界；保持活跃结果租约、引用保护与关闭去重默认                                                 |
| 权限与审批默认     | permissionMode、permissions.allow/ask/deny                                                                                   | 模式下拉、工具/精确目标/Glob 规则构建器、增删排序；规则保存不处理已有审批                            |
| 明确写入目录授权   | writeRoots                                                                                                                   | 项目级专用数组与原生目录选择；后端验证真实路径/项目边界，选择目录本身不授予权限                      |
| 插件实现与权限策略 | capabilities 各实际注册单例实现                                                                                              | 按实际候选的枚举；仅允许关闭原契约中的可选实现                                                       |
| 配置文件与插件装配 | modelsFile、mcpConfig、pluginEntries、disabledPlugins                                                                        | 路径、插件模块/启用列表、增删排序；保存入口不导入新模块，重建 runtime 时按原插件契约装配             |
| 本地工具           | disabled                                                                                                                     | 工具名数组；不隐式禁用工具                                                                           |
| 辅助任务与并发     | maxRunning、maxDepth、maxTurns、timeoutMs、maxInbox、maxOutputChars、previewChars、maxAgents、maxRuns                        | 真正数值/literal 与跨字段边界；另保留已有下一任务生效入口                                            |
| 会话日志           | includeBodies                                                                                                                | bool；不自动开启正文日志                                                                             |
| 连接密钥与项目环境 | 项目 `.env` 所有受支持变量                                                                                                   | 键值行、专用密码输入；保留注释/未更改行、变量名/原生 parseEnv 往返校验；0600 保存                    |
| 项目与会话         | 已有项目打开/原生选择；保存、新会话、恢复、删除保存记录                                                                      | 调用原后端操作；内部项目 ID/path/demo、会话内容不是可任意改写的配置参数                              |

命名连接是真正可选的新增配置，放在 `pluginConfig["agentlab.provider-connections"].connections`。未配置时不生成连接或改变旧路由。连接被主任务/辅助角色引用时不能删除/禁用，需先选择其他 Provider 保存。内置 Provider 由插件提供；管理自定义连接并不删除实现代码。顶层 baseURL/apiKeyEnv 仍只作用于内置 openai/anthropic，命名连接使用其详情字段。所有包装委托现有 adapter 的请求规范化、字节预算和模型能力，路由身份隔离。

## 保存、继承、凭据与生命周期

App默认编辑全局层，项目层必须显式选择。显示的是原始层覆盖，并可展开合成有效值；当前会话值单列，不冒充刚保存的启动默认。优先级保持默认 < 用户 < 项目 < 会话；权限规则按原逻辑合并，插件对象/数组按原契约合并。

打开页面、切换作用域、建立草稿、取消均不创建/覆盖配置或回填默认。全局简单字段可恢复默认，项目/复杂字段通过相应的覆盖或恢复继承入口删除本层值；未保存标记、导航/关闭提醒、Esc/放弃和重新读取可用。清除动作只改草稿，显式提交后才写。未知顶层、未知命名空间、已知对象内未知元数据保持；map 改名/数组排序时用宿主生成的条目身份使未知元数据跟随原条目，身份不会写进配置。

模型目录和 MCP 页提交同时激活所选层对应的 modelsFile/mcpConfig 引用。两份文件分别 CAS 校验；引用写入失败时只回滚自己的领域写入，回滚若也遇冲突则明确报告部分保存并要求重新读取，不宣称多文件原子事务。领域文件限制在当前项目或用户配置根，父目录符号链接逃逸被拒绝，renderer 不提供任意写入路径。显式外部引用仍可由 runtime 正常读取，但图形领域编辑需先在路径页选受管位置并重新装配。

模型目录的“清空”删除该文件的自定义模型，回到内置同名规格；MCP 的“清空”删除该文件服务器；引用本身保留。若想恢复另一层引用，到“配置文件与插件装配”取消对应字段覆盖。`.env` 不存在用户级继承文件；清空其草稿并提交会移除已识别变量，保留注释/未识别行。

保存继续执行文件身份、CAS、锁、原子替换、取消及 editor/generation/session/scope 绑定。后端校验错误、外部编辑和写入失败有可见反馈；失败不擅自重试写入。设置忙碌时阻止与任务/审批竞争的提交；真正工具执行仍经过唯一 ToolExecutor、deny/ask、危险检测与人工审批。

既有敏感值只以宿主保管的随机句柄或掩码返回，既有原文不会返回渲染层；用户本次手动输入只暂存于表单，成功保存后换为宿主句柄。MCP args/env/headers/url、`.env` 手动新增/替换使用密码输入；保留/清除是明确动作。日志/错误/截图不包含原密钥。apiKeyEnv 是变量名，插件 sensitiveFields 按既有契约使用 env:NAME 引用；该引用不被发明为 MCP 插值规则。后端不能替任意未声明文本猜测秘密，插件作者仍须准确声明敏感字段。项目 `.env` 和 MCP 参数保持现有 CLI 兼容文本格式，密码控件/0600 文件权限不等于加密；只有上述 Provider API key 专用面板使用系统 safeStorage。

App 的“重新装配并新建会话”实际 dispose worker 并从磁盘重新创建 runtime，或退出重启后采用连接/预算/规则/插件/环境变化。CLI 需退出重启。普通恢复保存会话保留其原模型设置及原权限恢复边界；修改启动默认不改写旧会话。`.env` 更改不会写入当前进程环境。已有即时模型/mode/think、规划方式、子任务限制和外观仍采用原生效语义。

## 视觉设计与真实验收

本轮 [全局设置证据](evidence/global-settings) 包含真实 Electron + 独立 GNOME Keyring/DBus 的 14 场景：首次无项目、直接输入虚构 key、两个项目继承、实际本地 Provider Authorization、关闭重启解密、显式项目覆盖/恢复、CAS/写失败、清除后的未授权验证，以及真实 basic_text 拒绝。六类页面各在正常/窄窗口/125% 缩放截图检查，控件、标题工具栏和底部操作栏统一尺寸。Linux 验证不代替 macOS。

[imagegen 概念图](evidence/graphical-settings/00-imagegen-design-concept.png) 只用于布局参考，未作为运行背景或虚构功能。实际组件使用 React/CSS：分组搜索、列表详情、继承值、敏感状态、空态、焦点和响应式亮暗主题。

真实入口验收：`desktop/scripts/electron-settings-smoke.mjs` 通过 `run.mjs` 启动真实 Electron 和打包 Node worker，隔离 HOME/项目/userData，所有模型请求都给本地脚本 Provider。它点击真实设置/表单并检查 IPC 后的磁盘结果、关闭重启、模型采用、MCP 本地进程、审批和会话操作；不是 preview/mock React 测试。原生文件选择/关闭确认对话框在自动化中仅替换 OS 对话框返回值，后续 IPC/路径校验/生命周期均为实际产品逻辑。

截图与逐场景报告在 [evidence/graphical-settings](evidence/graphical-settings)。Linux 的真实 Electron 界面不能证明 macOS AppKit/交通灯/Dock/Retina/菜单实机通过。之前 Chromium preview 与历史测试证据保持原样，避免把旧结果冒充本轮。

```sh
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm build
pnpm desktop:build
pnpm desktop:smoke
node desktop/scripts/settings-coverage.mjs
# Linux 需要 Electron 系统依赖、Xvfb 与字体；不需要模型 key：
xvfb-run -a node desktop/scripts/electron-settings-smoke.mjs
# macOS 有独立合法机器时直接运行上一条 node 入口（不使用用户电脑）
git diff --check
```

开发 build/run 不要求本机 Node 安装旁有 LICENSE，也不联网隐式下载。正式 package 入口仍要求同版本完整官方许可证及摘要，缺少时给出准确版本的路径指引；不能把开发暂存当分发包。相关真实入口回归保留。验收结果和已有 CLI/PTY 波动分别记录，不跳过或放宽超时来制造通过。

## macOS 代码适配与剩余实机项

保留 Electron 框架、白名单 IPC、contextIsolation/sandbox、导航拦截和 Node sidecar。macOS 使用 hiddenInset、交通灯安全区，拖拽标题栏与控件 no-drag；原生 agentlab/文件/编辑/显示/窗口菜单提供 Cmd+, / O / N、编辑、缩放、全屏。关闭窗口等待保存/清理，取消保留窗口；Dock 激活可重建，Quit 走保存路径。打包只允许当前机器平台/架构，声明 HighDPI/暗色/开发工具分类，不增加权限、签名证书或公证密钥。

Linux 已验代码与交互；剩余只有独立 macOS 环境才能确认：交通灯实际命中/拖拽/双击标题栏，Cmd 键和中文输入法，原生目录对话框，Dock/Cmd+Q/关闭行为，Retina/外接屏幕缩放和未签名 `.app`。不能宣称这些已在 Mac 实机通过。

## 明确边界

没有加载/没有定义 schema 或 ownedFields 的未知插件参数无法被安全推断为现有受支持功能；未知值保留，不提供任意 JSON 或文件写入兜底。已实际加载的 ownedFields 有类型表单或 parse-only 类型控件。无法启动的损坏 JSON、指向受管根外的领域文件、插件代码编辑属于明确限制，不冒充已经覆盖。App 管理配置，不替用户建立账户、填写真实密钥、修改系统设置或提升审批策略。
