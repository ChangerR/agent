# Bash 普通组合读取：语义、执行绑定与审查预算

## 复现与根因

基线是实际获取的 `master`：`2745436ef49d6a0ccbb2c4604de945dc69c69803`。
只在匿名临时目录生成 TypeScript 文件，将原命令的 `cd` 目标替换为该目录；未访问用户的 `/data` 路径。

```bash
cd <fixture-project> && ls -la && echo "---" && find src -type f -name '*.ts' | head -100 && echo "---" && wc -l $(find src -type f -name '*.ts') | tail -5
```

原分析器已使用 tree-sitter Bash AST，也认识条件列表、管道和 find 过滤参数；问题不是整个组合字符串缺少白名单：

- 没有 `cd` 的目录状态传播，故后续相对路径无法依此证明。
- `head -100`、`tail -5` 未被参数验证器当作旧式数字计数参数。
- 未证明 `wc` 最后一个未引用的命令替换。替换结果还有词拆分、通配和选项注入语义，不能简单把嵌套 `find` 当作普通安全字符串。
- 不完整分析仍累计了 find 遍历的路径效果、目标及身份环境；完整对象直接进入 reviewer JSON，再作为模型消息字符串二次转义。

基线本地 FakeProvider 测量（文件名 `module-0000.ts`，每文件一行；路径长度会影响字节数）：

| TS 文件数 | 命令 UTF-8 字节 | payload JSON 字节 | 完整 ChatRequest JSON 字节 |
| --------- | --------------: | ----------------: | -------------------------: |
| 200       |             173 |             82646 |                      89078 |
| 240       |             173 |             98526 |                     105678 |
| 300       |             173 |            122260 |                     130492 |

200 文件时，`analysis` 值 81492 字节，其中 environment 49111、effects 20204、targets 11481、evidence 512。environment 的 206 个路径键占 47676 字节，9 个 checkpoint 占 1075，5 个内部字段占 362。路径身份重复实际路径和 stat 信息（dev/ino/mode/nlink/size/mtime/ctime），效果及目标又重复同一批路径。完整请求移除 analysis 字段可减少 85382 字节；operation 仅贡献 491 字节。不是 82KB 命令，也不是执行结果塞进了审批。

这些数字复现同一量级，不把用户截图的 82920 字节冒充为已取得的原始请求。基线默认 reviewer 会在发送前返回 `request_budget`；仅本地测量 FakeProvider 曾临时使用更大采集上限以归因，无真实模型调用。

## 请求上限与配置来源

`src/builtin/reviewer-model/plugin.ts` 配置 schema 和 `model.ts` 构造默认均为：

- `maxRequestBytes = 32768`：完整序列化 ChatRequest 的请求上限。
- `maxResponseBytes = 65536`：回复字节上限。
- `maxOutputTokens = 8192`：回复 token 上限。

PR38（`69abf32`）扩大的是后两项，不是请求上限。因此 32768 在当前 master 也可正常出现，不能由截图断言用户运行旧版本。配置位于 `pluginConfig["agentlab.reviewer-model"]`，按内置默认、全局、项目、SDK 会话覆盖继承；用户显式持久配置也可能改变有效值。有模型规格时，还受模型上下文余量约束；未知模型还有命令/用户文本长度的保守前置限制。此修复没有改变任何默认预算、增加兼容配置或迁移。

## 支持范围与执行约束

新支持的普通形状：项目内字面量 `cd` 的单个全 `&&` 链；普通非递归 `ls`；stdin 管道的 head/tail 数字简写；`find [-P] <目录> -type f [-name <字面模式>] [-print]` 的隐式 AND 文件选择；将该选择作为 `wc` 最后一个未引用 `$()` 操作数；新组合中 cat/head/tail/wc 的普通字面量文件操作数。

基于 AST 验证，拒绝动态命令名、赋值、复杂替换、重定向和未支持表达式。find 的 `-name` 模式只证明普通字面字符与 `*`；更复杂模式回退。保留实际 find 的遍历顺序、文件标签、wc 数值和输出格式。

在 Linux 上，分析阶段仅检查文件系统元数据，不执行 find/wc 或用户子命令。授权之后：

1. 原始调用与完整分析仍经过 ToolExecutor 的重验证和审批绑定。
2. Bash 工具重建并比较完整受控契约，打开已验证的目录及匹配的普通文件；禁止末级链接，核对 dev/ino/mode/nlink，内容文件要求单硬链接。
3. 传递已打开描述符，固定可信程序与受控环境，去掉用户 PATH、启动脚本、函数、IFS、加载器等影响。find 通过目录描述符运行 `-P` 遍历，以 NUL 接收结果；每个输出必须属于已分析候选。
4. wc 只读取绑定文件描述符。在任何内容读取前验证完整参数集合，再恢复原文件名标签。字面量 cat/head/tail/wc 同样绑定内容操作数，保留原选项顺序、参数终止符和旧式数字参数。身份变化或新增候选失败关闭，不读取替换内容。结束时释放描述符。

原命令可以直接由规则放行，judge 不被调用。规则中的明确 deny/ask 仍优先。

以下变体不会冒充确定性安全：匹配文件名包含空白/换行/通配字符，替换结果形成前导 `-`，外部/敏感内容目标、硬链接、不可往返文件名字节、find `-exec`/`-delete`/`-L`、复杂 find 表达式、任意子命令或管道替换、引号/拼接改变替换语义、`cd -`、`cd` 的分号/或/管道控制流。`src/-dash.ts` 因有目录前缀，仍是普通操作数。find 遍历中发现的链接按 `-P` 排除；目录根链接不作确定性证明。

新 cd/替换组合中，尚未绑定内容操作数的 grep/rg/git，以及显式其他目录或递归 ls，同样回退。这是有意保留的语义边界，不把旧的静态路径能力推广到新目录状态。head/tail 显式 verbose 或未 quiet 的多文件头、wc 同一对象不同别名及换行标签、不同标签指向同一 find 根、根路径末尾斜线等输出细节未证明时也回退。带空白或前导 `-` 的字面量文件名经正确引用/`--` 后可以支持，这与动态 find 输出的词拆分约束不同。

新增描述符路径仅在 Linux 验收；macOS 不声称具备该新组合证明，Windows 保持原 PowerShell 路径。最大 768 个绑定描述符、96KiB 受控脚本，以及既有输入/AST/文件扫描上限都失败关闭。它不是任意 shell 的沙箱，也不冻结已授权文件本身的并发内容变化。

## 模型证据与完整审计分离

`shell-evidence.ts` 仅投影内置确定性 Bash 分析：路径字符串去重，项目目录前缀用精确字符串拼接索引，effects/targets/pathFacts 用索引引用。没有路径规范化、摘要替换或静默截断。原始命令、完整当前用户请求及授权来源、策略判决、未解析风险、raw/canonical 路径、存在性、文件类型、链接与硬链接事实仍可恢复。

逐文件 stat 身份及受控脚本留在内部完整 analysis，模型只接收对应哈希、数量和执行器约束说明；非路径环境事实保留。内部分析及实际工具调用的批准绑定没有改成模型投影。模型消息中 currentUserRequest 保留完整真实用户请求及来源，重复的 context.userRequest 改为明确的 userRequestRef；去重前的一致性校验不变，未删掉尾部限制或换成摘要。

最终代码下，220 文件加一个无法证明拆分安全的 `unsafe space.ts`，仍走真实 reviewer。本地受控测量：完整请求 27960 字节，payload 22553，analysis 21421；默认 32768 上限下 FakeProvider 收到请求并返回 ask。具体字节数会随路径和用户输入变化。正常安全目录则在 policy 直接通过，根本没有审批模型请求。很大的不可证明调用仍可明确返回 `request_budget`，不会为塞进预算省略路径或用户限制。

## 验收

`tests/bash-readonly-auto.test.ts` 使用真实 analyzer → policy → ModelReviewer → ToolExecutor，受控 provider 只返回 ask，人工响应器只拒绝。220/300 文件原形命令与直接 Bash 输出逐字对照，断言零人工、零 judge、`safe_read`；也覆盖过滤、链接、文件名、环境、绑定后目录替换、参数终止符、规则优先级、可逆证据及预算失败。

`tests/bash-readonly-pty.test.ts` 通过 util-linux PTY 原样启动 `pnpm dev`，复制真实源码/包定义，保留默认自动规划、auto 策略和 model reviewer。离线 provider 对单个明确操作的规划请求返回 null，再发出原命令，200+ 合成 TS 文件输出逐字一致，零 judge、零人工。随后同一 TUI 会话分别验证 reviewer 受控 allow 的真实写入、deny 的拒绝且无人工覆盖。规划请求与审批请求分开计数。固定模型判决验证执行链路，不证明真实模型语义判断能力；完整工作流与官方产品对照见 [Auto 权限验收](AUTO_PERMISSION_REVIEW.md)。

旧测试按当前 master 契约更新：执行专项剧本隔离无关规划或识别规划请求；ask 的确定性兜底现为 reviewer；人工复用回归让受控 reviewer 明确返回 ask，继续断言精确授权、目标变化重新询问、拒绝不执行；截断回归使用真正不完整 JSON。未修改 Plan/subagent/Windows 生产行为。

复验命令：`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`。Linux 真实 PTY 在全量测试中运行。原生 Windows/macOS 执行未在此 Linux 环境验收；现有跨平台策略回归仍运行。独立审查复核了支持边界、输出、描述符绑定与证据可逆性，首轮新增 51 项回归全部通过，无剩余阻断意见；扩展后的测试与审查另行记录。

首轮 Linux 验收结果：格式、类型、构建通过；全量 74 个测试文件通过，1376 项通过、2 项既有 Windows 原生专用测试按平台跳过。第一次并发全量运行还触发了一次原有 100ms session persistence 超时，未改生产行为或调大超时；该专项和首轮最终全量均通过。`tests/auto-fallback.test.ts` 的首轮修改仅修正一处基线 Prettier 折行，扩展阶段另增加完整用户请求引用断言。
