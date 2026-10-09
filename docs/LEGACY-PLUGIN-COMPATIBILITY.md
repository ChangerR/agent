# 旧插件加载兼容

旧 `loadPlugins(plugins, context)` 入口仍可使用，内部现在通过 `PluginHost` 和旧插件适配器执行完整注册事务。已有工具和 provider 作为显式种子依赖暴露给后续插件；全部 setup 成功、冲突与冻结状态检查通过后，才提交新工具、provider 和 hook。重复名称不再覆盖原实现。

调用方的 hook 接收端必须提供原子批次接口。原来只传 `hooks: { register: (...) => runner.register(...) }` 的调用方，请改为 `hooks: runner.registrationSink()`，也可直接传 `HookRunner` 实例。旧插件不注册 hook 时仍接受原有上下文。无法回滚的自定义注册函数在真正提交 hook 前会明确报错，其他能力也不会留下部分写入。

适配后的旧插件可使用可选的 `ctx.onDispose?.(cleanup)`，在分配资源后立即登记清理。这样即使后续 `register` 抛错也能清理，避免只能依赖 register 成功返回 disposer 的空窗期。`ctx.withResource?.(resource, cleanup, initialize)` 同样先登记再初始化。

新插件应使用 SDK 中按阶段推断载荷与返回值的 `ctx.hooks.register`。只有 `PreToolUse` 可以返回参数改写或 veto；其他通知型 hook 没有审批返回值。旧宽松 handler 类型只保留在兼容入口。
