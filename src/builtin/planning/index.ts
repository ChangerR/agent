/** 默认规划策略：复杂请求先提出结构化计划，实施仍由原 loop 负责。 */
import { z } from 'zod';
import { definePlugin } from '../../sdk/index.js';
import type { RuntimeServices } from '../../runtime/services.js';
import type { PlannerInput, PlanningMode, PlanningStrategy } from '../../core/plan.js';
import { observedStream } from '../../core/provider.js';
import { collectStreamAsync } from '../../core/protocol/types.js';
import { createScopedConfigStores } from '../../runtime/config-store.js';
import { PLANNING_PLUGIN, PLAN_TOOLS } from './identity.js';
export { PLANNING_PLUGIN, PLAN_TOOLS } from './identity.js';
export const PlanningConfigSchema = z.object({
  mode: z.enum(['auto', 'only', 'off']).default('auto'),
});
const proposalSchema = z.object({
  goal: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(64),
});
/** 保持问答零额外请求；显式入口可以强制规划。语义兜底由模型的 plan_update 创建入口承担。 */
export function needsPlan(input: string): boolean {
  const actions =
    input.match(
      /实现|修复|重构|添加|测试|构建|部署|调查|分析|比较|验证|迁移|implement|fix|refactor|build|test|deploy|investigate|analy[sz]e|compare|verify|migrat/gi,
    ) ?? [];
  return actions.length >= 2 || (actions.length > 0 && (input.length > 100 || /\n/.test(input)));
}
export const planningStrategy: PlanningStrategy = {
  readTools: ['read_file', 'glob', 'grep'].map((name) => ({
    name,
    ownerPlugin: 'agentlab.local-tools',
  })),
  controlTools: [
    ...PLAN_TOOLS.map((name) => ({ name, ownerPlugin: PLANNING_PLUGIN })),
    ...['agent_spawn', 'agent_send'].map((name) => ({
      name,
      ownerPlugin: 'agentlab.subagents',
      planningSafe: false,
    })),
    ...['agent_status', 'agent_wait', 'agent_cancel'].map((name) => ({
      name,
      ownerPlugin: 'agentlab.subagents',
    })),
  ],
  async prepare(input: PlannerInput) {
    if (input.mode === 'off' || (input.mode !== 'only' && !input.force && !needsPlan(input.input)))
      return;
    const response = await collectStreamAsync(
      observedStream(
        input.provider,
        {
          model: input.model,
          thinking: input.thinking,
          maxTokens: 4096,
          system:
            '[agentlab planning] 为用户任务提出简洁可执行的计划。只输出 JSON {"goal":"目标","steps":["步骤"]}，2-8 步，每步有可验证结果。不要执行任务，不调用工具，不把子 agent 创建当作完成。使用用户的语言。',
          messages: [{ role: 'user', content: input.input }],
          tools: [],
        },
        input.signal,
        { events: input.events, purpose: 'agent', runId: input.runId },
      ),
    );
    input.signal.throwIfAborted();
    if (response.stopReason !== 'end_turn') throw new Error('规划未完整返回，未开始执行');
    const body = response.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    try {
      return proposalSchema.parse(
        JSON.parse(body.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '')),
      );
    } catch {
      throw new Error('规划结构无效，未开始执行；请重试 /plan auto <任务>');
    }
  },
};
const args = (input: Record<string, unknown>) =>
  typeof input.args === 'string' ? input.args.trim() : '';
export function planningPlugin(services: RuntimeServices, cwd: string) {
  const stores = createScopedConfigStores(cwd);
  let commandEpoch = 0;
  return definePlugin({
    manifest: { id: PLANNING_PLUGIN, version: '1.0.0', apiVersion: 1 },
    config: {
      schema: PlanningConfigSchema,
      defaults: { mode: 'auto' },
      ownedFields: ['mode'],
      applyMode: 'newSession',
    },
    setup(ctx) {
      services.configurePlanning(planningStrategy, ctx.config.value.mode as PlanningMode);
      ctx.provide.contextSource('planning-instructions', {
        getContext: () => [
          {
            id: 'planning',
            source: PLANNING_PLUGIN,
            stability: 'stable',
            text: '复杂多步骤工作须先有结构化计划再执行。若当前无计划，用 plan_update 的 goal/steps 创建；简单问答直接回答。计划修改使用 plan_status 的最新 revision 和稳定 stepId。实施前将步骤置 running，完成时提供具体 evidence。使用 agent_spawn.planStepId 关联任务，等 child 真实完成才可完成步骤。遇错如实 blocked，不把 loop 结束当作任务完成。',
          },
        ],
      });
      ctx.provide.tool('plan_status', {
        name: 'plan_status',
        description: '读取本 agent 的计划、最新 revision、步骤状态与 child 归属。',
        risk: 'read',
        isConcurrencySafe: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_input, context) {
          return {
            content: JSON.stringify(services.plan(context.invocation?.agentId).snapshot ?? null),
          };
        },
      });
      ctx.provide.tool('plan_update', {
        name: 'plan_update',
        description:
          '以最新 revision 更新计划。无计划时 goal/steps 创建。修订保留旧 id；完成须 evidence 且已有成功执行、children 全部完成。',
        risk: 'read',
        isConcurrencySafe: false,
        inputSchema: {
          type: 'object',
          properties: {
            revision: { type: 'integer', minimum: 0 },
            goal: { type: 'string', minLength: 1, maxLength: 2000 },
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string', minLength: 1, maxLength: 2000 },
                },
                required: ['title'],
                additionalProperties: false,
              },
            },
            stepId: { type: 'string' },
            status: { type: 'string', enum: ['running', 'blocked', 'completed'] },
            evidence: { type: 'string', maxLength: 2000 },
            reason: { type: 'string', maxLength: 2000 },
          },
          required: ['revision'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const plan = services.plan(context.invocation?.agentId);
          if (!plan.snapshot) {
            if (plan.mode === 'off')
              throw new Error('自动规划已关闭；使用 /plan auto 或 /plan only 开启');
            if (input.revision !== 0 || !input.goal || !Array.isArray(input.steps))
              throw new Error('Create requires revision 0, goal and steps');
            plan.create(
              String(input.goal),
              (input.steps as { title: string }[]).map((s) => s.title),
              plan.mode === 'only' ? 'only' : 'auto',
            );
          } else plan.update(input.revision as number, input as Parameters<typeof plan.update>[1]);
          return { content: JSON.stringify(plan.snapshot) };
        },
      });
      ctx.provide.command('plan', {
        description:
          '计划状态 | only/auto/off [任务] | pause/cancel | continue | execute | revise <方向>',
        async handler(input, context) {
          const value = args(input);
          const [op, ...parts] = value.split(/\s+/);
          const task = parts.join(' ');
          const plan = services.plan();
          if (!op) return { type: 'data', data: plan.snapshot ?? { mode: plan.mode } };
          const epoch = ++commandEpoch;
          const sessionId = services.session().id;
          if (['auto', 'only', 'off'].includes(op)) {
            if (
              task &&
              (services.loop().hasPendingActivity || services.agents().hasPendingActivity)
            )
              throw new Error('请先暂停当前轮次');
            const base = stores.store().read(PLANNING_PLUGIN);
            context.signal.throwIfAborted();
            stores
              .store()
              .commit(
                PLANNING_PLUGIN,
                base,
                { ...base.value, mode: op },
                { schema: PlanningConfigSchema, ownedFields: ['mode'] },
              );
            services.configurePlanning(planningStrategy, op as PlanningMode);
            if (task) {
              plan.clear();
              plan.force = true;
              await (context.run ?? services.run)(task);
            }
            return { type: 'text', text: `规划 ${op} 已保存本项目并应用` };
          }
          if (op === 'pause' || op === 'cancel') {
            services.stopPlan(
              op === 'pause' ? 'paused' : 'cancelled',
              op === 'pause' ? '用户暂停' : '用户取消',
            );
            return { type: 'text', text: op === 'pause' ? '计划已暂停' : '计划已取消' };
          }
          if (op === 'continue' || op === 'execute' || op === 'revise') {
            if (op === 'revise' && !task) throw new Error('/plan revise <新方向>');
            services.stopPlan('paused', '用户修改方向/继续');
            await Promise.all([services.loop().whenSettled(), services.agents().whenSettled()]);
            context.signal.throwIfAborted();
            if (epoch !== commandEpoch || sessionId !== services.session().id)
              throw new Error('规划操作已被更新的指令或会话取代');
            if (op === 'execute') plan.execute();
            else plan.resume();
            await (context.run ?? services.run)(
              op === 'revise'
                ? `按新方向修订现有计划，保留有效进度：${task}`
                : '继续当前计划；先检查已有结果和未完成步骤，不盲目重放操作。',
            );
            return { type: 'text', text: '计划轮次已结算' };
          }
          throw new Error(
            '用法: /plan [only|auto|off] [任务] | pause | cancel | continue | execute | revise <方向>',
          );
        },
      });
      let base: import('../../runtime/config-store.js').ConfigSnapshot | undefined;
      const drafts = new WeakMap<
        object,
        {
          base: import('../../runtime/config-store.js').ConfigSnapshot;
          mode: PlanningMode;
          sessionId: string;
        }
      >();
      ctx.provide.settings('planning', {
        title: '规划方式',
        order: 4,
        applyMode: 'nextRequest',
        description:
          'auto 自动规划后执行；only 只规划；off 关闭自动规划。单次提交即保存，不改变权限模式。',
        scopeTargets: stores.scopeTargets.filter((t) => t.scope === 'project'),
        schema: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['auto', 'only', 'off'] } },
          required: ['mode'],
        },
        read(signal) {
          signal.throwIfAborted();
          base = stores.store().read(PLANNING_PLUGIN);
          return { mode: services.plan().mode };
        },
        draft(value, signal) {
          signal.throwIfAborted();
          if (!base) throw new Error('请重新打开设置');
          const parsed = PlanningConfigSchema.parse(value);
          const draft = Object.freeze(parsed);
          drafts.set(draft, { base, mode: parsed.mode, sessionId: services.session().id });
          return draft;
        },
        commit(draft, signal) {
          signal.throwIfAborted();
          const saved = typeof draft === 'object' && draft ? drafts.get(draft) : undefined;
          if (!saved || saved.sessionId !== services.session().id)
            throw new Error('设置草稿已过期');
          stores
            .store()
            .commit(
              PLANNING_PLUGIN,
              saved.base,
              { ...saved.base.value, mode: saved.mode },
              { schema: PlanningConfigSchema, ownedFields: ['mode'] },
            );
          drafts.delete(draft as object);
          commandEpoch++;
          services.configurePlanning(planningStrategy, saved.mode);
        },
      });
      ctx.provide.tui('planning-ui', {
        entry: 'agentlab:planning-ui',
        kind: 'status',
        title: '计划',
      });
    },
  });
}
