# 终端交互约定

## 阅读与运行状态

- 主区域保留对话与操作记录；当前阶段、权限模式、输入和待发送消息位于底栏。
- 完成的思考默认一行，成功工具默认两行，失败工具最多四行。折叠输出按实际可见行限高，长中文或长路径不会撑满窄屏。
- `Ctrl+O` 展开全部思考、工具参数与输出；`/details 编号` 只查看一条完整记录。折叠不改变模型历史或保存内容。
- 空闲时 Enter 发送，运行时 Enter 排队。下一条待发送内容保留在输入区标题；`/queue clear` 清空队列。运行中 Esc 中断并清空队列。
- 窄窗口优先显示权限模式与思考级别，模型名允许截断。

## 设置与审批共用底部面板

- `❯` 表示当前候选，`当前` 表示已经生效的设置。筛选模型不更改当前模型；Enter 应用，Esc 返回且不更改。
- 模型与推理设置在下一次模型请求生效，可能发生于当前用户轮次内；模型选择不会切换 provider 或 endpoint。
- 权限模式对后续权限检查生效，不追溯修改已经等待用户处理的审批。说明文字依据审批模型、危险操作强制询问配置显示。
- 审批先展示操作，再展示允许一次、记住规则、拒绝。每个新请求初始都未选择，必须用方向键或鼠标选中后再按 Enter；鼠标点击本身不授权。
- 记住规则按实际工具匹配目标解释：通常是路径、命令或模式；没有匹配目标的插件会授权整个工具。匹配目标相同并不代表其他参数相同。规则随会话保存与恢复。
- Tab 查看完整详情，包含选中授权选项的范围说明、理由和完整参数；Enter 从详情返回选项，不直接授权。支持方向键、PgUp/PgDn、Home/End 滚动。
- 审批优先于设置，结束后恢复原筛选与未发送草稿。连续确认后的短暂重复 Enter 会被吸收，避免落入恢复的草稿或设置候选。
- Esc 拒绝当前审批；运行中审批的 Ctrl+C 仍中断当前轮。普通设置面板的 Ctrl+C 只关闭面板。

## 参考与取舍

参考成熟终端产品的渐进披露、固定输入区、区分当前值和候选、保留草稿以及操作范围透明原则，保持 AgentLab 原有事件订阅和权限引擎，不引入新的界面框架。

- [Claude Code 交互模式](https://code.claude.com/docs/en/interactive-mode)
- [Claude Code 权限](https://code.claude.com/docs/en/permissions)
- [Codex bottom pane](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/mod.rs)
- [Codex 工具输出渲染](https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs)

回归测试在 `tests/cli.test.ts`，使用离线 provider 和真实 pi-tui 渲染器覆盖流式更新、工具折叠、设置取消、审批排队、重复确认、草稿恢复、历史与窄屏。设置 `AGENTLAB_TUI_SNAPSHOT_DIR` 可保存文本屏幕供对照。
