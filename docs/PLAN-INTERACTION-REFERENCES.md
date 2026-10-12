# 计划展示与并行审查的官方实现参考

本次在 2026-10-12 读取官方仓库默认分支源码，下面链接固定到实际读取的提交。
参考用于选择交互原则，不把不同产品的授权语义、菜单或运行框架搬进本项目。

## Pi

`https://github.com/badlogic/pi-mono` 目前重定向到 `earendil-works/pi`。
读取提交：`4270522473e677ddba7b093caa0064a3df51d459`。

- [键位定义](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/core/keybindings.ts)：
  `app.tools.expand` 使用 Ctrl+O；思考另有切换键。展示切换是内置按键动作，不要求先输入命令。
- [交互控制器](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/src/modes/interactive/interactive-mode.ts)：
  `setToolsExpanded` 更新已有组件，保持正文与输入结构，不追加重复的工具内容。
- [plan-mode 示例](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/examples/extensions/plan-mode/index.ts)：
  footer 用完成数/总数表示进度，另有完整 todo widget；Ctrl+Alt+P 切换规划模式。
  这是扩展示例，不能据此声称 Pi 内置了默认一行折叠计划，也不能把模式切换等同展示切换。
- [subagent 示例](https://github.com/earendil-works/pi/blob/4270522473e677ddba7b093caa0064a3df51d459/packages/coding-agent/examples/extensions/subagent/index.ts)：
  single、parallel、chain 区分独立并行与有依赖的串行任务，parallel 有并发限制与进度回调。
  本项目已有 Supervisor，不引入该示例的进程调度实现。

## Kimi CLI 与 Kimi Code CLI

用户指定的 `MoonshotAI/kimi-cli` 已归档，README 明确指向新官方仓库 `MoonshotAI/kimi-code`。
两者分别读取，避免将旧键位误称为当前实现。

- [旧仓库 README](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/README.md)：
  归档说明和新产品地址；旧提交为 `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82`。
- [旧输入层](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/ui/shell/prompt.py)：
  Shift+Tab 切换 plan mode，并检查活动 prompt delegate；旧 Ctrl+O 是外部编辑器。
- [旧实时面板](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/ui/shell/visualize/_live_view.py)：
  Ctrl+E 仅在可展开面板存在时暂停实时绘制并打开完整内容，退出后恢复键盘监听。

当前 Kimi Code 读取提交：`c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9`。

- [todo-panel](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/apps/kimi-code/src/tui/components/chrome/todo-panel.ts)：
  位于输入上方，`expanded=false`；默认最多五项，优先进行中和待办，显示隐藏数量；
  有溢出才提示 Ctrl+T；`clear()` 同时重置展开状态，每行按终端显示宽度截断。
  它默认并非一行，本项目的一行要求来自用户。
- [editor-keyboard](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/apps/kimi-code/src/tui/controllers/editor-keyboard.ts)：
  todo 切换先检查 `hasOverflow()`，使用单独展示动作；与规划模式和工具详情切换分开。
- [官方键盘文档](https://github.com/MoonshotAI/kimi-code/blob/c151d5a3d03ed6e9d05c27a0d3b302538ea6e7b9/docs/en/reference/keyboard.md)：
  Ctrl+T 展开/收起 todo，Shift+Tab 切规划模式，Ctrl+O 切工具详情；审批内普通方向键与 Enter
  仍用于审批，Ctrl+E 用于审批正文详情。不同层的焦点与动作有明确区分。

## 本项目采用的范围

- 默认一行计划摘要，保留阶段、计数、具体当前/阻塞步骤和一个展开入口。
- Ctrl+T 展开/收起，Alt+↑/↓ 浏览展开文本；不夺取父输入或审批面板焦点。
- 按实际显示宽度处理中文、emoji 和长文本，展开区域有高度上限，新计划/恢复重新收起。
- 共享架构调研后，将互不依赖的只读审查分给 child；先启动独立任务再等待，依赖工作串行。
  复用 Supervisor 全树配额、权限、工具锁、取消、会话与计划归属；默认配额为两个 child。
- 不复制外部产品的审批模型、外部 pager、复杂执行菜单、Python 运行时或迁移机制。
