/** 宿主实现选择的统一设置入口。提交即保存；重启后才重新装配活动能力。 */
import { definePlugin, type SettingsScope } from '../sdk/index.js';
import { createScopedConfigStores, type ConfigSnapshot } from '../runtime/config-store.js';
import type { PresetContext } from '../runtime/preset.js';
import { resolveAgentPaths } from '../core/paths.js';
import type { ConfigValueSource } from '../core/config.js';

function sourceMetadata(source: ConfigValueSource): ConfigValueSource {
  return { scope: source.scope, ...(source.path ? { path: source.path } : {}), directory: source.directory,
    ...(source.contributors ? { contributors: source.contributors.map(sourceMetadata) } : {}) };
}
export function runtimeSettingsPlugin(input: Pick<PresetContext, 'cwd' | 'capabilityChoices'> & Partial<Pick<PresetContext, 'paths' | 'configSources' | 'logPath'>>) {
  return definePlugin({ manifest: { id: 'agentlab.runtime-settings', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    const stores = createScopedConfigStores(input.cwd);
    const bases = new Map<SettingsScope, ConfigSnapshot>();
    const drafts = new WeakMap<object, { scope: SettingsScope; base: ConfigSnapshot; selections: Record<string, string | false> }>();
    ctx.provide.settings('capability-selection', {
      title: '插件实现与权限策略', order: 3,
      get description() { return '输入完成后 Enter 即保存；重启后生效。只编辑所选层的覆盖值；省略字段即删除本层选择并继承。内置权限策略优先执行明确规则；审批模型只处理策略委托的操作。当前会话已加载实现：' + JSON.stringify(input.capabilityChoices()); },
      applyMode: 'newSession', schema: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
      scopeTargets: stores.scopeTargets,
      read(signal, scope = 'project') {
        signal.throwIfAborted(); const base = stores.store(scope).readCapabilities(); bases.set(scope, base);
        return structuredClone(base.value);
      },
      draft(value, signal, scope = 'project') {
        signal.throwIfAborted();
        stores.store(scope); const base = bases.get(scope);
        if (!base) throw new Error('请先打开设置，再建立草稿。');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('能力选择必须是 JSON 对象。');
        const choices = input.capabilityChoices(); const selections: Record<string, string | false> = {};
        for (const [kind, selected] of Object.entries(value)) {
          if (!choices[kind]) throw new Error(`未知能力类别: ${kind}`);
          if (selected === false) {
            if (!['reviewer', 'cacheStrategy'].includes(kind)) throw new Error(`${kind} 是必需能力，不能关闭。`);
          } else if (typeof selected !== 'string' || !choices[kind].available.includes(selected)) throw new Error(`未加载的 ${kind} 实现: ${String(selected)}`);
          selections[kind] = selected;
        }
        const changes = [...new Set([...Object.keys(base.value), ...Object.keys(selections)])]
          .filter(kind => base.value[kind] !== selections[kind])
          .map(kind => `${kind}: ${base.value[kind] ?? '继承'} → ${selections[kind] ?? '继承'}`);
        const result = Object.freeze({ selections: Object.freeze(selections), changes, warning: '已保存的设置只在重启后生效；当前批准不会改变。' });
        drafts.set(result, { scope, base, selections }); return result;
      },
      commit(draft, signal, scope = 'project') {
        signal.throwIfAborted();
        if (!draft || typeof draft !== 'object' || !drafts.has(draft)) throw new Error('无效草稿，请重新打开设置。');
        const saved = drafts.get(draft)!;
        if (saved.scope !== scope) throw new Error('草稿作用域不匹配，请重新打开设置。');
        bases.set(scope, stores.store(scope).commitCapabilities(saved.base, saved.selections)); drafts.delete(draft);
      },
    });
    ctx.provide.settings('config-paths', {
      title: '配置路径与来源', order: 4, applyMode: 'newSession', schema: { type: 'object' },
      description: '启动时只读诊断。默认值 < 全局 < 本项目 < 本次会话；权限规则合并、能力按字段合并，插件参数按命名空间字段合并。这里不展示配置值或环境变量。',
      read(signal) {
        signal.throwIfAborted();
        return { precedence: ['default', 'global', 'project', 'session'], paths: { ...(input.paths ?? resolveAgentPaths(input.cwd)), ...(input.logPath ? { logPath: input.logPath } : {}) },
          sources: Object.fromEntries(Object.entries(input.configSources ?? {}).map(([key, value]) => [key, sourceMetadata(value)])) };
      },
    });
  } });
}
