# 插件架构验收记录

日期：2026-10-08。所有模型验证使用 FakeProvider 或本地故障替身；没有真实 API 成本/延迟/准确率测试。

## 源码基准

- 改造前 master：`ec341e63f4d4771bbd6acaab65d46a87216c91d9`
- 改造前全量：23 个测试文件，292 通过、1 跳过；typecheck、build 通过
- 阶段一完整本地提交：`1ee4c9b96f5910eeed7030449fb1e81f08a452dd`
- 阶段一 tree：`8f9fd7b9104af982517759806fc1b6d9cb29e0fe`
- 阶段一独立审查：427 通过、1 跳过；typecheck、build、diffcheck 全部通过

远端使用 git-data API 按八个逻辑边界发布；作者/时间信息可能使 commit SHA 与本地不同，以逐个 tree SHA 核对源码一致性。阶段一和最终完整树才是完整验收点，中间阅读提交不承诺独立构建。

## 最终检查

运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`。最终完整回归与第二阶段独立复核均为 44 个测试文件，553 通过、1 跳过；typecheck、build、diffcheck 全部通过。独立复核另运行 13 个离线 shadow 样例，无错误或模型/工具调用。

唯一跳过项是仅原生 Windows 才运行的 cwd 大小写恢复测试。Linux 上的 Windows 字符串样例不能代替原生 Windows 验收；v2 原生 Windows 文件系统授予因此保守要求人工确认。

## 核心证据

- SDK/host：重复 ID/alias、依赖/版本/循环、原子注册、失败回滚、资源超时与逆序清理、不可变观察者和范围化依赖句柄
- 真正替换：独立 ESM 插件仅改配置替换 policy、no-op compactor、内存 SessionStore，新增工具、上下文、命令、设置及可选终端呈现
- 真实旧基线：从上述 ec341e63 checkout 录制六个场景；当前事件、最终历史、执行次数、reviewer 次数逐项相等。录制脚本和 JSON fixture 一同提交
- 执行门：最终参数/schema、身份/revision/环境/会话绑定、嵌套调用、取消、迟到响应、唯一结算、无 responder 终止、确定 deny/ask 不被模型覆盖
- 历史与持久化：摘要不能伪造用户授权；不合作 compactor 无迟到提交；v1 升级前保留非覆盖备份；锁/CAS/未知字段/安全状态/失败恢复；未知写入结果不重试，不提前释放 store
- 严格 reviewer：完整参数和真实用户要求、预算、严格 JSON/流协议、独立模型/provider 状态、用途与执行关联、超时/取消、无 allow 决策缓存
- Headless：对 pi-tui 和 CLI app 的加载设置失败探针，正常命令与会话列表仍通过

## 实际模型调用次数

`tests/policy-v2-runtime.test.ts` 用相同的真实内置写文件链路：

| 配置 | judge 调用 | 实际结果 |
| --- | ---: | --- |
| legacy auto，无旧 allow 规则 | 1 | 临时 src 文件成功改写 |
| 显式 v2 auto + writeRoots=[src] | 0 | 同样内容成功改写 |
| v2 的敏感 src/.env | 0 | 人工询问，拒绝后未写 |
| v2 未授权目录 | 1 | reviewer 要求人工，拒绝后未写 |

新增写入授权默认关闭，必须显式选择策略和范围。这不是“同等授权下任意操作都省一次模型”的结论，也不把原先 legacy 已允许的只读工具算作新增节省。

## Shadow

实际执行两种离线模式，均为 13 个选择样例、1 个附带明确范围授权和待人工审核标记的 allow 扩展、0 个评估错误、0 次 shadow 发起的模型调用。

该选择样例集的 modelEligible 总数为 v1 4、v2 4；v2 更保守的路径约束抵消了个别 grant 的减少，不据此声称整体成本下降。录制模式当前使用明确标注的合成协议 fixture，不冒充实测模型回答。实际模型事件按 agent/compact/judge 分别观测，缺失 usage 记为未知。

## 实际 PTY 与终端回归

除 MemoryTerminal 渲染/输入测试外，用编译后的 CLI 在真实 PTY 离线检查：

- 80×24：设置顺序/返回、审批无默认选项，空 Enter 不批准，Esc 拒绝后继续，退出恢复终端
- 40×12：v2 模式确认说明、取消不改变 auto、窄屏审批动作可见、详情/返回、Esc 拒绝及退出
- 自动测试额外覆盖 24×8、重复输入、焦点、草稿、队列、滚动和 renderer 异常

PTY 原始记录的 SHA-256 分别为 `ec25e5b1bb235bb678de0a4c5926c0b65f9938f04559bc7a03a69bc7b9d43ac0`、`7399150f09fe750ee605750cf5944efc4a3e304e7dbdc9f4575d6f503ffbbdcd`。录制只含临时 FakeProvider 项目。最终代码没有更改终端基础库。

## 独立审查所推动的修正

只读观察者不能成为审批 responder；不合作回调/执行/持久化的超时不能谎称清理成功；摘要 provenance 不能变成 user；分析器重验只接受严格 true；流中未知事件不能带来批准；worktree .git 指针与全部 Git 元数据必须受保护；重复 tool ID 的人工询问不能漏计；v2 UI 必须描述实际策略。

## 明确限制

所有实际原始 Shell 调用都不做确定性放行，字面量解析缓存只提供事实。没有 OS 沙箱、插件市场、在线安装器、任意热卸载、新增长期记忆产品或真实模型安全准确率保证。文件系统前提会重验，但不是针对恶意外部进程的原子隔离。

## PR #17 review 修复（2026-10-09）

本轮修复以远端 `356be066653eaba8a930f95218eaddd223bc6f67` 的源码树为基线；保持默认策略选择不变，不调用真实模型，不修改真实用户配置。

- 工具请求来源：公开入口与命令各自建立独立调用，不读取活动或已完成模型轮次的用户请求/历史；模型工具的子调用仅继承绑定的父上下文与取消信号。真实 strict reviewer 在缺少当前请求时要求人工确认，不发模型请求。
- 策略持久化身份：从实际选中的 CapabilityRecord 获取 canonical ID/version 缺省值，支持隐式 singleton、alias，以及共享 implementation 的多个记录；显式 Policy 身份保持有效，注册版本升级不能恢复旧授权；设置选择、执行审计和授权绑定哈希使用同一 canonical 缺省来源。
- 能力选择：配置 schema 和 PluginHost 运行时均拒绝未知或非 singleton 键，含 `polciy` 拼写错误；直接 JS/options.config 入口也不能静默使用默认策略。
- 压缩历史：真实用户消息按原始出现位置递增匹配；倒序或多出的副本降为 summary，合法重复原文仍可按序保留。
- 旧插件别名：注册与别名均事务暂存，完整 aliases 才提交到能力记录；插件失败和冲突不会留下半成品；deprecated loadPlugins 入口投射工具/别名时也采用同一原子事务。
- v2 精确授权：搜索跳过没有授权资格的 broad allow，继续查找 config/session 的 literal grant；deny、ask、敏感目标和不完整分析约束不变。
- 配置删除：通过显式 schema-owned 字段合同删除草稿省略的可选字段，同时保留未知字段、其他插件和顶层配置；不依赖 Zod 的内部 shape。

新增回归先在修复前复现失败，再验证修复后通过。验证仅使用已安装依赖及临时目录中的 FakeProvider/替身；当前环境的 pnpm 依赖自动检查尝试创建不存在的 home 路径而失败，因此使用同一 package.json 脚本对应的本地 Vitest、TypeScript 和 tsup 执行文件。

本轮最终全量结果：47 个测试文件，606 通过、1 个 native-Windows-only 跳过；`tsc --noEmit`、三入口 ESM build 与 `git diff --check` 全部通过。新增 53 个测试；既有测试断言保留。独立复审覆盖核心七项以及 legacy-loader alias 投射与 canonical 审计身份。
