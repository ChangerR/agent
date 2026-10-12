/** 固定计划区不拿焦点、不往 transcript 追加刷新。 */
import type { BuiltinTuiContext, TuiAdapter } from '../../cli/tui-plugins.js';
import type { Plan } from '../../core/plan.js';
import { Key, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { safeTerminalText } from '../../cli/theme.js';
const labels = {
  pending: '待办',
  running: '进行中',
  blocked: '阻塞',
  completed: '完成',
  cancelled: '取消',
  interrupted: '中断',
};
const phases = {
  planning: '规划中',
  ready: '待执行',
  executing: '进行中',
  paused: '暂停',
  cancelled: '取消',
  interrupted: '中断',
  blocked: '阻塞',
  completed: '完成',
};
const singleLine = (text: string) => safeTerminalText(text).replace(/\s+/g, ' ');

/** 终态仍定位具体步骤；总阶段可能尚未跟随工具更新，优先展示真实阻塞。 */
function summaryStep(plan: Plan) {
  const status = plan.phase === 'paused' ? 'interrupted' : plan.phase;
  if (plan.phase === 'completed') return plan.steps.at(-1);
  if (['blocked', 'interrupted', 'cancelled'].includes(status))
    return (
      plan.steps.find((step) => step.status === status) ??
      plan.steps.find((step) => step.status !== 'completed')
    );
  return (
    plan.steps.find((step) => step.status === 'blocked') ??
    plan.steps.find((step) => step.id === plan.activeStepId && step.status === 'running') ??
    plan.steps.find((step) => step.status === 'running') ??
    plan.steps.find((step) => step.status === 'pending') ??
    plan.steps.at(-1)
  );
}
function detailLines(plan: Plan, width: number): string[] {
  const lines: string[] = [];
  for (const [index, step] of plan.steps.entries()) {
    lines.push(`${index + 1}. [${labels[step.status]}] ${step.title}`);
    if (step.reason) lines.push(`   原因: ${step.reason}`);
    if (step.evidence) lines.push(`   依据: ${step.evidence}`);
    for (const child of step.children)
      lines.push(
        `   ↳ ${child.name} · ${labels[child.status as keyof typeof labels] ?? child.status} · ${child.activity}`,
      );
  }
  lines.push(`目标: ${plan.goal}`);
  if (plan.reason) lines.push(`计划: ${plan.reason}`);
  return lines.flatMap((line) => new Text(safeTerminalText(line), 0, 0).render(width));
}
export function planLines(
  plan: Plan | undefined,
  expanded: boolean,
  height: number,
  offset = 0,
  width = 100,
): string[] {
  if (!plan || height < 1 || width < 1) return [];
  const step = summaryStep(plan);
  const phase = step?.status === 'blocked' ? '阻塞' : phases[plan.phase];
  const count = `${plan.steps.filter((s) => s.status === 'completed').length}/${plan.steps.length}`;
  const reason = step?.reason ?? plan.reason;
  const prefix = `计划 ${count} ${phase} · `;
  const hint = width >= 60 ? ' · Ctrl+T' : ' ^T';
  const budget = Math.max(1, width - visibleWidth(hint));
  const title = singleLine(step?.title ?? plan.goal);
  let summary = prefix + title;
  if (reason) {
    // 原因和具体步骤各自保留空间，长标题不能吞掉拒绝或中断来源。
    const remaining = Math.max(1, budget - visibleWidth(prefix));
    const detail = `#${step ? plan.steps.indexOf(step) + 1 : '?'} ${title}`;
    const titleBudget = Math.max(3, Math.floor(remaining / 2) - 1);
    const reasonBudget = Math.max(1, remaining - titleBudget - 1);
    summary =
      prefix +
      truncateToWidth(detail, titleBudget, '…') +
      ' ' +
      truncateToWidth(singleLine(reason), reasonBudget, '…');
  }
  // 所有裁切都按终端 cell，不能按 JS 字符数。
  const header = truncateToWidth(summary, budget, '…') + hint;
  if (!expanded || height < 3) return [truncateToWidth(header, width)];
  const body = detailLines(plan, width);
  const available = height - 2;
  const start = Math.max(0, Math.min(offset, Math.max(0, body.length - available)));
  return [
    truncateToWidth(header, width),
    ...body.slice(start, start + available),
    truncateToWidth(
      `Alt+↑↓ 浏览 · Ctrl+T 收起 · ${start + 1}–${Math.min(start + available, body.length)}/${body.length}`,
      width,
    ),
  ];
}
export function createPlanningTui(context: BuiltinTuiContext): TuiAdapter {
  let expanded = false;
  let offset = 0;
  let planId: string | undefined;
  let maxOffset = 0;
  const reset = () => {
    expanded = false;
    offset = 0;
    planId = undefined;
  };
  const off = context.agent.events.on('session_restored', reset);
  const snapshot = () => {
    const plan = context.agent.loop.plan.snapshot;
    if (plan?.id !== planId) {
      reset();
      planId = plan?.id;
    }
    return plan;
  };
  const toggle = () => {
    if (!snapshot()) return false;
    expanded = !expanded;
    context.redraw();
    return true;
  };
  const scroll = (direction: number) => {
    if (!snapshot() || !expanded) return false;
    offset = Math.max(0, Math.min(maxOffset, offset + direction));
    context.redraw();
    return true;
  };
  return {
    dispose: off,
    shortcuts: {
      [Key.ctrl('t')]: toggle,
      [Key.alt('up')]: () => scroll(-1),
      [Key.alt('down')]: () => scroll(1),
    },
    statusPanels: {
      plan: (width, height) => {
        const plan = snapshot();
        maxOffset =
          plan && expanded
            ? Math.max(0, detailLines(plan, width).length - Math.max(1, height - 2))
            : 0;
        offset = Math.min(offset, maxOffset);
        return planLines(plan, expanded, height, offset, width);
      },
    },
    commands: {
      plan: async (args) => {
        if (['pause', 'cancel', 'revise', 'continue', 'execute'].includes(args.split(/\s+/)[0]))
          context.queue.clear();
        if (args === 'expand' || args === 'collapse') {
          snapshot();
          expanded = args === 'expand';
          context.redraw();
          return;
        }
        if (args === 'next') {
          snapshot();
          expanded = true;
          offset = offset >= maxOffset ? 0 : Math.min(maxOffset, offset + 3);
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
