# SDK 最终传输边界离线验证

本阶段新增两个测试文件，没有修改生产权限、缓存策略或日志。测试使用实际 provider 和实际 OpenAI/Anthropic SDK 序列化及 SSE 解析，仅把 fetch 换成内存响应；没有真实网络回退。脚本化模型行为用于验证执行链，不能证明真实模型任务质量或厂商缓存收益。此前 48 次真实请求及其版本记录保持原样，本目录单独记录后续离线阶段。

运行：`TRANSPORT_PREFIX_EVIDENCE=/tmp/transport-prefix-observations.jsonl pnpm exec vitest run tests/transport-prefix.test.ts`。应使用新的输出文件，避免 append 混入前次样本。正常测试不导出观测；显式开启时只写固定测试名及白名单计数、散列、前缀长度。完整请求只在测试进程内存中作断言。配置均为隔离项目、固定假 key、正常 auto 策略和真实模型审批插件。

## 指标定义

- `body.bytes/sha256` 和 `bodyPrefixBytes` 使用 fetch 实际收到的未改动 JSON 字符串的 UTF-8 字节。字节公共前缀可能在一个多字节字符内部结束，不等于 token 前缀或供应商缓存命中量。
- `parts` 将实际 JSON 解析后，分别重新序列化 system、非 system messages、tools 和其余 settings。`evidence` 对 reviewer 固定字段重新序列化。这些是结构投影指标，不是 wire 子串，字节数不能相加冒充完整 body 大小。
- `adjacent` 比较同一 fixture 内前一次任意角色的真实请求。`sameScope` 按 provider、角色和授权范围散列分组；散列由实际 loop.run 输入及 root/child actor 生成，不根据可能被压缩的上下文猜测。judge 还断言证据中的完整用户请求与 run 输入一致。分组仅供比较，不提供授权或批准缓存，也不是完整授权状态快照。当前用例固定权限配置，child 只读取且没有 child judge；扩展到同一 child 的新任务或 child judge 时必须补充实际子任务授权来源。
- observer 最多保存八个范围的最后请求和全局前一请求；每个原始请求最多 1MiB，另有结构投影和消息副本。超限报错，不截断。JSON 解析失败只返回固定错误，不回显正文。

## 实际发现及覆盖

OpenAI SDK 4.104.0 在 fetch 前使用缩进 JSON。仅用 adapter 的紧凑 JSON 哈希关联原始 body 会失败；测试现在仅在请求关联时重编码，观测仍使用真实缩进 JSON。Anthropic SDK 0.131 当前使用紧凑 JSON。

两个 provider 各覆盖计划更新、session 导入恢复、实际 ContextManager 压缩、同授权两次写入以及真实父子工具集合，共 44 次受控 fetch。计划更新保持 system/tools 内容；OpenAI 历史消息完全保留。Anthropic 默认缓存断点会移动，原始历史消息未必逐条相同，因此只在解释性断言中移除 cache_control 核对内容前缀，记录的字节指标始终不删字段。不能据此宣称 Anthropic wire 完全 append-only。

恢复后新用户输入建立新范围，使用 adjacent 核对恢复前缀，不伪称同授权。压缩通过实际 ContextManager 调用测试 compactor 后发出下一请求，历史前缀确实重置，system/tools 保持；测试不覆盖真实模型摘要质量，也没有模型 compactor 请求样本。写入走真实 analyzer → policy → reviewer → executor，磁盘字节严格等于 EXACT，0 人工，每个 provider 两次 judge。父级实际 spawn 受限 child，child 真实读取且只有 read_file 工具，0 人工/0 judge。

本次样本中 OpenAI judge 2 的全局相邻字节前缀为 102，同范围前缀为 4127；Anthropic 分别为 35 和 4076。这仅证明混入 main 请求会改变前缀比较结论，不代表真实缓存命中或跨 provider 性能差异。临时项目名参与请求散列，不应期待不同测试运行散列完全相同。

3 个 observer 回归另覆盖 UTF-8 字节比较、键顺序、白名单输出、错误正文不泄露、类型伪造、角色/授权范围隔离、LRU 淘汰、clear 和超限。原生 Windows 尚未运行；全量中的 Windows 条件跳过继续如实记录。
