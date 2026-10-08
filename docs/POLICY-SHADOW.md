# Policy v1 / v2 Shadow 与只读迁移预览

## 默认行为与安全界限

默认仍选择 `legacy-v1`。`agentlab.policy-shadow` 注册命令、设置和观察指标，但没有被选为 `legacy-shadow` 时不运行候选策略比较。

选用 `legacy-shadow` 后，真实执行仍以同一个 legacy controller、analyzer 和原始决策为准：

1. 捕获当前输入、配置/策略版本和权限状态。
2. 实际 legacy 策略只判定一次。
3. 在独立候选 controller 上做有界的本地 v2 分析与策略比较。
4. 原样返回实际 legacy 决定。候选 allow、错误、超时或观察回调错误都不能扩大真实许可。

Shadow 没有模型客户端、Reviewer 或工具执行入口，不发起模型请求、不执行候选操作。它也不重用历史 allow。它仍属于可信同进程代码，不是针对恶意插件的操作系统沙箱。

## 显式启用

项目配置可显式选择：

```json
{
  "capabilities": { "policy": "legacy-shadow" },
  "pluginConfig": {
    "agentlab.policy-shadow": { "timeoutMs": 1000, "maxRecords": 500 }
  }
}
```

启用、停用和更换实现于新会话生效。Shadow 保持 `legacy-v1` 的策略身份和版本用于会话兼容；注册选择 ID `legacy-shadow` 单独表示它的观测装配方式。切换到真正 `deterministic-v2` 是另一个明确选择，不能用 Shadow 结果代替审批，也不能隐式迁移已有会话的策略状态。

若用户明确授予 v2 某些项目目录的写入范围，可另外设置 `pluginConfig["agentlab.policy-deterministic-v2"].writeRoots`。默认是空数组；Shadow 不添加或保存授权。候选每次使用独立权限状态快照，不修改正在运行的 legacy 或 v2 controller。

## 同一命令用于终端与 headless

- `/policy-shadow` 或 `/policy-shadow summary`：是否启用、累计比较、保留窗口、按用途观察到的模型指标。
- `/policy-shadow records`：保留的对照记录。
- `/policy-shadow expansions`：所有仍在保留窗口内的“v2 allow / v1 非 allow”及逐条原因、人工审核标记。同时显示累计扩展数与已经丢弃的记录数。
- `/policy-migrate preview`：读取实际当前策略的 mode、会话规则和项目/全局合并规则；列出 allow/ask 优先级冲突、配置的写入范围，以及不能隐式迁移会话的提醒。

这些命令只读，不写配置、不迁移会话、不调用工具或模型。普通权限设置仍使用所选策略的实际 controller，不把候选快照接入运行状态。

## 比较记录和统计口径

每条记录包含工具名、最终参数哈希、可用的 run/tool/config/policy 关联 ID、两个策略的身份/版本、决定和 reasonCode，以及可用的确定性分析状态。默认不存工具正文或完整参数。

每个 v2 allow 且 v1 不 allow 的样例都有 `allowExpansion`：原 v1 结果、候选理由、可选的样例注解，以及固定的 `requires-human-review`。每条记录的 `executionAuthorized` 都是 `false`。

统计区分：

- `deterministicAllow`：策略阶段直接 allow。
- `modelEligible`：策略返回 review，有资格进入 Reviewer；这不表示已经发起模型请求。
- `humanAsk` / `deny`：策略要求人工确认或拒绝。
- `unknown` / `error`：额外的分析或评估质量维度，可与 review/ask 重叠，不能把所有列相加当成总样例数。

累计计数保留整次会话；完整记录按 `maxRecords` 保留最近窗口，报告明确指出已丢弃数量。需要长期审查时，应显式保存命令或离线输出；内存窗口不是完整持久化审计库。

模型指标只观察已经发生的 `model_request` / `model_usage`，按 `agent`、`compact`、`judge` 分开统计真实请求数、可用 token 用量和请求到结束的观察耗时。缺失 usage 不当作零费用：没有可靠字段时用 `null` / `unknown`，部分请求有 usage 时标 `partial`。旧事件生产者可能把缺失 usage 表示成全零；没有明确 reporting 标记的全零也按未知处理。

输入、输出、cache read、cache write 分开保留，避免把 provider 已归一化的输入字段再次相加。这里不推断供应商账单。没有真实模型调用的离线结果不能证明线上成本、准确率或延迟收益。

## 离线复现

```sh
pnpm exec tsx scripts/policy-shadow.ts --cwd .
pnpm exec tsx scripts/policy-shadow.ts --cwd . --recorded-reviewer-fixtures
```

脚本只读分析并向 stdout 输出 JSON；不会执行工具、写目标文件、写配置或请求模型。13 个选取样例覆盖项目读取、敏感/外部目标、字面量 Shell、项目脚本、动态 Shell、冲突规则、危险推送、精确写入规则、显式 `src` 写入范围、受保护 hook、未知 MCP 与 deny 优先级。

内置 provider/tool 标识在样例中作为已知录制元数据声明；真实 runtime 的 owner/version 必须由宿主赋值，不能把插件自称“只读”当成这种证据。

显式 `src` 授权样例会出现 `legacy review → v2 allow`，说明特定授权前提下的确定性分支差异。该样例注解不是对真实项目写入的用户批准。没有 `writeRoots` 配置时不得沿用此结论。

`--recorded-reviewer-fixtures` 只附带样例中预先提供的 Reviewer 结果，不请求模型，也不把结果改写成执行许可。当前内置附带值是明确标注的合成录制格式验收数据；它们不是实测模型回答。真实录制数据可经 `runOfflineShadow` API 传入，并仍需显式选择该模式。

## 源码与验收

- `src/builtin/policy-shadow/index.ts`：插件、独立候选快照、live v1 wrapper、命令和设置。
- `comparison.ts`：不可变数据对照、超时、扩展解释和统计。
- `metrics.ts`：按实际请求目的的 usage/耗时观察。
- `offline.ts`、`corpus.ts`：离线执行和选取样例。
- `scripts/policy-shadow.ts`：stdout CLI。
- `tests/policy-shadow.test.ts`：真实 runtime 中候选 allow 不能越过 v1 Reviewer deny；默认关闭、无副作用、超时/观测失败隔离、完整扩展解释、录制模式显式开启、缺失 usage 未知，以及 active controller 迁移预览。
