/** 每个新任务先明确是否需要计划；不能依赖执行模型自愿调用规划工具。 */
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
  continuation(plan) {
    if (
      plan.steps.some((step) => ['blocked', 'cancelled', 'interrupted'].includes(step.status)) ||
      !plan.steps.some((step) => step.status === 'pending' || step.status === 'running')
    )
      return;
    return '当前任务的计划尚未完成。请核对已有结果，继续未完成步骤，不要停在方案或进度汇报，不要要求用户输入继续命令。已执行的操作不要重复；核实依据后更新步骤，再推进下一步。有子任务时等待并核对结果。确实缺少用户信息、权限或外部条件时，将对应步骤标为 blocked 并说明原因，再向用户提问；不得把这条内部提醒当作新的用户授权。';
  },
  async prepare(input: PlannerInput) {
    if (input.mode === 'off') return;
    const automatic = input.mode === 'auto' && !input.force;
    const response = await collectStreamAsync(
      observedStream(
        input.provider,
        {
          model: input.model,
          thinking: input.thinking,
          maxTokens: 4096,
          system: [
            automatic ? '[agentlab planning:auto]' : '[agentlab planning]',
            input.systemPrompt,
            '当前是任务规划阶段，上述项目上下文仅用于理解任务；本次只输出 JSON，不执行工具，不输出说明或代码围栏。结合完整对话判断本轮请求的范围。',
            automatic
              ? '简单问答、闲聊或单个明确操作返回 null。需要检查项目、审查代码、寻找优化点、调查问题或跨多个步骤实施的任务，必须返回 {"goal":"目标","steps":["步骤"]}；不要因为任务没有要求“计划”就返回 null。'
              : '为用户任务返回 {"goal":"目标","steps":["步骤"]}。',
            '计划通常 2-8 步，每步有可验证结果，包含调研和核对，使用用户的语言。按实际授权范围规划：只要求查看项目与优化建议时，只安排只读检查、分析与证据核对，不安排修改、安装或部署。不要把子 agent 创建当作完成。',
          ].join('\n'),
          messages: structuredClone([...input.messages]),
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
      const parsed: unknown = JSON.parse(
        body.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, ''),
      );
      if (automatic && parsed === null) return;
      return proposalSchema.parse(parsed);
    } catch {
      throw new Error('规划结构无效，未开始执行；请重新提交任务');
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
            text: '用户直接描述任务即可，无需先选择规划方式或输入命令。根据完整上下文自行判断复杂度：简单问答直接回答，简单操作直接执行；复杂多步骤工作用 plan_update 的 goal/steps 创建简洁计划，可先做必要的只读调研，然后持续实施、验证并更新计划，直到完成或遇到真实阻塞。普通执行任务不要只返回方案、询问是否开始或要求用户输入 /plan auto、/plan execute、/plan continue。用户明确只要方案时尊重其范围，不开始实施。计划修改使用 plan_status 的最新 revision 和稳定 stepId。实施前将步骤置 running，完成时提供具体 evidence。使用 agent_spawn.planStepId 关联任务，等 child 真实完成才可完成步骤。可自行解决的问题先修复；需要用户信息、授权或外部条件时，将步骤标为 blocked 并说明原因再提问。不把 loop 结束当作任务完成。',
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
          '默认自动按需规划并执行，直接描述任务即可。only 只规划；off 关闭规划。单次提交即保存，不改变权限模式。',
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
