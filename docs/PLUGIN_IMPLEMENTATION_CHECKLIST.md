# 插件架构实施与验收

基线：`ec341e63f4d4771bbd6acaab65d46a87216c91d9`（2026-10-08 重新 fetch 核验）。
依据：《ChangerR agent 插件系统设计方案》最终 DOCX。此清单记录验收证据，不把接口存在当成运行可替换。

## 阶段一

- [x] 1. 基线全量测试、类型、构建；稳定 FakeProvider 事件契约
- [x] 2. SDK、清单依赖与版本、注册事务、所有权/alias、生命周期回滚
- [x] 3. 默认 preset、provider/tools/MCP/skills 与旧插件兼容装配
- [x] 4. ToolExecutor 唯一入口、legacy policy/reviewer、最终批准绑定与 headless
- [x] 5. context/compactor/cache/model catalog 替换；内核历史校验
- [x] 6. SessionStore、版本化 envelope、遥测、通用命令/设置/TUI
- [x] 7. 外部 policy/no-op compactor/memory store/command+settings 插件，只改配置可用
- [x] 8. 独立审查与阶段一全量回归

## 阶段二

- [x] 9. 显式启用 deterministic-v2；ask/allow 冲突迁移报告
- [x] 10. 完整事实、路径/敏感文件/符号链接与有限 shell 分析；未知保守回退
- [x] 11. Reviewer 严格输出、预算、超时/取消、用途 usage、无 allow 决策缓存
- [x] 12. 离线 shadow、不执行工具、不新增付费模型请求、人工标注差异
- [x] 13. 最终独立审查，安全/并发/会话/窄终端及完整 test/typecheck/build

## 兼容与边界

默认仍为 legacy policy。v2 的 ask 优先于 allow 单独显式选择。配置启动只读，不改用户文件。
插件为可信同进程代码，类型化 API 不是 OS 沙箱。禁用/替换在新会话或重启生效。
重名不再隐式覆盖、无审批端明确终止、批准与最终参数/版本绑定、默认日志脱敏是明确行为变化。
已有公开旧路径可作为 deprecated façade；实际内核依赖图须排除 façade 后无具体内置实现依赖。

## 本地审查切分

1. 基线与 SDK/host；2. preset/legacy 装配；3. executor/policy/reviewer；4. context/cache/model；
5. store/telemetry；6. commands/settings/UI；7. deterministic-v2；8. reviewer/shadow/完整验收。

交付采用一个目标为 master 的 Draft PR，按设计边界组织八个远端审查提交。中间提交是阅读单元，不承诺可独立 cherry-pick 或逐个通过；阶段一完整树与最终完整树分别验收。不自动合并、不部署、不调用真实付费模型。

阶段一基准树：本地 1ee4c9b96f5910eeed7030449fb1e81f08a452dd，独立审查及完整测试 427 通过、1 项既有跳过；typecheck/build/diffcheck 全部通过。远端 git-data 提交的作者时间可能产生不同 commit SHA，以相同 tree SHA 核对。
阶段二最终证据见 [VALIDATION.md](VALIDATION.md)。
