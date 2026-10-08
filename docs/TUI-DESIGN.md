# AgentLab 的 pi 风格终端界面

## 参考版本与边界

参考仓库：https://github.com/earendil-works/pi（原 `badlogic/pi-mono` 地址重定向至此）。
核验时间：2026-10-08；源码 SHA：`ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`；
该源码的 coding-agent 版本：1.1.0。
AgentLab 保持现有 `@earendil-works/pi-tui` 1.0.2 依赖；没有引入 pi 的 agent engine、账户、凭据或配置。

固定源码参考：
- [用户消息](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/modes/interactive/components/user-message.ts)：Markdown 自己绘制整宽背景和一列留白，无额外套框。
- [助手消息](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/modes/interactive/components/assistant-message.ts)：回复直接呈现 Markdown，思考用低对比文本，不为每个增量重复角色标题。
- [工具执行](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/modes/interactive/components/tool-execution.ts)：通过 pending/success/error 语义背景区分状态，标题和输出分层。
- [编辑器](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/modes/interactive/components/custom-editor.ts)：运行状态嵌入上分隔线；继续使用 pi-tui Editor 的光标、粘贴、历史、补全实现。
- [页脚](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/modes/interactive/components/footer.ts)与 [dark 主题](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/modes/interactive/theme/dark.json)：编辑器下显示目录/模式/思考等级及 token/cache/model；使用统一 muted/accent/success/error 角色。

这些是布局和语义色的适配，不声称是 pi 的像素级克隆。AgentLab 没有可可靠获取的 cost/context% 数据，因此不虚构对应数字。主题简化成可审计的本地颜色表，保留 MIT 署名见 `THIRD_PARTY_NOTICES.md`。

## 交互与视觉约定

- 一个会话流：用户消息蓝灰背景，助手 Markdown 开放排版，工具结果整宽淡色块；不把每条消息放进独立边框。
- 输入区复用 pi-tui Editor；思考等级改变细分隔线颜色；排队摘要显示在输入区上方。
- `/settings` 和权限配置保留完整紫色细框；权限审批保留黄色完整框、操作来源、未选择状态、显式 Enter 和 Esc 拒绝。
- 普通模型/思考选择器与详情采用轻量细线，关闭后恢复原输入草稿和已打开的选择器。
- 工具折叠预览最多三行，截断提示保留 `/details N`；完整参数与结果不丢失。流式 Markdown 仍使用 60ms 合并刷新。
- `AGENTLAB_THEME=light` 选择浅色语义色；默认深色。终端未启用 ANSI 时仍有标题、勾叉和分隔线；256 色终端使用深灰底回退，避免深 RGB 被量化成亮灰。
- 小于 16 行的终端省略次要快捷键行，保留编辑器、模式/模型状态和审批操作。支持 `AGENTLAB_SCREEN=main` 与默认独立滚动视口。

## 验证

`tests/cli.test.ts` 覆盖真实 pi-tui 视口、连续审批、返回详情重新选择、草稿、排队、中断、滚动、恢复历史及窄窗口；`tests/interaction-panels.test.ts` 覆盖鼠标行映射和终端控制字符；`tests/tui-visual.test.ts` 保存 40/80/100 列消息快照。离线预览使用 FakeProvider，不需要 API key，也不读取或修改用户配置。
