/** 工具、命令与设置走现代插件契约，资源所有权由通用 supervisor 管理。 */
import { z } from 'zod';
import { definePlugin, type ToolContext, type CommandResult } from '../../sdk/index.js';
import type { RuntimeServices } from '../../runtime/services.js';
import {
  DEFAULT_SUBAGENT_LIMITS,
  type SpawnAgentInput,
  type SubagentLimits,
} from '../../runtime/subagents.js';
import { createScopedConfigStores, type ConfigSnapshot } from '../../runtime/config-store.js';
import { SUBAGENT_PLUGIN, SUBAGENT_TOOLS } from './identity.js';
import type { SubagentRecord } from '../../core/agents.js';
const integer = (max: number, value: number) => z.number().int().min(1).max(max).default(value);
export const SubagentConfigSchema = z
  .object({
    maxRunning: integer(16, DEFAULT_SUBAGENT_LIMITS.maxRunning),
    maxDepth: integer(4, 1),
    maxTurns: integer(128, 16),
    timeoutMs: integer(3_600_000, 300_000),
    maxInbox: integer(64, 16),
    maxOutputChars: integer(1_048_576, 131_072),
    previewChars: integer(65_536, 8_192),
    maxAgents: integer(64, 32),
    maxRuns: integer(64, 32),
  })
  .refine(
    (value) => value.previewChars <= value.maxOutputChars,
    'previewChars exceeds maxOutputChars',
  );
const textSchema = { type: 'string', minLength: 1, maxLength: 16_384 };
const address = {
  agentId: { type: 'string', minLength: 1 },
  runId: { type: 'string', minLength: 1 },
};
const json = (data: unknown) => ({ content: JSON.stringify(data) });
function previews(records: SubagentRecord[], limit: number): SubagentRecord[] {
  return records.map((record) => ({
    ...record,
    runs: record.runs.slice(-1).map((run) => {
      if (run.output.length <= limit) return run;
      return {
        ...run,
        truncated: true,
        output:
          run.output.slice(0, limit) +
          '\n[结果已截断；agent_status 指定 agentId/runId 或 /agents 查看完整结果]',
      };
    }),
  }));
}
const args = (input: Record<string, unknown>) =>
  typeof input.args === 'string' ? input.args.trim() : '';
export function subagentsPlugin(services: RuntimeServices, cwd: string) {
  const stores = createScopedConfigStores(cwd);
  return definePlugin({
    manifest: { id: SUBAGENT_PLUGIN, version: '1.0.0', apiVersion: 1 },
    config: {
      schema: SubagentConfigSchema,
      defaults: { ...DEFAULT_SUBAGENT_LIMITS },
      ownedFields: Object.keys(DEFAULT_SUBAGENT_LIMITS),
      applyMode: 'newSession',
    },
    setup(ctx) {
      services.configureAgents(ctx.config.value as unknown as SubagentLimits);
      const tools: Record<
        string,
        {
          description: string;
          properties: Record<string, unknown>;
          required: string[];
          execute(
            input: Record<string, unknown>,
            context: ToolContext,
          ): Promise<ReturnType<typeof json>>;
        }
      > = {
        agent_spawn: {
          description:
            '启动独立上下文子任务，立即返回 agentId/runId。默认 fresh 并继承当前模型；同步结果用 agent_wait。委派不会扩大真实用户授权。',
          properties: {
            task: textSchema,
            planStepId: { type: 'string', minLength: 1 },
            name: { type: 'string', maxLength: 80 },
            context: { type: 'string', enum: ['fresh', 'snapshot'] },
            readOnly: { type: 'boolean' },
            allowedTools: { type: 'array', items: { type: 'string' } },
            maxTurns: { type: 'integer', minimum: 1 },
            timeoutMs: { type: 'integer', minimum: 1 },
          },
          required: ['task'],
          async execute(input, context) {
            return json(
              services.agents().spawn(input as unknown as SpawnAgentInput, context.invocation),
            );
          },
        },
        agent_send: {
          description:
            '补充子任务文本：运行中 FIFO 在安全边界处理；终态任务保留上下文并创建新 runId。',
          properties: { agentId: address.agentId, message: textSchema },
          required: ['agentId', 'message'],
          async execute(input, context) {
            return json(
              services
                .agents()
                .send(String(input.agentId), String(input.message), context.invocation),
            );
          },
        },
        agent_wait: {
          description:
            '等待指定 run（省略用最新 run）。已经完成的结果不丢失；超时只停止等待，不取消 child。',
          properties: {
            ...address,
            timeoutMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
          },
          required: ['agentId'],
          async execute(input, context) {
            const result = await services.agents().wait(
              String(input.agentId),
              {
                runId: input.runId as string | undefined,
                timeoutMs: input.timeoutMs as number | undefined,
                signal: context.signal,
              },
              context.invocation,
            );
            const limit = services.agents().settings.previewChars;
            if (result.run.output.length > limit) {
              result.run.output =
                result.run.output.slice(0, limit) +
                '\n[结果已截断；agent_status 指定 runId 或 /agents 查看完整结果]';
              result.run.truncated = true;
            }
            return json(result);
          },
        },
        agent_status: {
          description:
            '查看所属会话的任务、活动、结果/错误和 tokens。指定 agentId/runId 可以查看完整结果。',
          properties: address,
          required: [],
          async execute(input, context) {
            if (input.runId && !input.agentId) throw new Error('runId requires agentId');
            const records = services
              .agents()
              .status(
                input.agentId as string | undefined,
                input.runId as string | undefined,
                context.invocation,
              );
            return json(
              input.runId ? records : previews(records, services.agents().settings.previewChars),
            );
          },
        },
        agent_cancel: {
          description: '幂等取消子任务或指定 run，保留部分输出。cancelling 表示实际执行尚未结算。',
          properties: address,
          required: ['agentId'],
          async execute(input, context) {
            return json(
              previews(
                [
                  services
                    .agents()
                    .cancel(
                      String(input.agentId),
                      input.runId as string | undefined,
                      context.invocation,
                    ),
                ],
                services.agents().settings.previewChars,
              )[0],
            );
          },
        },
      };
      for (const name of SUBAGENT_TOOLS) {
        const tool = tools[name]!;
        ctx.provide.tool(name, {
          name,
          description: tool.description,
          risk: 'read',
          isConcurrencySafe: true,
          inputSchema: {
            type: 'object',
            properties: tool.properties,
            required: tool.required,
            additionalProperties: false,
          },
          execute: tool.execute,
        });
      }
      ctx.provide.command('agents', {
        description: '查看子任务列表/详情，send 补充，cancel 取消，spawn 创建',
        handler(input, context) {
          context.signal.throwIfAborted();
          const parts = args(input).split(/\s+/).filter(Boolean);
          if (!parts.length) return { type: 'data', data: services.agents().status() };
          const [operation, id, ...rest] = parts;
          if (operation === 'spawn')
            return {
              type: 'data',
              data: services.agents().spawn({ task: parts.slice(1).join(' ') }),
            };
          if (operation === 'send' && id && rest.length)
            return { type: 'data', data: services.agents().send(id, rest.join(' ')) };
          if (operation === 'cancel' && id && rest.length <= 1)
            return { type: 'data', data: services.agents().cancel(id, rest[0]) };
          if (parts.length === 1)
            return { type: 'data', data: services.agents().status(operation) };
          throw new Error(
            '用法: /agents [agentId] | spawn <任务> | send <agentId> <文本> | cancel <agentId> [runId]',
          );
        },
      });
      const definition = {
        schema: SubagentConfigSchema,
        ownedFields: Object.keys(DEFAULT_SUBAGENT_LIMITS),
      };
      ctx.provide.command('agent-limit', {
        description: '选择全树并发上限，自动保存本项目后应用',
        async handler(input, context): Promise<CommandResult> {
          const store = stores.store();
          const base = store.read(SUBAGENT_PLUGIN);
          const sessionId = services.session().id;
          const request = {
            type: 'interaction' as const,
            id: 'agent-limit',
            prompt: '子 agent 并发上限 · 本项目 · 选择即保存',
            initialValue: String(services.agents().settings.maxRunning),
            choices: [1, 2, 4, 8, 16].map((n) => ({ id: String(n), label: `${n} 个` })),
          };
          const value =
            args(input) || (context.interact ? await context.interact(request) : undefined);
          if (value === undefined)
            return context.interact ? { type: 'text', text: '已取消' } : request;
          const parsed = SubagentConfigSchema.parse({
            ...services.agents().settings,
            maxRunning: Number(value),
          });
          context.signal.throwIfAborted();
          if (services.session().id !== sessionId) throw new Error('会话已变化，请重新选择。');
          store.commit(
            SUBAGENT_PLUGIN,
            base,
            { ...base.value, maxRunning: parsed.maxRunning },
            definition,
          );
          services.configureAgents({ maxRunning: parsed.maxRunning });
          return {
            type: 'text',
            text: `已保存本项目并应用：全树最多 ${parsed.maxRunning} 个运行 child；正在执行的任务继续结算。`,
          };
        },
      });
      let base: ConfigSnapshot | undefined;
      const drafts = new WeakMap<
        object,
        { base: ConfigSnapshot; value: SubagentLimits; sessionId: string }
      >();
      ctx.provide.settings('subagents', {
        title: '子 agent 限制',
        order: 5,
        applyMode: 'nextRequest',
        scopeTargets: stores.scopeTargets.filter((target) => target.scope === 'project'),
        description:
          '单次提交自动保存并应用到新任务；已有 run 的硬限制保持。/agent-limit 单选保存并发上限。',
        schema: { type: 'object' },
        read(signal) {
          signal.throwIfAborted();
          base = stores.store().read(SUBAGENT_PLUGIN);
          return { ...services.agents().settings };
        },
        draft(value, signal) {
          signal.throwIfAborted();
          if (!base) throw new Error('请重新打开设置');
          const parsed = SubagentConfigSchema.parse(value);
          const draft = Object.freeze({ ...parsed });
          drafts.set(draft, { base, value: parsed, sessionId: services.session().id });
          return draft;
        },
        commit(draft, signal) {
          signal.throwIfAborted();
          const saved = typeof draft === 'object' && draft ? drafts.get(draft) : undefined;
          if (!saved || saved.sessionId !== services.session().id)
            throw new Error('设置草稿已过期');
          stores.store().commit(SUBAGENT_PLUGIN, saved.base, saved.value, definition);
          drafts.delete(draft as object);
          services.configureAgents(saved.value);
        },
      });
      ctx.provide.tui('subagents-ui', {
        entry: 'agentlab:subagents-ui',
        kind: 'status',
        title: '子 agent',
      });
    },
  });
}
