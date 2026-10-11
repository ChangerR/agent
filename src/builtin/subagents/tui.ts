/** 子流仅刷新各自状态和详情；父聊天有独立输入和消息组件。 */
import type { BuiltinTuiContext, TuiAdapter } from '../../cli/tui-plugins.js';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function createSubagentsTui(context: BuiltinTuiContext): TuiAdapter {
  const { agent } = context;
  const detail = (id: string) => {
    const record = agent.agents.status(id)[0];
    const body = () => {
      const current = agent.agents.status(id)[0];
      return `${current.name} · ${current.agentId}\n上下文: ${current.context} · 深度 ${current.depth}\n子会话: ${current.sessionId}\n${current.runs.map((run) => `${run.runId}\n${run.status} · ${run.activity}\n任务: ${run.task}\ntokens ↑${run.usage.inputTokens} ↓${run.usage.outputTokens} cache ${run.usage.cacheReadTokens}/${run.usage.cacheWriteTokens}\n${run.error ?? ''}\n${run.output}${run.truncated ? '\n[输出达到限制，已保留部分结果]' : ''}`).join('\n\n')}`;
    };
    context.showPicker(
      `${record.name} · 子 agent 详情`,
      () => [
        { value: 'result', label: '查看完整结果', description: body() },
        {
          value: 'send',
          label: '补充任务',
          description: '运行时 FIFO；结束后复用上下文启动新 run。',
        },
        { value: 'cancel', label: '取消任务', description: '保留部分结果，等待真实执行结算。' },
      ],
      (action) => {
        try {
          if (action === 'result')
            context.showDetails(`${record.name} · 完整结果`, body, () => detail(id));
          else if (action === 'cancel') {
            agent.agents.cancel(id);
            detail(id);
          } else
            context.showInput({
              title: `${record.name} · 补充任务`,
              value: '',
              description: 'Enter 发送 · Esc 返回；这是你的真实用户请求。',
              onCancel: () => detail(id),
              onSubmit: (text) => {
                try {
                  agent.agents.send(id, text);
                  detail(id);
                } catch (error) {
                  context.error(errorText(error));
                }
              },
            });
        } catch (error) {
          context.error(errorText(error));
        }
      },
      undefined,
      false,
      list,
    );
  };
  const list = () => {
    const records = agent.agents.status();
    if (!records.length) {
      context.say('当前会话没有子任务。/agents spawn <任务> 创建。');
      return;
    }
    context.showPicker(
      '子 agents · 状态 / 详情',
      () =>
        agent.agents.status().map((record) => {
          const run = record.runs.at(-1)!;
          return {
            value: record.agentId,
            label: `${record.name} · ${run.status}`,
            description: `${run.activity}\n${run.task}\ntokens ↑${run.usage.inputTokens} ↓${run.usage.outputTokens}\n${run.error ?? run.output.slice(0, 200)}`,
          };
        }),
      detail,
    );
  };
  return {
    commands: {
      agents: async (args) => {
        if (!args) list();
        else if (!args.includes(' ') && args.startsWith('a-')) detail(args);
        else {
          const result = await agent.dispatchCommand(`/agents ${args}`);
          if (result?.type === 'data') context.say(JSON.stringify(result.data));
        }
      },
    },
    statusItems: {
      subagents: () => {
        const records = agent.agents.status();
        const active = records.flatMap((record) => {
          const run = record.runs.at(-1);
          return run && ['running', 'queued', 'cancelling'].includes(run.status)
            ? [`${record.name} ${run.activity}`]
            : [];
        });
        const { self, tree } = agent.agents.usage();
        return records.length
          ? `agents ${active.length}/${records.length}${active.length ? ` · ${active.slice(0, 2).join(' · ')}` : ''} · 自身 ↑${self.inputTokens} ↓${self.outputTokens} · 全树 ↑${tree.inputTokens} ↓${tree.outputTokens}`
          : '';
      },
    },
  };
}
