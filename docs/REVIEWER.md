# 严格模型审批员（可选 model-v2）

默认 reviewer 仍是 `model-v1`，旧 `AutoJudge` 和 `createModelReviewer` 兼容接口不切换行为。新能力 `model-v2` 来自 `agentlab.reviewer-strict`，必须显式选择：

```json
{
  "capabilities": { "reviewer": "model-v2" },
  "pluginConfig": {
    "agentlab.reviewer-strict": {
      "model": "",
      "timeoutMs": 30000,
      "maxRequestBytes": 32768,
      "maxResponseBytes": 8192,
      "maxOutputTokens": 256,
      "prefixCache": { "enabled": false, "ttl": "5m" }
    }
  }
}
```

`provider` 可指定一个已经注册的 provider ID；省略时使用当前主 provider。`model` 省略时沿用旧 `judgeModel` 配置；空字符串明确跟随当前主模型；非空字符串固定审批模型。选择独立 provider 时，必须确认模型名称和模型规格与该端点一致。上述配置不创建凭据或隐藏网络请求。设置修改在新会话生效，设置中的“严格审批模型状态”显示实际 provider/model、各自来源、当前是否选中及计数，而“严格审批模型配置”是下次启动配置。

## 严格输出与保守失败

模型必须只返回一个完整 JSON 对象，恰好有 `decision`、`reasonCode`、`reason` 三个字符串字段：

```json
{"decision":"deny","reasonCode":"user_prohibited","reason":"用户明确禁止该操作"}
```

- `decision` 只允许 `allow`、`ask`、`deny`、`unknown`。
- `reasonCode` 为最多 64 字符的小写字母/数字/下划线代码；`reason` 非空，最多 2048 字符，不含 ASCII 控制字符。
- 缺字段、额外字段、重复 JSON key、数组、markdown、JSON 外解释、非法类型和非法流事件均返回 `unknown`。
- 流必须从唯一的 `message_start` 开始，事件类型采用白名单，正文/思考/签名/打码片段及用量均校验字段类型。停止后只允许合法用量事件。回复必须以 `end_turn` 完整结束。截断、工具调用、重复消息边界、停止后的正文或未结束回复都不能产生批准。
- 超时、取消、provider 异常、输入/输出超预算也返回 `unknown`，由内核转成询问或 headless 的 `approval_required`。错误信息不暴露 SDK 响应、认证信息或底层异常正文。
- 只有 `policy.kind = review` 会发起请求。已有明确 `deny` 和强制 `ask` 保持原结果，不进入模型。

旧 facade 仍接受缺省 reason 的 `{"verdict":"allow"}` / `{"verdict":"ask"}`，保留旧判定轨迹；带非空 reason 的 deny 可保留拒绝能力，缺 reason 的 bare deny 仍是无效响应。严格能力使用新的三字段格式，不悄悄把旧格式解释成严格批准。

## 完整参数、来源与预算

静态 system 只包含审查规范，不含用户要求、工作目录、规则、参数或历史。可变内容在单独 JSON 消息内明确分为 operation、currentUserRequest、analysis、policy、provenance 和 context。真实当前要求来自运行时字段，不从 assistant/tool/summary 的声称推断授权；当前要求或 cwd 与历史上下文冲突时直接保守失败。

当前完整参数和真实用户请求不会截断。超出预算时不发送模型，不能裁掉尾部限制再批准。历史摘录仍携带原始来源、省略标记和执行结果，历史一次允许不会生成授权规则。

默认请求预算为 32 KiB，输出流预算为 8 KiB，模型输出上限为 256 tokens。已知模型使用其配置的上下文/输出规格作附加限制，并预留协议空间；字节数检查避免乐观使用字符数除以四，但并非厂商 tokenizer 的实测。模型规格未知时，完整参数超过 2000 字符或真实用户要求超过 8000 字符即不发请求。输出预算也计入 reasoning/signature 片段；不保存这些正文。model-v2 的已校验 timeout 同时传给审批员和内核外层 review deadline，任何一层取消或超时都会使结果失效。Provider 不响应取消时，宿主仍及时返回保守结果并丢弃迟到结果，无法承诺第三方服务已停止计费。

## 用量、取消与缓存

每次发起模型请求都产生同一 requestId 的 `model_request` / `model_usage`，用途固定为 `judge`，并保留运行时注入的 run/tool 关联。即使非合作 provider 超时也会终结一次用量快照。缺失或不完整用量不代表零费用；这里不计算价格。

没有审批结果缓存。同一个操作每次被 policy 委托时都会重新请求，换会话或清空历史也不会复用 allow。

唯一可选优化是 `prefixCache.enabled=true`：只建议 adapter 为静态 system 前缀使用缓存，TTL 默认 5 分钟。不会为动态 messages 设置缓存断点，也不跳过模型请求。是否支持、是否命中、如何计费仍由 provider adapter/服务决定；默认关闭，不静默增加缓存写入成本。

## 离线证据与限制

`tests/reviewer-contract.test.ts` 的 52 个测试使用 FakeProvider 或本地故障 provider 验证严格解析、deny/unknown、注入内容的分层与来源、完整参数及尾部限制、预算、超时/取消、独立 provider/model 来源、请求/用量关联和重复调用。另有 createAgent 配置级集成测试，验证独立 provider/model 的实际选择、受控写工具的完整链路和 run/tool/request 用量关联。

当前固定规范前缀实测为 1939 UTF-8 字节（913 字符）。两次不同用户要求和参数的离线请求使用字节一致的 system；只有可变 JSON 消息改变。启用前缀建议后仍是 2 次模型调用，决策缓存命中为 0。`getMetrics()` 提供请求数、请求/输出字节、静态前缀字节和前缀建议次数，可用于复现实验。

这些测试证明序列化、门控和协议行为，不证明真实模型抵抗提示注入的准确率，也不提供真实 API 延迟、缓存命中率或成本收益。未调用付费 API；上线前需要按目标 provider 单独验收。
