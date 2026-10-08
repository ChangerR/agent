# 插件架构实施与验收

基线：`ec341e63f4d4771bbd6acaab65d46a87216c91d9`（2026-10-08 重新 fetch 核验）。
依据：《ChangerR agent 插件系统设计方案》最终 DOCX。此清单记录验收证据，不把接口存在当成运行可替换。

## 阶段一

- [ ] 1. 基线全量测试、类型、构建；稳定 FakeProvider 事件契约
- [ ] 2. SDK、清单依赖与版本、注册事务、所有权/alias、生命周期回滚
- [ ] 3. 默认 preset、provider/tools/MCP/skills 与旧插件兼容装配
- [ ] 4. ToolExecutor 唯一入口、legacy policy/reviewer、最终批准绑定与 headless
- [ ] 5. context/compactor/cache/model catalog 替换；内核历史校验
- [ ] 6. SessionStore、版本化 envelope、遥测、通用命令/设置/TUI
- [ ] 7. 外部 policy/no-op compactor/memory store/command+settings 插件，只改配置可用
- [ ] 8. 独立审查与阶段一全量回归

## 阶段二

- [ ] 9. 显式启用 deterministic-v2；ask/allow 冲突迁移报告
- [ ] 10. 完整事实、路径/敏感文件/符号链接与有限 shell 分析；未知保守回退
- [ ] 11. Reviewer 严格输出、预算、超时/取消、用途 usage、无 allow 决策缓存
- [ ] 12. 离线 shadow、不执行工具、不新增付费模型请求、人工标注差异
- [ ] 13. 最终独立审查，安全/并发/会话/窄终端及完整 test/typecheck/build

## 兼容与边界

默认仍为 legacy policy。v2 的 ask 优先于 allow 单独显式选择。配置启动只读，不改用户文件。
插件为可信同进程代码，类型化 API 不是 OS 沙箱。禁用/替换在新会话或重启生效。
重名不再隐式覆盖、无审批端明确终止、批准与最终参数/版本绑定、默认日志脱敏是明确行为变化。
已有公开旧路径可作为 deprecated façade；实际内核依赖图须排除 façade 后无具体内置实现依赖。

## 本地审查切分

1. 基线与 SDK/host；2. preset/legacy 装配；3. executor/policy/reviewer；4. context/cache/model；
5. store/telemetry；6. commands/settings/UI；7. deterministic-v2；8. reviewer/shadow/完整验收。

实施阶段仅本地提交。发布需另行授权；不合并、不部署、不调用真实付费模型。
