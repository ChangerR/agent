# 桌面视觉重构的实际验收

本目录区分三类证据：`before/` 是 PR51 原 head `89d8612` 的真实网页 renderer；`after/` 是同一 renderer 的改版后网页；`electron/` 是云端 Linux 上从 `run.mjs` 启动的真正 Electron。生成概念图不作为验收截图。所有项目、连接、模型和 key 均为隔离虚构数据，没有用户电脑、真实凭据或付费模型调用。

## 发现与修复

| 原版实际问题                                                           | 处理与像素复核                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 模型配置前重复堆叠 provider 卡片、说明与密钥面板，首个输入框已在屏幕外 | 默认模型放在首屏；高级连接字段按需展开；key 放在选中连接下                                             |
| 项目侧栏、设置导航与连接列表三列挤占详情空间                           | 进入设置默认收起项目侧栏；可显式重新打开；窄屏分类改为原生选择框                                       |
| 标题与正文左边界不同，服务类型下拉与其他输入不对齐                     | 标题/正文同一 920px 内容轴；连接详情使用相同表单网格                                                   |
| 局部覆盖叠加至同一 CSS 选择器出现 5–10 次                              | 根样式仅导入 tokens、shell、conversation、settings 四个职责模块；computed CSS 无重复的无条件完整选择器 |
| 底部操作栏依赖侧栏坐标、缩放后遮挡控件                                 | editor 使用标题/滚动正文/保存栏三行网格；36px 控件、40px 主模型控件                                    |
| 长名称撑宽、说明太小且重复                                             | 列表两行截断并提供完整 title；详情可编辑完整名称；主标签 13px、辅助说明 12px                           |
| 原版 125% 等效网页视口中导航被其他侧栏拦截                             | 记录原始失败，不强制点击；新导航实际点击、键盘与滚动检查通过                                           |
| 桌面已展开辅助面板在缩放后变成遮挡表单的浮层                           | 切换到窄屏或切页时收起辅助面板；Escape 可收合；真实 Electron 组合场景复验                              |

首个默认模型控件的实际 CSS 坐标（未通过滚动伪造首屏）：

| 浏览器视口          | 改版前 y / 可见 | 改版后 y / 可见 / 命中 |
| ------------------- | --------------- | ---------------------- |
| 1440×960            | 927.5 / 否      | 295.3 / 是 / 是        |
| 900×700             | 1242.5 / 否     | 295.3 / 是 / 是        |
| CSS720×560、DPR1.25 | 1132 / 否       | 335.9 / 是 / 是        |

连接详情的类型、名称、启用与 Endpoint 在桌面网页的输入左边界均为 x=872.03、宽度 380.97；标题文字与正文同为 x=356。原始 DOM 框、computed font/padding/gap/overflow、命中测试、CSS 规则计数见 `after/computed-layout.json`。浏览器 DPR1.25 只模拟等效可用空间；原生 Electron 缩放单独通过 BrowserWindow + webContents 设置，未叠加 Playwright 模拟视口。

## 逐屏证据

- [改版前主模型页](before/03-model-settings-desktop-light.png) / [改版后主模型页](after/03-model-settings-desktop-light.png)
- [改版前连接详情](before/04-provider-settings-desktop-light.png) / [改版后连接详情](after/04-provider-settings-desktop-light.png)
- [主界面](after/02-chat-desktop-light.png) / [暗色主界面](after/02-chat-desktop-dark.png)
- [长名称暗色](after/05-provider-settings-desktop-dark.png)、[窄屏模型目录](after/07-model-catalog-narrow.png)、[权限规则](after/09-permissions-zoom125.png)、[MCP 空态](after/10-mcp-empty-desktop.png)、[真实 CAS 保存错误](after/11-save-conflict-desktop.png)
- [真正 Electron 保存 key 后](electron/02-global-provider-key-saved.png)、[重启后掩码](electron/04-restarted-global-key-masked.png)、[真正 Electron 125%](electron/layout-zoom125-configuration-connection.png)、[真正 basic_text 拒绝](electron/05-basic-text-refused.png)

网页审阅共 24 个实际像素状态。模型/provider/模型目录/预算/权限/MCP 在正常、窄窗口、125% 等效视口分别查看，另包含主界面、明暗、长文本、空态和错误状态。逐张检查文字层级、控件边界、滚动区域与保存栏；截图并非只检测 DOM 存在。

网页设置审阅使用明确标识的无项目/凭据 bridge fixture；配置读取、校验、CAS 写入仍走本次隔离 preview 的真实 worker。此 fixture 不证明 safeStorage。真实 Electron 场景另用独立 HOME、DBus、GNOME Keyring 与本地 HTTP 假服务，检查 UI → IPC → worker → 文件、系统解密与 Authorization；没有外部模型请求。原生系统目录/关闭确认对话框仅自动返回测试选择，实际后端边界和审批仍执行。

## 验证结果

- 全量 Vitest：100 文件、1780 passed、2 个原有 Windows 条件 skipped、0 failed；原时限保留。本轮 CLI/PTY 全量也通过。见 [原始全量日志](test-output.txt)。
- 根工程和 desktop 类型检查通过；真实 run.mjs 的开发构建/启动通过，未提供 Node LICENSE 环境绕过。
- 真正全局 Electron 14 场景全部通过，包含真实 gnome_libsecret、两个项目四次本地授权请求、错误写入、重启解密、清除以及 basic_text 拒绝。见 [结果](electron/result.json)。
- 真正组合 Electron 17 场景全部通过；21 个实际装配入口（包含验收插件）的 172 个图形控件节点/分支逐项操作后放弃草稿，文件保持不变。包含即时选项、真实审批拒绝/允许、稀疏覆盖、MCP、插件、会话恢复、错误处理和已展开辅助面板的窄屏/125% 回归。见 [结果](electron/electron-settings-smoke.json) 与 [实际控件清单](electron/ui-field-coverage.json)。默认 preset 的独立静态矩阵仍为 20 入口/173 节点，两种计数用途不同。
- 两套真正 renderer + 隔离 worker 的 Chromium 交互回归通过，未使用视觉 bridge fixture：保存/校验/导航取消/继承/即时选项/重置/主题，以及 cache、三个辅助角色、双 provider 模型能力和 MCP 预算。见 [设置](browser-functional/settings-output.txt) / [缓存](browser-functional/cache-output.txt)。
- 浏览器像素审阅 24 状态，无横向溢出/页面错误；真正 Electron 六类页面 × 正常/窄屏/原生125% 共18个布局状态，控件命中和保存栏边界检查通过。

## 验证与复现

运行 Node 22.19+ 和已安装的依赖：

```sh
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm desktop:build
AGENTLAB_PREVIEW_PORT=4378 pnpm desktop:preview
# 另一终端；只允许预览自动创建的 /tmp/agentlab-desktop-preview-* 配置
AGENTLAB_UI_ORIGIN=http://127.0.0.1:4378 node desktop/scripts/visual-audit.mjs
```

真实 Linux Electron（云端提取的 Xvfb/字体和官方 GNOME Keyring；不更改宿主或用户系统设置）：

```sh
PATH=/workspace/agent-ui-libs/usr/bin:$PATH dbus-run-session -- xvfb-run -a \
  -s '-screen 0 1440x1000x24 -nolisten tcp -fp /workspace/agent-ui-libs/usr/share/fonts/X11/misc' \
  node desktop/scripts/global-settings-smoke.mjs /tmp/agentlab-global-evidence
PATH=/workspace/agent-ui-libs/usr/bin:$PATH xvfb-run -a \
  -s '-screen 0 1440x1000x24 -nolisten tcp -fp /workspace/agent-ui-libs/usr/share/fonts/X11/misc' \
  node desktop/scripts/electron-settings-smoke.mjs /tmp/agentlab-combined-evidence
```

`AGENTLAB_TEST_KEYRING` / `AGENTLAB_TEST_KEYRING_LIB` 可指定云端独立测试 keyring；脚本只连接当前 `dbus-run-session`，不连接已有用户密钥服务。Linux `basic_text` 明确拒绝保存；macOS 原生 Keychain、AppKit、交通灯、Cmd/Dock、Retina、原生目录、.app 打包仍没有实机验证。

本轮保留全局默认、直接 key、安全存储、CLI 环境变量、项目稀疏继承、权限/缓存语义和缺 LICENSE 的开发启动修复。模型/连接/结构化字段显式保存；当前会话模型/思考/模式仍即选即保存。完整实际配置范围与限制见 [字段覆盖矩阵](../../SETTINGS-FIELD-COVERAGE.md) 与 [配置说明](../../CONFIGURATION-SETTINGS.md)。未知插件字段保留；受管边界外文件不开放任意写入，不能把内部状态当成任意配置。
