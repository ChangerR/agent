# 独立整页设置：结构与交互验收

设置现在是原工作区之外的独立 `<main>`，占满 App 内容窗口。打开后只显示设置自己的返回入口、分类导航、搜索、表单与作用域控件；原项目/会话侧栏、聊天、检查栏、工作区工具栏全部隐藏且 inert，没有可重新露出项目导航的 toggle。原工作区保持挂载以保留输入 DOM、未发送草稿、选区、标签页和展开状态，并在返回时恢复滚动/焦点；不创建或恢复另一个会话。

- [网页改版前](before-web.png)：设置位于 `.workspace` 内，原 toggle 可重新露出项目栏。
- [网页改版后](after-web.png)：真实 renderer + 隔离 preview worker，整个设置页面独立；没有凭据 bridge fixture，浏览器安全存储不可用的提示是实际预览行为。
- [真正 Electron 桌面整页](electron/desktop-settings.png)、[暗色](electron/desktop-settings-dark.png)、[窄窗](electron/narrow-settings.png)、[原生125%](electron/zoom125-settings.png)。全部是完整 `capturePage()` 内容窗口，不是缩放裁切或生成图。
- [进入前聊天](electron/chat-before-settings.png) / [返回后聊天](electron/chat-after-return.png)：同一 FakeProvider 会话和未发送草稿。

结构原始证据在 `before-structure.json` / `after-structure.json`。改版后设置 bounds 为 x=0,y=0,width=1440,height=960；settingsEmbeddedInWorkspace=false、projectSidebarVisible=false、workspaceToolbarVisible=false，工作区 hidden/inert=true。真实 Electron 在全部三种尺寸再次断言独立结构、无原侧栏 toggle、满窗口边界和无横向溢出。

## 本轮真实验收

| 场景               | 实际检查                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 无项目进入         | 设置按钮打开整页、默认全局、没有创建 runtime/session；原生设置菜单仍声明 CmdOrCtrl+, 且真实触发 IPC 导航    |
| 重复打开与取消返回 | 连续菜单打开不重置草稿、不多弹确认；点击返回并取消后输入和未保存标记保留，磁盘没有写入                      |
| 无项目保存后返回   | 真正 renderer → preload/IPC → global worker → 文件；返回原项目页、保留未知字段，无运行时创建                |
| 聊天进入/返回      | 同一 sessionId、generation、cwd、消息行数；同一输入 DOM、文本、光标选区与焦点；恢复原滚动和检查栏标签       |
| 放弃与保存         | 取消/确认放弃不影响聊天草稿；保存全局默认再返回仍保留当前会话，没有热换或创建会话                           |
| 设置自己的项目范围 | 显式切换作用域、保存项目覆盖、恢复继承；原项目导航始终不可见                                                |
| 尺寸与主题         | 桌面1440×960、窄窗900×700、原生125% CSS720×560/PNG900×700；返回/搜索/作用域完整可达；真实主题 IPC、亮暗截图 |

`electron/result.json` 及 `fullpage-output.txt` 包含上述6组完整场景、窗口/PNG/CSS数据；未使用网页 fixture 替代 Electron。新脚本为 `desktop/scripts/fullpage-settings-smoke.mjs`。实际 Cmd 键/AppKit/交通灯/Retina未在macOS实机测试；这里只验证原生菜单加速器声明和菜单动作→IPC，不能声称物理Mac Cmd已通过。

其他受影响回归也重新执行：

- 全局/密钥 **14场景通过**：实际隔离GNOME Keyring、直接key输入/加密、两个项目继承、重启解密、错误保存/清除、basic_text拒绝。见 `global-regression.json`。
- 组合 **17场景通过**：全部表单、CRUD、MCP/角色/cache、权限审批、会话、主题失败与关闭重启。见 `combined-regression.json`。
- 原生缩放专项：全部相关输入、导航与作用域逐个实际点击、边界/命中、保存/继承，见 `responsive-regression.json`。
- 真正网页交互回归通过，包括选择即时保存、设置保存、返回取消、校验、用户/项目隔离、重置和暗色。
- 根/desktop类型及真实run.mjs开发构建/启动通过；没有Node LICENSE变量绕过。
- 最终全量 **100文件、1780通过、2个原有Windows条件跳过、0失败**，111.07秒。

首轮全量与Electron/类型检查并发，出现30秒PTY超时及10秒构建子进程失败（总耗时177.70秒）。停止Electron验收后以同样 maxWorkers=2/minWorkers=1 完整重跑得到上述全过结果；没有放宽超时或增加跳过。`initial-concurrent-full-output.txt` 和 `full-test-output.txt` 同时保留。相关CLI/runtime源码、测试语义未改；现有失败日志未包含构建进程退出信号，不宣称已经精确定因或修复了潜在负载波动。

## 复现

```sh
PATH=/workspace/agent-ui-libs/usr/bin:$PATH xvfb-run -a \
  -s '-screen 0 1440x1000x24 -nolisten tcp -fp /workspace/agent-ui-libs/usr/share/fonts/X11/misc' \
  node desktop/scripts/fullpage-settings-smoke.mjs /tmp/agentlab-fullpage-evidence
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
```

实现/验收代码 commit `ab6b9d10e82633da5901d7d008e9ca2462a1c356`，之后只有证据/文档。全程仅云端、隔离HOME和FakeProvider/本地假服务，无用户电脑、真实凭据、外部付费API或安装包发布。配置格式、默认路径和权限审批契约没有因整页结构变化而变更。

Library实际Electron桌面图：`libfile_8ac50b890d2c819180be29570c8e7096`，不是网页样例或macOS截图。
