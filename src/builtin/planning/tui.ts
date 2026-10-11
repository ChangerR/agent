/** 固定计划区不拿焦点、不往 transcript 追加刷新。 */
import type { BuiltinTuiContext, TuiAdapter } from '../../cli/tui-plugins.js';
import type { Plan } from '../../core/plan.js';
const labels = {
  pending: '待办',
  running: '进行中',
  blocked: '阻塞',
  completed: '完成',
  cancelled: '取消',
  interrupted: '中断',
};
export function planLines(
  plan: Plan | undefined,
  expanded: boolean,
  height: number,
  offset = 0,
): string[] {
  if (!plan) return [];
  const current = plan.steps.filter((s) => s.status === 'running');
  const next = plan.steps.find((s) => s.status === 'pending');
  const lines = [
    `计划: ${plan.goal} · ${plan.phase} · ${plan.steps.filter((s) => s.status === 'completed').length}/${plan.steps.length} · 父/root`,
    `当前: ${current.map((s) => s.title + (s.reason ? `（${s.reason}）` : '') + (s.children.length ? ' [' + s.children.map((c) => `${c.name}:${c.status}`).join(', ') + ']' : '')).join(' / ') || plan.reason || plan.steps.find((s) => s.status === 'blocked')?.reason || '暂无执行步骤'}`,
    `下一步: ${next?.title ?? '等待验证/无后续步骤'}${expanded ? ' · /plan collapse' : ' · /plan expand 展开'}`,
  ];
  if (expanded) {
    const available = Math.max(0, height - lines.length - 1);
    const start = Math.min(offset, Math.max(0, plan.steps.length - available));
    for (const s of plan.steps.slice(start, start + available))
      lines.push(
        `${plan.steps.indexOf(s) + 1}. [${labels[s.status]}] ${s.title}${s.children.length ? ' · ' + s.children.map((c) => `${c.name}:${c.status} ${c.activity}`).join(', ') : ''}${s.reason ? ' · ' + s.reason : ''}`,
      );
    lines.push(
      `/plan collapse 收起 · /plan next 翻页 · /plan details 全部 · ${start + 1}–${Math.min(start + available, plan.steps.length)}/${plan.steps.length}`,
    );
  }
  return lines.slice(0, height);
}
export function createPlanningTui(context: BuiltinTuiContext): TuiAdapter {
  let expanded = false;
  let offset = 0;
  return {
    statusPanels: {
      plan: (_width, height) =>
        planLines(context.agent.loop.plan.snapshot, expanded, height, offset),
    },
    commands: {
      plan: async (args) => {
        if (['pause', 'cancel', 'revise', 'continue', 'execute'].includes(args.split(/\s+/)[0]))
          context.queue.clear();
        if (args === 'expand' || args === 'collapse') {
          expanded = args === 'expand';
          context.redraw();
          return;
        }
        if (args === 'next') {
          offset = (offset + 3) % (context.agent.loop.plan.snapshot?.steps.length || 1);
          context.redraw();
          return;
        }
        if (args === 'details') {
          context.showDetails('计划 · 父/root', () =>
            JSON.stringify(context.agent.loop.plan.snapshot, null, 2),
          );
          return;
        }
        if (args === 'mode') {
          context.showPicker(
            '规划方式 · 本项目 · 选择即保存',
            [
              { value: 'auto', label: '自动规划后执行' },
              { value: 'only', label: '只规划（专用只读调研）' },
              { value: 'off', label: '关闭自动规划' },
            ],
            (value) => {
              void context.agent
                .dispatchCommand(`/plan ${value}`)
                .then(() => context.updateStatus())
                .catch((e) => context.error(String(e)));
            },
            context.agent.loop.plan.mode,
          );
          return;
        }
        const result = await context.dispatchCommand(`/plan ${args}`);
        if (result?.type === 'text') context.say(result.text);
        if (result?.type === 'data') context.say(JSON.stringify(result.data));
        context.updateStatus();
      },
    },
  };
}
