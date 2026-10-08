/** 宿主实现选择的统一草稿入口。保存只影响下一会话，不热替换活动能力。 */
import { join } from 'node:path';
import { definePlugin } from '../sdk/index.js';
import { PluginConfigStore, type ConfigSnapshot } from '../runtime/config-store.js';
import type { PresetContext } from '../runtime/preset.js';
export function runtimeSettingsPlugin(input: Pick<PresetContext, 'cwd' | 'capabilityChoices'>) {
  return definePlugin({ manifest: { id: 'agentlab.runtime-settings', version: '1.0.0', apiVersion: 1 }, setup(ctx) {
    const store = new PluginConfigStore(join(input.cwd, 'agent.config.json'));
    let base: ConfigSnapshot | undefined;
    const drafts = new WeakMap<object, { base: ConfigSnapshot; selections: Record<string, string | false> }>();
    ctx.provide.settings('capability-selection', {
      title: '插件实现与权限策略', order: 3,
      description: '显式选择下一会话使用的实现。deterministic-v2 的 ask 优先于 allow；切换策略前运行 /policy-migrate 查看差异。model-v2 是严格审批协议，独立选择。旧策略会话不能自动跨策略恢复。',
      applyMode: 'newSession', schema: { type: 'object', additionalProperties: { type: ['string', 'boolean'] } },
      read(signal) {
        signal.throwIfAborted(); base = store.readCapabilities();
        return { ...Object.fromEntries(Object.entries(input.capabilityChoices()).map(([kind, value]) => [kind, value.selected])), ...base.value };
      },
      draft(value, signal) {
        signal.throwIfAborted();
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
        const result = Object.freeze({ selections: Object.freeze(selections), changes: Object.entries(selections).filter(([kind, selected]) => choices[kind]?.selected !== selected).map(([kind, selected]) => `${kind}: ${choices[kind]?.selected} → ${selected}`), warning: '只在重启/新会话生效；不会改变当前批准或自动迁移旧会话。v2 改变 ask/allow 优先级。' });
        drafts.set(result, { base, selections }); return result;
      },
      commit(draft, signal) {
        signal.throwIfAborted();
        if (!draft || typeof draft !== 'object' || !drafts.has(draft)) throw new Error('无效草稿，请重新打开设置。');
        const saved = drafts.get(draft)!; base = store.commitCapabilities(saved.base, saved.selections); drafts.delete(draft);
      },
    });
  } });
}
