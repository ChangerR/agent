# agentlab 图形设置验收证据

所有实际截图来自独立 Linux 云端 **Electron 44.8.0 + Xvfb**，不是 macOS 实机。模型仅为本地脚本 Provider / FakeProvider，没有真实凭据、付费模型请求或用户电脑连接。

- `00-imagegen-design-concept.png`：实际 imagegen 设计参考，非可运行界面。图内示例文字/参数不作为产品默认事实。
- `01`–`08`：真实 App 设置入口、模型目录、Provider CRUD、MCP/环境掩码、目录边界反馈、会话与亮暗表单。
- `09`：真实 Electron 原生窗口 900×700，CDP 内容视口 720×560，再使用 125% 页面缩放，实际 CSS 视口为 576×448。保存栏完整位于视口内，实际操作覆盖开关后放弃草稿；只改变测试 App 的窗口、视口与缩放，不改系统设置。数值见 `layout-bounds.json`。
- `electron-settings-smoke.json` / `electron-settings-run.txt`：从 `run.mjs` 启动、真实 preload IPC / Node worker / 磁盘 / 关闭重启的逐场景结果。主流程没有 Electron 替身；OS 目录/确认对话框仅在相应场景替换返回值，后端校验和关闭逻辑不替换。
- `ui-field-coverage.json`：逐个操作真实注册 schema 的 21 个入口、166 个字段/分支控件（含本地外部插件例子）。此遍历只建立/放弃草稿，不写配置；持久化和生效由其余事务场景验证。
- `registered-fields.json`：默认 preset 20 个可编辑入口、167 个字段/容器/分支元数据。两个统计口径不同，不将元数据节点数冒充实际保存次数。
- `full-regression.json`：最后一轮 Vitest 全量 99 文件、1772 passed / 2 skipped / 0 failed。两项跳过沿用原有 Windows 专用条件：cwd 大小写恢复、原生 PowerShell 输出/元数据运行。
- `electron-layout-smoke.json` / `electron-layout-run.txt`：最终窄屏视口对齐后，仅针对启动、设置入口、关闭/主题/窄屏重验的 3 个场景全部通过。生产代码未再改变，复用此前 17 场景与全量结果，没有为证据整理重复长跑。
- `library-artifacts.json`：设计概念与最终真实截图的 Library ID、文件 ID 和版本，明确区分概念图与实际 UI。

字段 → 控件 → 作用域 → 校验 → 生效详见 [覆盖矩阵](../../SETTINGS-FIELD-COVERAGE.md)；默认新路径、保存和真实边界见 [配置设置](../../CONFIGURATION-SETTINGS.md)。

## 发现与修复

1. 原设置包含 JSON 输入框、模型目录不可编辑、MCP 凭据只能文件维护。现为 schema 分组控件、列表详情、可排序数组、键值行、密码输入与受控事务。
2. 项目模型/MCP 文件保存后原引用可能仍指向用户默认文件。现显式提交同时激活引用，双 CAS 检查、失败回滚，并在引用改变后重新读取新的受管文件；旧草稿不能撤回新引用。
3. 动态 map 改名/数组排序会失去未知元数据身份。现宿主条目句柄使未知字段跟随原条目，句柄不落盘。
4. 任务审批中打开设置原可能停在读取错误。现显示等待并在结算后重新读取；提交和 Provider 选择受忙碌保护，不处理原审批。
5. 仅 renderer localStorage 在实际 Electron 关闭重启后丢失主题。现主题经白名单 IPC 写固定的应用偏好文件，串行事务、失败回退并显示错误，重启采用；不写 CLI 配置或系统主题。
6. 缩放自查发现设置导航占用过多高度。现窄窗口使用紧凑横向分类和独立表单滚动；保存栏始终固定可达，并在缩放状态操作覆盖控件后放弃草稿验证。
7. 首轮全量 1769 passed / 2 failed / 2 skipped：一项是安全投影后旧读取断言仍要求返回未知字段；更新读取断言并保留磁盘未知字段断言。另一项是 TUI 审批 1 秒等待内仍在模型阶段；新旧代码隔离复验均通过。该 UI 用例现显式 ask read_file，断言零 judge 请求，保留取消/窄屏断言，不再借无关 FakeProvider 审批员纠错触发人工询问；未放宽超时或跳过。
8. 一次 Electron 重启后的界面就绪断言失败。清理本任务残留预览进程，并在 firstWindow 后等待真实 renderer URL 的 DOM 导航；按钮断言时限未放宽。最终完整 17 场景（含四次启动）通过，未把该单次现象的精确成因说成已定位。

## 重现

```sh
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm build
pnpm desktop:build
pnpm desktop:smoke
pnpm desktop:settings-coverage
xvfb-run -a pnpm desktop:electron-smoke
```

云端未向系统安装 Xvfb/字体；将 Debian 官方包解压在 workspace，调用时提供 PATH 和字体路径。实际命令示例：

```sh
PATH=/workspace/agent-ui-libs/usr/bin:$PATH xvfb-run -a \
  -s '-screen 0 1440x1000x24 -nolisten tcp -fp /workspace/agent-ui-libs/usr/share/fonts/X11/misc' \
  node desktop/scripts/electron-settings-smoke.mjs
```

仅复现最后的窄屏复验时，在同一命令后追加 `--layout-only`。

Linux 容器启动标志 `--no-sandbox` 仅在测试启动参数中使用；App 原有 contextIsolation / renderer sandbox / IPC 来源检查均保留。没有签名、公证或外发安装包。Mac 的原生交通灯/拖拽/Cmd/目录/Dock/Retina 和 `.app` 仍需独立 macOS 环境验证，不能据此宣称实机通过。
