# 125% 窄窗截图与布局更正

此前 Library `libfile_965f2cb203bc81919b7a8904c8db2ab3` version 0 和旧 125% 截图存在裁切错误。本目录及同一 Library 文件的 **version 1** 为更正证据；均是真正云端 Linux Electron，无网页 bridge fixture、生成图或用户电脑。

## 已复现的两个问题

1. 900×700 原生内容窗口在125%下是720×560 CSS视口、DPR1.25。旧 `page.screenshot()` 只输出720×560像素，将900×700的物理画面裁掉右侧和底部。旧DOM `scrollWidth` 检查虽然通过，不能证明截图完整。`before-legacy-cropped.png` 保留了错误证据；`before-native-full-window.png` 是同一旧布局的完整原生截图，证明导航/搜索/作用域原本在CSS视口内。
2. 原来的主模型单列断点仅650px；720px下仍是两列。新回归先准确失败于 `2 !== 1`，随后将主模型单列断点改为编辑器800px，1440px正常桌面仍两列。没有修改其他设置、凭据、权限或运行时逻辑。

截图现在通过 Electron `BrowserWindow.capturePage()` 获取完整内容窗口。公共 helper 同时核对 PNG 像素宽高等于 `CSS视口 × devicePixelRatio`，旧两套 Electron 验收也改用同一 helper，避免后续再次交付缩放裁切图。

## 实际复验

`result.json` 为真实 run.mjs → Electron/preload/IPC/worker/文件流程：

| 场景     | CSS视口          | 原生PNG  | 主模型列数 | document.scrollWidth |
| -------- | ---------------- | -------- | ---------- | -------------------- |
| 桌面     | 1440×960         | 1440×960 | 2          | 1440                 |
| 窄窗     | 900×700          | 900×700  | 1          | 900                  |
| 原生125% | 720×560、DPR1.25 | 900×700  | 1          | 720                  |

125%下导航选择、搜索、作用域、服务连接、默认模型、thinking逐个真实点击/键盘操作；每项滚动到可见区域后检查左右/上下完整边界及实际命中，无 force。单列内容允许垂直滚动，保存栏和固定导航可达。搜索框x532+宽170=702≤720；作用域x537.2+宽122.8=660≤720；模型框x20+宽672=692≤720。随后直接保存虚构默认模型，核对全局文件、切换项目继承并返回全局。

- [完整125%窗口](zoom125-full-window.png)（900×700真实像素）
- [正常桌面未回退](desktop-full-window.png)
- [900px窄窗](narrow-full-window.png)
- [修复前诊断](before-result.json) / [修复后边界与尺寸](result.json)
- 既有 `--layout-only` 三场景通过：真实开发入口/菜单/未保存关闭/主题持久化/原生缩放，见 `existing-layout-result.json`。
- 根工程/desktop类型检查通过。此前100文件/1780测试及17+14完整Electron结果保留为上一阶段证据；本轮仅改CSS与截图验收工具，运行受影响回归，没有重复不变的全量。

复现（与上级目录相同的云端Xvfb/字体）：

```sh
PATH=/workspace/agent-ui-libs/usr/bin:$PATH xvfb-run -a \
  -s '-screen 0 1440x1000x24 -nolisten tcp -fp /workspace/agent-ui-libs/usr/share/fonts/X11/misc' \
  node desktop/scripts/electron-responsive-smoke.mjs /tmp/agentlab-responsive-evidence
```

实现与验收代码 commit：`7148156f6801028520b8aa216900f225d8096987`。无真实凭据/外部模型请求；macOS原生窗口、Retina和AppKit仍未实测。
