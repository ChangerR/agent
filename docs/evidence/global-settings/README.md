# 全局设置 / API key / 布局修复验收

PR50 合并后，从 master `d5de823a1ed7fcf6ea946917aa35e5227cd128a0` 新建修复分支。所有操作在独立 Linux 云端，隔离 HOME、项目、应用配置、DBus 和 GNOME Keyring。没有用户电脑、真实凭据或付费模型请求。

## 根因和实际修复

1. 原设置注册表由项目 Agent 创建，无项目时只有外观；scope 默认 project。现在独立全局设置 worker 使用同一 preset/schema，不创建 Agent、会话、工具或网络连接，默认写 ~/.agentlab。18 个全局入口可在首次空白启动时配置，项目覆盖须明确选择。
2. 原 API key 仅提供变量名，另一个入口只写项目 .env。现在直接密码输入→授权 IPC→Electron safeStorage→密文文件，普通配置只存随机引用。环境变量方式保留。Linux basic_text/不可用后端拒绝保存，凭据绑定 provider/适配器/实际 endpoint；既有会话不热换凭据。
3. 控件尺寸与多组布局规则不一致。现统一 36px 控件和按钮、标签/输入 baseline、标题工具栏及保存栏；小窗口标题不固定占住视口，长表单独立滚动。
4. 真实冲突回归发现“重新读取”仍走项目通道；已按当前作用域路由。项目专用页切回全局时选取有效全局页面。关闭设置 worker 等待已接受的保存结算。

## 通过的证据

| 检查                             | 结果 / 文件                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| 全量 Vitest                      | 100 文件，1780 passed / 2 原有 Windows 条件 skipped / 0 failed；full-regression.txt     |
| 真实全局 Electron                | 14 场景；result.json、electron-global-run.txt                                           |
| 既有 App 组合                    | 17 场景；electron-combined.json、electron-combined-run.txt                              |
| 类型、CLI/App 构建、原生 sidecar | 通过；validation.json、cli-build.txt、sidecar.txt                                       |
| 两套 Node/Playwright Chromium    | 通过；browser-ui.json、browser-cache-ui.json                                            |
| schema 覆盖矩阵                  | 默认 20 可编辑入口 / 173 节点；registered-fields.json、../../SETTINGS-FIELD-COVERAGE.md |

14 场景从真实 run.mjs 启动 Electron，经实际 preload / IPC / worker / 文件系统：无项目全局配置、provider 新增、直接 key 保存、模型规格/默认值、两个项目继承并实际请求、显式项目覆盖/恢复、项目专用页返回全局、CAS 和密钥写失败、逐屏布局、关闭重启解密、清除 key、清除后新运行时不再使用旧 key、实际 basic_text 拒绝。

本地 HTTP 假服务记录四次正确 Authorization 和清除后一次未授权请求，只存校验布尔值，不存请求头或 key。实际 gnome_libsecret + 独立 GNOME Keyring 执行加密/解密；没有替换 safeStorage。隔离 HOME（含 profile/config/state/logs）和两个项目的文件扫描未发现明文测试 key。没有真实外部模型请求。

18 张布局截图覆盖连接、provider、模型、预算、权限和 MCP 的正常 1440×960、窄窗口 900×700、125% 缩放。缩放场景使用真实 Electron zoom 与 CDP 内容视口，实际 CSS 576×448；逐页实际点击表单控件、取消草稿，测量控件命中、可见区域、横向溢出及保存按钮等高。不是只检查 DOM 存在。06-dark-global-key.png 另验证实际暗色密钥面板。

01 是首次无项目全局入口；02/04 是保存和重启后的掩码；05 是实际 basic_text 拒绝；Library 文件身份记录在 library-artifacts.json。全部实际截图来自 Linux Electron，非概念图或 macOS 实机。

## 重现

```sh
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm build
pnpm desktop:build
pnpm desktop:smoke
pnpm desktop:settings-coverage
# Linux 使用独立会话与隔离 keyring，不连接已有用户服务：
AGENTLAB_TEST_KEYRING=/usr/bin/gnome-keyring-daemon dbus-run-session -- xvfb-run -a pnpm desktop:global-smoke
xvfb-run -a node desktop/scripts/electron-settings-smoke.mjs /tmp/agentlab-combined-evidence
```

云端的 Xvfb/字体及 GNOME Keyring/libgck/libgcr 来自 Debian 官方包，仅解压到 workspace，未安装或更改系统设置。实际启动通过 PATH、Xvfb 字体路径、AGENTLAB_TEST_KEYRING/AGENTLAB_TEST_KEYRING_LIB 指向这些测试依赖。--no-sandbox 仅测试启动参数；产品 contextIsolation/sandbox/IPC 来源校验保留。原生目录/关闭确认对话框只在相应自动化场景替换 OS 返回值，保存、路径、权限和生命周期仍真实执行。

## 明确边界

- macOS AppKit、Cmd、Dock、Retina、原生目录、.app 和 Keychain 行为没有实机条件，不能称 Mac 通过。
- Node CLI 不依赖 Electron；原环境变量方式保留。App 加密 key 引用需要可信解密宿主，CLI 首次请求会明确提示，不能自动读取或悄悄回退其他 key。
- 项目 .env / MCP 仍是既有 CLI 文本格式，掩码不等于加密。全局 Provider API key 面板才使用 safeStorage。
- 未加载且无 schema 的未知插件参数保留；受管根外领域文件不开放任意写入，损坏 JSON 没有通用修复编辑器。

测试未放宽超时或跳过失败。旧组合/预览脚本原先假设项目为默认，并从 runtime 读全局保存结果；现明确选择项目并读取相应作用域及新的保存版本。实际产品缺陷与脚本假设分开修复，历史截图和证据保持原样。
