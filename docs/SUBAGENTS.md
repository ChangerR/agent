# 子 agent：一个 loop，多份独立上下文

根 runtime 的 AgentSupervisor 管理单层子任务。默认 preset 的 `agentlab.subagents`
插件提供五个控制工具、`/agents`、`/agent-limit` 和设置入口。同步任务也是 spawn 后 wait，
底层继续使用同一个 AgentLoop 实现和唯一 ToolExecutor。

## 使用与控制面

```ts
const task = agent.agents.spawn({ task: '分析测试覆盖', name: '测试分析', readOnly: true });
const result = await agent.agents.wait(task.agentId, { runId: task.runId, timeoutMs: 30_000 });
console.log(result.timedOut, result.run.status, result.run.output);
const followup = agent.agents.send(task.agentId, '继续检查取消场景');
agent.agents.cancel(followup.agentId, followup.runId);
```

| 操作   | 工具         | 语义                                                           |
| ------ | ------------ | -------------------------------------------------------------- |
| spawn  | agent_spawn  | 立即返回稳定 agentId/runId；默认 fresh；仅根任务可调用         |
| send   | agent_send   | 运行时有限 FIFO，在安全边界处理；终态保留上下文、创建新 run    |
| wait   | agent_wait   | 可指定 run；完成早于订阅不丢失；超时仅停止等待                 |
| status | agent_status | 状态、活动、结果/错误、tokens；指定 agentId/runId 读取完整结果 |
| cancel | agent_cancel | 幂等；取消当前 run；旧终态 run 不影响后续任务                  |

send 落在已封口的完成边界时创建新 runId，并在实际结算后启动，不重入 loop。
无空位的新任务明确失败，没有隐式队列、DAG 或第二条同步执行链。
不能等待活跃的自己或祖先。等待者的 AbortSignal 不取消 child。
wait 和默认工具列表返回预览，有明确截断提示；SDK status、指定 run 的工具 status
以及 `/agents` 详情可读已保存的完整结果。

## 上下文和能力所有权

fresh 不复制父聊天历史；继承当前 provider/model/thinking 和必要系统、项目约束。
snapshot 深复制整个安全消息前缀，包括 thinking、签名、redacted 和完整工具块；
未回填的工具交换不会进入快照。每个 child 拥有自己的消息、上下文协调器、审批历史、
ToolExecutor、EventBus 和会话文件。新 run 跟随根当前模型，不需要额外子模型配置。

provider、工具、policy、reviewer、compactor、hooks、MCP 和其他能力实例由根宿主拥有，
child 借用；不递归 createAgent，不重读项目，也不关闭兄弟 MCP。受信任的进程内插件
可以直接访问操作系统；本功能不是 OS 沙箱。

## 权限和共享工作区

真实用户、模型 delegation、工具数据和 subagent 结果分别标记来源。委派文本不能变成
真实用户授权，审批的 currentUserRequest 保持真实用户入口绑定。压缩、审查和历史渲染
保留这些标签；子结果以数据消息进入父历史，不是系统指令。

child 使用父当前有效 policy 与 readOnly/allowedTools 的交集。
只读要求完整分析且所有 effect 为 read；工具自报 risk:read 不足以放行或获得读租约。
child 不能 spawn 后代或 send 转派给任何其他任务；只有根任务可以委派。地址操作核对当前根会话和 child 所有权。
父 deny/ask、一次性批准绑定、Bash AST 和 Windows 路径保护继续有效。
child 人工审批只批准当前 run 的本次调用，不记住或复制到兄弟/下一 run。

同工作区共享公平读写门：已验证读取并行，写入、执行或未知效果串行。
取得租约后再次验证审批绑定、配置和目标。受信任控制工具不占工作区锁；
在工作区工具内调用控制工具明确报错，避免持有写锁等待 child。
嵌套工具可借用租约；写租约下 sibling 必须顺序调用，不能 Promise.all 写入。
执行及整个借用子树未结算时不归还租约；读租约不能升级成写租约。

## 限制与保存设置

全树共享限制，每一层不会重置。默认值：

| pluginConfig 字段   |  默认值 | 含义                                                         |
| ------------------- | ------: | ------------------------------------------------------------ |
| maxRunning          |       2 | 全树正在运行或结算的 child，根不计入                         |
| maxDepth            |       1 | 固定为 1；child 不能再 spawn，配置不能放宽                   |
| maxTurns            |      16 | 每个 run 回合上限，同时受根 maxTurns 限制                    |
| timeoutMs           |  300000 | 每个 run 五分钟时限                                          |
| maxInbox            |      16 | 每个 child 的有限显式输入                                    |
| maxOutputChars      |  131072 | 每 run 累计模型文本、思考、工具 JSON、签名/redacted 字符预算 |
| previewChars        |    8192 | 回传父上下文与工具列表的预览                                 |
| maxAgents / maxRuns | 32 / 32 | 每会话 child 数 / 每 child 历史 run 数                       |

普通项目浏览由父任务抽查并总结，不强制创建 child。仅有独立且有收益的检查方向时按需委派，
默认最多两个 child 同时运行；父任务负责计划步骤、等待与汇总。child 直接执行分配范围并回传结果，
不请求独立规划器、不建立本地结构化计划，首次执行、follow-up 与恢复后的显式 send 均如此。
规划和任务控制工具不向 child 暴露，执行门也拒绝伪造调用；宿主 Supervisor 另检查委派来源，
即使工具白名单或深度配置试图放宽，也不能创建孙任务或转派。取消、进度、用量和终态继续记录。
计划的只读范围自动与 child 的 `readOnly` 取交集，不能向更宽权限的已有 child 追加任务。
拒绝会保留具体来源并阻止同计划自动重试或换 child 绕过。以上仍走原有 Supervisor 和执行门，
不增加任务队列或另一套调度框架。

达到输出硬预算保留已收文本，标 limited/truncated；不完整工具 JSON/签名不执行。
取消时工具部分结果保留在结果与 child 历史。预览截断可查看全文；硬预算之外的内容
没有被保存，不能声称存在完整结果。

配置放在 `pluginConfig["agentlab.subagents"]`，见 agent.config.example.json。
`/agent-limit` 单次选择就 CAS/原子保存本项目，保存成功才应用；Esc 或失败不应用。
`/settings` 的子 agent JSON 一次提交保存，没有 Save 页面或二次确认。
已有 run 的 inbox、回合、时限和输出预算冻结；新 run 使用新设置。
降低并发上限不会取消已有任务，但阻止超额新任务。

## 生命周期、事件、恢复和用量

状态为 queued/running/cancelling 与 completed/failed/cancelled/interrupted/limited。
自然结束父模型一轮保留后台 child。根取消、有效会话切换和退出取消所属树。
无效恢复目标先预检拒绝，不取消后台任务；切换门禁从预检保持到提交，结算并保存旧
执行后重新读取目标 CAS。失败清理暂存 child，不泄漏实例。
状态快照在切换和关闭期间仍可读取，所有权检查保留；控制操作继续拒绝，底栏不会因切换永久停用。
恢复旧 running 为 interrupted，不重放工具或自动请求模型；已结算的 cancelled 保持
真实终态。根和 child 分别原子持久化关联、历史、结果和终态，继续保留迟到保存保护。
初始 child 安全快照提交后才保存根关联并启动模型；同步取消也保存可恢复的空 child。
初始保存失败不重放任务；未知提交仍占容量，直到原始存储操作结算。结算后的显式
send 可以保存安全快照并启动新 run；取消、退出及迟到成功均以真实提交更新根关联。
`/sessions` 和 latest 只提供根会话，child 通过所属根的 `/agents` 查看。

取消是请求停止。工具、模型、iterator.return、analyzer、policy、reviewer、compactor
或 hook 不响应时保持 cancelling、容量和必要租约。退出等待有界并报告未结算；
共享宿主资源直到实际结算才释放，不自动重试未知提交。POSIX shell 取消进程组后代，
Windows 使用 taskkill /T /F；超时和取消均等实际 close 后结算。

child 的原始 text_delta/loop_end/session_restored 不混入父总线；专用 subagent_event
携带 agentId/runId/单调 seq，汇总各自状态、文本、usage 和完成。
完成主动通知所属父 loop，每 run 去重；父 inbox 满时结果仍可在控制面查看。
审批单独接入现有 FIFO，明确 child 名称、任务、操作；取消删除过期请求。
活动会在等待模型、正在思考、正在回复、执行具体工具、审核权限和压缩上下文之间更新。
父聊天用进度卡片跟随每个 run 的活动、最近工具和输出预览，卡片不进入父模型上下文。
父输入独立可用，`/agents` 列表与详情随事件刷新，支持完整结果、补充和取消。
底栏同时显示正在运行的 child 活动。
child 等人工审批时 Ctrl+G 在审批和父输入间切换；父 Enter 不批准 child，回到面板
仍需明确选择。草稿保持，root 自身审批继续使用现有确认行为。
headless 无审批 responder 时返回 approval_required，不等待不存在的界面。

模型请求关联 runId，usage 在每个独立 agent 按 requestId 去重，计入 agent/compact/judge。
迟到用量归原 run 和会话。界面区分根自身与全树合计，不估算美元成本。

## 验证和边界

tests/subagents.test.ts 使用 FakeProvider、临时 HOME/项目、假工具、定时器和真实工具
覆盖完整 runtime；tests/tool-scheduler.test.ts 检查读写、取消及嵌套租约。
CLI 用真实 pi-tui 渲染器测试。tests/subagents-pty.test.ts 复用仓库原样 pnpm dev、
util-linux script 和隔离离线插件，验证 Linux 真终端。Windows 路径回归仍使用现有
mock，本次没有在原生 Windows 真终端实测。

共享工作区不提供 worktree 或跨进程锁。第三方插件的裸文件访问不受 ToolExecutor
协调；首版没有分布式框架、自动续跑、跨根会话操作或依赖图。

参考：[Codex 协作工具](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)、
[pi subagent 示例](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent)、
[Claude Code 子 agent](https://code.claude.com/docs/en/sub-agents)。采用可寻址生命周期、
独立上下文、实时进度和取消，不复制整个框架。
