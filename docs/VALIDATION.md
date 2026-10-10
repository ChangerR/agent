# 当前架构验收

本文件规定当前源码树的验收范围，不将历史版本的通过计数当作本次验证结果。最终运行结果应以本次 PR 的检查记录为准。所有模型验证使用 FakeProvider 或本地故障替身，没有真实 API 成本、延迟或准确率测试。

## 完整检查

运行 `pnpm test`、`pnpm typecheck`、`pnpm build` 和 `git diff --check`。全部回归统一走 Vitest；`pnpm test tests/cli-pty.test.ts` 可单独复现 Linux 真 PTY。该专项依赖 util-linux `script`，缺失明确失败，非 Linux 明确跳过。

## 核心证据

- SDK/host：重复 ID/alias、依赖版本与循环、原子注册、失败回滚、资源超时和逆序清理、不可变观察者与范围化依赖。
- 能力替换：独立 ESM manifest/setup 插件只改 pluginEntries/capabilities，即可替换 policy、compactor、SessionStore 并增加工具、命令和设置。
- 默认装配：唯一内置确定性策略和严格审批员，ask 为默认模式；配置不接受历史插件入口或运行设置别名。
- 执行门：最终参数/schema、身份/revision/环境/会话绑定、嵌套调用、取消、迟到响应、唯一结算、无 responder 终止、确定 deny/ask 不被模型覆盖。
- 策略：deny/ask 优先、精确授权、显式 writeRoots、敏感文件、路径与链接、未知工具及 Shell 保守处理；模型调用次数由真实 runtime 事件验证。
- 会话：只接受当前格式；完整 provider/endpoint 和 policy 身份；缺失或不兼容安全状态拒绝恢复；锁/CAS、未知字段、失败恢复、删除/重建约束。
- 历史：摘要不能伪造真实用户来源；用户消息按原始顺序匹配；不合作 compactor 不提交迟到结果。
- reviewer：完整参数与真实用户要求、严格 JSON/流协议、预算、独立模型/provider 来源、用途与执行关联、超时/取消、无批准结果缓存。
- 设置：项目默认作用域、一次提交自动保存、Esc 不保存未提交输入、全局/项目覆盖、重启提示、CAS 冲突和安全错误。
- `.env`：项目根加载、进程环境优先、显式 apiKeyEnv 不回退、不暴露 key、provider 端点与凭据身份绑定。
- Shell：原始 `ls -la && echo "---" && cat package.json` 通过真实 runtime 和 pnpm dev PTY 验证实际 stdout 与 judge/人工次数，并在保存 auto 后重启复验；不能用内置 grep/glob 的通过数量代替 shell 可用性证据。
- Headless/TUI：命令不加载 pi-tui；内存终端检查窄屏、焦点、详情、审批、队列和 renderer 异常；Linux 真 PTY 复用原 package.json/dev 与逐文件哈希一致的源码，验证单选自动保存、Esc 不保存、重启，以及真实工具失败和运行中取消后的再次请求。

## 明确限制

Linux 上的 Windows 字符串测试不能代替原生 Windows 验收；原生 Windows 文件系统授予保守要求人工确认。Bash 仅对完整验证的只读执行计划确定性放行；动态展开、未知参数及不支持的仓库配置仍需审批。本轮 Shell 运行证据来自 Linux，不等于 macOS 或 Windows 实机验收。

没有 OS 沙箱、在线插件安装器、任意热卸载或真实模型安全准确率保证。文件系统前提会重验，但不是针对恶意外部进程的原子隔离。缺失用量记为未知，不声称零费用。明确目录授权的确定性放行不能推导为任意任务都降低成本。
