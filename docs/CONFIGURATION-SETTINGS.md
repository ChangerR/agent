# 分层配置设置与桌面适配盘点

## 基线与交付边界

本次从默认分支 `master` 的 `cb64528` 独立开发，未修改缓存增强分支。
该提交只有 TypeScript / Node.js 的 TUI，`package.json` 没有桌面脚本，
也没有 Electron、React 或 macOS 打包配置。

已有 Electron + React + 独立 Node worker 的桌面工作台在未合并的
[PR #45](https://github.com/ChangerR/agent/pull/45)，提交 `d2536c7`。
引入该依赖或等待其合并的选择尚待确认。因此，本次先交付可独立合入的配置入口，
**尚未交付桌面 UI 与 macOS 适配，也没有 macOS 实机验证或截图**。
没有新造 App、替换框架、连接用户电脑或调用真实模型。

## 真实 schema 的覆盖

新增入口都由 `AgentConfigSchema`、插件 `config.schema` 和 `ownedFields` 生成，
通过原有 `/settings` 通用编辑器发现。表中“重启”指退出 App / CLI 进程后重新启动；
创建新会话不承诺重新装配 provider 或插件。

| 入口                           | 已支持字段                                                                                                | 作用域 / 生效时间                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 主任务与模型连接（启动默认值） | provider、model、baseURL、apiKeyEnv、thinking、judgeModel                                                 | 用户 / 项目；重启                                   |
| 上下文与缓存预算               | maxTurns、compactThreshold、cache.enabled / ttl / escalateAfterMs                                         | 用户 / 项目；重启                                   |
| 权限与审批默认值               | permissionMode、permissions.allow / ask / deny                                                            | 用户 / 项目；重启；不处理已有审批                   |
| 配置文件与插件装配             | modelsFile、mcpConfig、pluginEntries、disabledPlugins                                                     | 用户 / 项目；重启；这里只编辑引用路径               |
| OpenAI 兼容适配器参数          | dialect                                                                                                   | 用户 / 项目；重启                                   |
| 严格审批模型参数               | provider、model、timeoutMs、maxRequestBytes、maxResponseBytes、maxOutputTokens、prefixCache.enabled / ttl | 用户 / 项目；重启                                   |
| MCP 结果参数                   | maxInlineChars                                                                                            | 用户 / 项目；重启                                   |
| 子任务参数                     | maxRunning、maxDepth、maxTurns、timeoutMs、maxInbox、maxOutputChars、previewChars、maxAgents、maxRuns     | 用户 / 项目；重启                                   |
| 规划参数                       | mode（auto / only / off）                                                                                 | 用户 / 项目；重启                                   |
| 本地工具参数                   | disabled                                                                                                  | 用户 / 项目；重启                                   |
| 日志参数                       | includeBodies                                                                                             | 用户 / 项目；重启；保留原默认值，不自动开启正文日志 |
| 既有插件实现选择               | capabilities                                                                                              | 复用原有受控入口                                    |
| 既有目录写入授权               | writeRoots                                                                                                | 只用策略插件的项目级专用入口，仍执行真实路径验证    |
| 既有会话控制                   | /sessions、/save、/new、/model、/think、/mode                                                             | 保留原会话管理和即时应用语义                        |

`models.json` 中各模型的 contextWindow / maxOutputTokens 仍通过文件维护；
本入口可以修改 modelsFile 引用，不会把模型规格臆造为新的顶层字段。
MCP 服务器的 command / args / env / url / headers 仍由原 MCP 文件维护，
没有新增任意文件编辑 API。MCP 连接状态继续使用已有只读入口。
当前 schema 没有独立 planner / summary 模型或 UI 外观配置，故不增加这些字段。
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

PR #45 的 main 已使用白名单 IPC、contextIsolation、sandbox、导航拦截、原生目录
选择和唯一工具执行器。它尚缺少以下适配；需先解决源代码依赖再实施：

- macOS 交通灯安全区、标题栏拖拽与按钮 / 输入的可交互区域。
- 应用菜单、Cmd+, 设置、Cmd+O 打开目录、Cmd+N 会话、编辑与缩放菜单。
- macOS 关闭窗口 / Dock 激活 / Quit 的 worker 保存生命周期。
- macOS 字体回退、系统暗色、窗口缩放、高 DPI、长路径与窄屏滚动。
- 现有 packager 的 darwin bundle 声明；随包 Node 的版本、架构和许可校验。
  不能在 Linux 构建时把 Linux Node 复制后冒充 macOS 包。
- 完整设置页面及受控 IPC：由 worker 根据 section ID、作用域和当前会话处理
  read / draft / commit，renderer 不提供文件路径、不直接调用磁盘。
- 未保存提醒、安全重置、保存失败、重启提示及项目 / 会话切换期间的草稿失效。

可复现检查：

```sh
pnpm typecheck
pnpm test --maxWorkers=2 --minWorkers=1
pnpm build
pnpm exec vitest run tests/configuration-settings.test.ts tests/runtime-settings-tui-autosave.test.ts
git diff --check
```

所有测试使用隔离 HOME、临时项目和固定假凭据。TUI 按键测试覆盖新入口的一次提交、
取消、失败反馈及重启采用，不代表 Electron UI 或 AppKit / WebView 实机验收。
后续只能在合法的独立 macOS 环境补充窗口、菜单、目录、Retina、系统暗色和未签名包
验证；不得连接或委派到用户电脑，不使用证书 / 公证密钥，不外发安装包。

## 与缓存任务的协调

本分支直接修改 `src/builtin/runtime-settings.ts`、`src/builtin/default-preset.ts`，
新增 `src/builtin/configuration-settings.ts`，并扩展设置测试。未修改
`src/core/config.ts`、provider / reviewer / MCP 的运行时 schema 或并行缓存分支。
并行任务若修改这些 schema / ownedFields，新字段可由现有扩展点进入设置目录；
特殊 apply 语义与新角色的说明仍需人工核对。合并时重点检查 default-preset 中
插件收集与 runtime-settings 注册位置，避免遗漏新增插件。
