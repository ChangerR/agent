# 分层配置设置与桌面适配盘点

本文的“当前字段”指面向 master 的收尾分支 feature/app-macos-settings-to-master，包含 #47 App 增强和 #49 的实际缓存设置接入。#48 已进入 master，#49 进入缓存分支；收尾 PR 尚未合并。完整状态见 [App / Cache 集成](APP_CACHE_INTEGRATION.md)，不需要用户手动补配置接线。

## 基线与交付边界

最初从默认分支 `master` 的 `cb64528` 独立开发。当前 PR 链和本轮冲突整理见 [App / Cache 集成](APP_CACHE_INTEGRATION.md)。
该提交只有 TypeScript / Node.js 的 TUI，`package.json` 没有桌面脚本，
也没有 Electron、React 或 macOS 打包配置。

已有 Electron + React + 独立 Node worker 的桌面工作台最初来源于
[PR #45](https://github.com/ChangerR/agent/pull/45)，提交 `d2536c7`。
初始 feature 基于该 App 开发并纳入 master@cb64528。现在 #45 和 #48 已进入 master@9fbffd6；#47 与 #49 合入的是依赖分支，故从实际集成 tip bed0728 建立独立收尾分支，普通 merge 最新 master 后面向 master 交付。没有修改已合并 PR 或合并任何远端 PR。
本次交付 Electron/React 设置页面、受控 worker 接口和 macOS 代码适配。
云端仅为 Linux，未执行 macOS 原生窗口 / 菜单 / Retina / 未签名包验收。
没有替换框架、连接用户电脑或调用真实模型。

## 真实 schema 的覆盖

新增入口都由 `AgentConfigSchema`、插件 `config.schema` 和 `ownedFields` 生成，
同时接入 Electron 设置页和原有 `/settings` 通用编辑器。表中“重启”指退出 App / CLI 进程后重新启动；
创建新会话不承诺重新装配 provider 或插件。

| 入口                           | 已支持字段                                                                                                          | 作用域 / 生效时间                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 主任务与模型连接（启动默认值） | provider、model、baseURL、apiKeyEnv、thinking、judgeModel                                                           | 用户 / 项目；重启                                   |
| 上下文与缓存预算               | maxTurns、compactThreshold、cache.enabled / ttl / staticTtl / ttlStrategy / escalateAfterMs                         | 用户 / 项目；重启                                   |
| 权限与审批默认值               | permissionMode、permissions.allow / ask / deny                                                                      | 用户 / 项目；重启；不处理已有审批                   |
| 配置文件与插件装配             | modelsFile、mcpConfig、pluginEntries、disabledPlugins                                                               | 用户 / 项目；重启；这里只编辑引用路径               |
| OpenAI / Anthropic 适配器参数  | models 能力映射；OpenAI 另有 dialect                                                                                | 用户 / 项目；重启                                   |
| 严格审批模型参数               | provider、model、thinking、timeoutMs、maxRequestBytes、maxResponseBytes、maxOutputTokens、prefixCache.enabled / ttl | 用户 / 项目；重启                                   |
| MCP 结果参数                   | maxInlineChars、maxAgeDays、maxStoredBytes、deduplicate、maxSearchChars                                             | 用户 / 项目；重启                                   |
| 子任务参数                     | maxRunning、maxDepth、maxTurns、timeoutMs、maxInbox、maxOutputChars、previewChars、maxAgents、maxRuns               | 用户 / 项目；重启                                   |
| 规划参数                       | mode、provider、model、thinking、maxOutputTokens、maxRequestBytes                                                   | 用户 / 项目；启动默认值重启，已有 mode 命令即时     |
| 摘要模型与预算                 | provider、model、thinking、strategy、maxOutputTokens、maxRequestBytes                                               | 用户 / 项目；重启                                   |
| 其他运行配置                   | replayToolArguments                                                                                                 | 用户 / 项目；重启                                   |
| 本地工具参数                   | disabled                                                                                                            | 用户 / 项目；重启                                   |
| 日志参数                       | includeBodies                                                                                                       | 用户 / 项目；重启；保留原默认值，不自动开启正文日志 |
| 既有插件实现选择               | capabilities                                                                                                        | 复用原有受控入口                                    |
| 既有目录写入授权               | writeRoots                                                                                                          | 只用策略插件的项目级专用入口，仍执行真实路径验证    |
| 既有会话控制                   | /sessions、/save、/new、/model、/think、/mode                                                                       | 保留原会话管理和即时应用语义                        |

`models.json` 中各模型的 contextWindow / maxOutputTokens 仍通过文件维护；
本入口可以修改 modelsFile 引用，不会把模型规格臆造为新的顶层字段。
MCP 编辑器仅接受固定目录中的 mcp.json，不接受 renderer 提供的文件路径。
现有 args / env / headers 始终掩码，提交时在 worker 内恢复。新增 env / headers
凭据需在 CLI 文件维护；不发明 env:NAME 的 MCP 运行时解析行为。
编辑固定文件不会更改 mcpConfig；页面显示当前实际文件，使用自定义文件的项目
需自行在“配置文件与插件装配”中选择对应引用。MCP 连接状态另有只读入口。
planner / summary / judge 使用实际插件 schema；UI 外观是 renderer 本地偏好，即选即持久化，不写入 agent.config.json。
会话覆盖仍可能优先于启动默认值，保存默认值不修改已保存会话。

## 保存、校验与迁移

1. 默认编辑项目 `agent.config.json`；切换“全局”后编辑 `~/.agent/config.json`。
   标题和路径始终说明目标层，读取的是该层原始覆盖，不是合并后的运行值。
2. 打开或创建草稿只读，不创建目录、不回填默认值，也不加载 `.env`。
   Enter 提交一份 JSON，Esc 放弃未提交输入，不增加独立 Save 页面。
3. 省略字段清除此层相应已知覆盖。未知顶层、未知命名空间及未知嵌套字段保留。
   如果一个对象仍含未知子字段，该对象会留下；CLI 的同名对象替换语义仍然适用，
   不能承诺它已整体恢复继承。需要整体删除时，请显式审阅 CLI 文件。
4. 保存沿用 PluginConfigStore 的文件身份检查、CAS、锁和原子替换；
   外部编辑、符号链接、取消或旧草稿导致保存失败时不覆盖文件。
   失败经 `settingsErrorMessage()` 转换，不回显原始 JSON 或插件异常内容。
5. 数值、枚举、插件跨字段约束由原 schema 校验；另外拒绝非法 key 变量名、
   带凭据 / 查询 / fragment 的新 endpoint、空模型 ID、非法权限规则及新未知字段。
   密钥使用 apiKeyEnv 或插件声明的 env:NAME 引用；不会读取环境变量的值。
6. 展示前只选择 schema 拥有的字段；已声明敏感字段、常见凭据字段和带凭据的 URL
   使用掩码。未更改的掩码在宿主内恢复原值，掩码本身不落盘。
   插件应准确声明 sensitiveFields；本功能不能推断任意文本是否包含秘密。
7. 不需要迁移脚本。已有 CLI 文件、字段优先级、数组替换及插件合并规则保持兼容。
   初次打开设置不会触发迁移；任何覆盖写入均来自一次明确的提交。

新增顶层 schema 字段会进入“其他运行配置”；新增内置插件 ownedFields 会自动进入
对应插件参数组。需要特殊领域校验的设置应保留专用入口，不能仅凭类型 schema
增加授权路径。当前默认装配收集内置插件定义；外部插件仍通过其 SettingsSection
契约提供入口，不反射或自动授予它们写入能力。

## 已有 App 的 macOS 差距与后续验证

保留 PR #45 的白名单 IPC、contextIsolation、sandbox、导航拦截、原生目录选择和
唯一工具执行器。本次新增：

- hiddenInset 标题栏及交通灯定位；左上角安全区；标题栏可拖拽，按钮 / 输入 / 选择器不可拖拽。
- 原生应用 / 文件 / 编辑 / 显示 / 窗口菜单；Cmd+, 设置、Cmd+O 原生目录选择、
  Cmd+N 新会话、复制粘贴、撤销、全屏和缩放。
- macOS 关闭窗口后等待 worker 保存 / 清理，保留应用；Dock 激活重新创建窗口。
  Quit 走保存流程；有未保存设置或运行任务时保留取消选项，保存失败保留窗口。
- macOS 字体回退、跟随系统暗色、800×600 最小原生窗口、窄屏自适应、独立滚动和焦点样式。
- darwin bundle ID / 开发工具分类、暗色与 HighDPI 声明；只打包当前机器平台 / 架构，
  校验随包 Node 元数据，拒绝把 Linux Node 伪装为 macOS 包。没有签名 / 公证配置。
- React 分节表单、原始层覆盖开关、JSON 高级字段、失败反馈、未保存标记 / 导航与关闭提醒。
  “清除此节的本层覆盖”只改变草稿，提交后才写盘；Esc / 放弃不保存。
- 新 settings-read / settings-commit / settings-close 协议，绑定 generation、sessionId
  与一次性 editor ID；worker 校验注册的 section 和 scope，沿用其 draft / commit。
  保存期间的关闭和会话变化使未提交草稿失效；当前审批不能被设置操作批准。

截图来自真实 Linux Chromium + 隔离 FakeProvider 预览：

- [亮色设置页](evidence/macos-app-settings/settings-light.png)
- [900px / DPR 2 暗色布局](evidence/macos-app-settings/mac-layout-simulation-dark.png)：
  仅注入 renderer 的 macOS CSS 标记，不含原生交通灯 / 菜单，不能证明 macOS 实机通过。

可复现检查：

```sh
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm build
pnpm desktop:build
pnpm desktop:smoke
pnpm desktop:package --validate
pnpm desktop:preview
# 另一个终端，需要 Node Playwright + Chromium：
pnpm desktop:ui-smoke
pnpm exec vitest run tests/configuration-settings.test.ts tests/runtime-settings-tui-autosave.test.ts
git diff --check
```

构建使用当前 Node 及其官方 LICENSE；若安装未附许可证，可显式设置
AGENTLAB_NODE_LICENSE 指向同版本官方分发的 LICENSE。云端 Node v24.19.0 的验证
使用官方 nodejs/node v24.19.0 LICENSE，放在临时目录，不提交二进制或安装包。

所有测试使用隔离 HOME、临时项目和固定假凭据。TUI 按键测试与 App UI 测试分别报告；
ui-smoke.mjs 操作真实 React 页面与构建 worker，覆盖提交 / 校验失败 / 作用域 / 未保存
导航 / 草稿重置 / 系统暗色 / 窄屏高 DPI。它不能验证 Electron 菜单或 AppKit。

独立 macOS 环境的剩余验收清单：

1. Apple Silicon / Intel 对应架构执行 install、typecheck、test、desktop:build、smoke、package。
2. 启动未签名 .app，核对交通灯区域、拖拽、全部输入 / 下拉 / 按钮可交互和双击标题栏。
3. 验证 Cmd+, / O / N、复制粘贴、撤销、缩放、全屏、中文输入法；原生目录选择含空格 / 中文 / 符号链接。
4. 关闭空闲 / 运行窗口、取消退出、保存错误、Cmd+Q、Dock 重开，确认没有遗留 worker 或自动重试。
5. Retina / 外接显示器切换、系统暗色切换、缩放 80%–150%、800×600 窗口和长表单滚动。
6. 核对 .app 内 Node 平台 / 架构和 LICENSE。无需证书 / 公证密钥，不上传或外发安装包。

只能使用合法独立 Mac；禁止连接或委派到用户电脑。

## 与缓存任务的协调

相对最新 master，本分支修改 `src/builtin/runtime-settings.ts`、`src/builtin/default-preset.ts`，
新增 `src/builtin/configuration-settings.ts`，并扩展设置测试。缓存运行时、provider / reviewer / MCP
的 schema 与 ownedFields 已由 #48 进入 master；本分支直接消费它们，不复制其运行时实现。
default-preset 收集实际插件后注册 runtime-settings，并保留缓存对 MCP、摘要和规划的装配参数。
未来 schema / ownedFields 变动仍应通过相同扩展点接入并补特殊 apply 语义验证。

### 缓存字段的最终接入状态

最初只读核对 a0562c0；现已在完整缓存 runtime 上接入并验证，收尾分支包含以下真实可操作表单。
这些配置保存后需要重建 runtime，对 App 即退出进程重新启动；单独新建会话不承诺重新装配。

| 缓存字段                                                                                                                      | 接入状态                                | 设置入口 / 生效                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| replayToolArguments                                                                                                           | 已接入顶层实际 schema                   | “其他运行配置”；重启                   |
| cache.staticTtl、ttlStrategy                                                                                                  | 已接入稀疏对象表单                      | “上下文与缓存预算”；重启               |
| planning.provider / model / thinking / maxOutputTokens / maxRequestBytes                                                      | 已接入规划 schema / ownedFields         | “主任务规划”；重启；已有 mode 命令即时 |
| summary.provider / model / thinking / strategy / maxOutputTokens / maxRequestBytes                                            | 已接入摘要 schema / ownedFields         | “摘要模型与预算”；重启                 |
| reviewer.thinking                                                                                                             | 已接入审批员 schema / ownedFields       | “审批模型与预算”；重启                 |
| provider.models[模型].api / thinkingLevels / rawToolArguments / prefixCompaction / outputParameter / thinkingMode / offEffort | 已接入 Record / Union schema 和字段投影 | OpenAI / Anthropic 模型能力 JSON；重启 |
| MCP maxAgeDays / maxStoredBytes / deduplicate / maxSearchChars                                                                | 已接入 MCP schema / ownedFields         | “MCP 结果预算”；重启                   |

表单只序列化所选原始层：例如只勾选 staticTtl，就只提交该键，不回填 enabled / ttl，
不主动开启 prefix 摘要、deduplicate 或 replay。已有未知字段（包括并行分支写入的字段）
在未被本 schema 拥有前保持原值且不展示。master 中的 loadConfigWithSources 已包含稀疏 cache
继承修复；本分支不复制其 loader。集成回归验证全局 enabled=false / ttl=5m、项目只改 staticTtl
后，enabled 仍为 false、ttl 仍为 5m，且打开设置不改变任意文件。

设置交互区分：外观以及“当前会话”的模型 / 权限模式 / 思考选择即保存，继续调用原后端命令；模型与思考在下一请求采用，模式不处理已有审批。连接组合、缓存费用选项、权限规则和其他结构化启动默认值显式提交并重启；其草稿放弃提醒不等于额外的工具授权。验收工具统一为 Node / Playwright。
