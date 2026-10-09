/** 默认产品的可选终端交互。只由 CLI 加载；核心与 headless 不导入终端组件。 */
import type { TuiAdapter, BuiltinTuiContext, TuiCommandHandler } from '../cli/tui-plugins.js';
import { createPermissionSettings } from './policy-legacy/tui.js';

function formatUpdated(iso: string): string {
  const date = new Date(iso); if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function relativeTime(iso: string): string {
  const then = Date.parse(iso); if (Number.isNaN(then)) return iso;
  const delta = Date.now() - then; if (delta < 10_000) return '刚刚';
  const sec = Math.floor(delta / 1000); if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60); if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60); if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24); return day < 30 ? `${day} 天前` : formatUpdated(iso);
}
const fmtTokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function createTuiAdapter(context: BuiltinTuiContext): TuiAdapter {
  const { agent, say, error: err, showPicker } = context;
  const runAsync = (task: () => Promise<void>) => { void task().catch(error => err(error instanceof Error ? error.message : String(error))); };
  let selectionController: AbortController | undefined;
  const runModelSetting = (id: 'model' | 'think', arg: string, onBack?: () => void) => runAsync(async () => {
    selectionController?.abort();
    const controller = new AbortController(); selectionController = controller;
    const off = agent.events.on('session_restored', () => controller.abort());
    try {
      const result = await agent.dispatchCommand(`/${id}${arg ? ` ${arg}` : ''}`, { signal: controller.signal, interact: request => new Promise(resolve => {
        const finish = (value?: string) => { controller.signal.removeEventListener('abort', cancel); resolve(value); };
        const cancel = () => finish();
        controller.signal.addEventListener('abort', cancel, { once: true });
        const items = (request.choices ?? []).map(choice => {
          const info = id === 'model' ? agent.modelInfo(choice.id) : undefined;
          return { value: choice.id, label: choice.label, description: id === 'model'
            ? `${info ? `context ${info.contextWindow.toLocaleString()} · output ${info.maxOutputTokens.toLocaleString()}` : '未知规格'}\n选择即保存本项目，下一次模型请求生效；需与当前 provider / endpoint 兼容。`
            : `${choice.id === 'off' ? '不请求额外推理参数，实际行为由模型决定。' : '请求相应推理等级，模型需支持。'}选择即保存本项目；下一次模型请求生效。` };
        });
        showPicker(`${request.prompt}${id === 'model' ? ` · ${agent.loop.providerName}` : ''}`, items,
          value => { if (!controller.signal.aborted) finish(value); }, id === 'model' ? agent.loop.model : agent.loop.thinking, id === 'model',
          () => { finish(); onBack?.(); });
      }) });
      if (result?.type === 'text' && result.text !== '已取消') say(result.text);
      context.updateStatus();
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { off(); if (selectionController === controller) selectionController = undefined; }
  });
  const permissions = createPermissionSettings({ agent, cwd: agent.cwd,
    notify: (text, error) => error ? err(text) : say(text), onModeChange: () => context.updateStatus(),
    showPicker: context.showPermissionPicker, showDetails: (title, body, onBack) => context.showDetails(title, body, onBack, true), showInput: context.showInput,
  });
  const commands: Record<string, TuiCommandHandler> = {
    exit: () => context.exit(),
    redraw: () => { context.redraw(); say('已强制全屏重绘'); },
    details: arg => {
      if (!arg) { context.toggleDetails(); return; }
      const entry = /^\d+$/.test(arg) ? context.detail(Number(arg)) : undefined;
      if (!entry) { err('用法: /details [消息编号]，编号显示在工具与思考旁'); return; }
      context.showDetails(`#${entry.id} ${entry.title}`, entry.body);
    },
    stats: () => {
      const usage = context.usage(); const denom = usage.cacheReadTokens + usage.inputTokens;
      say(`tokens: ${fmtTokens(usage.inputTokens)} 输入 / ${fmtTokens(usage.outputTokens)} 输出\ncache: ${fmtTokens(usage.cacheReadTokens)} 读 / ${fmtTokens(usage.cacheWriteTokens)} 写 · 命中率 ${denom ? `${Math.round(usage.cacheReadTokens / denom * 100)}%` : '-'}\n会话日志: ${agent.logPath}`);
    },
    queue: arg => { say(arg === 'clear' ? `已取消 ${context.queue.clear()} 条排队消息` : `待发送 ${context.queue.size()} 条消息，/queue clear 清空`); },
    model: (arg, onBack) => runModelSetting('model', arg, onBack),
    mode: (arg, onBack) => {
      if (arg === 'ask' || arg === 'auto' || arg === 'yolo') permissions.requestMode(arg);
      else if (arg) err('用法: /mode ask|auto|yolo'); else permissions.openModes(onBack);
    },
    think: (arg, onBack) => runModelSetting('think', arg, onBack),
    permissions: (arg, onBack) => { if (arg === 'audit') permissions.openAudit(); else if (arg) err('用法: /permissions 或 /permissions audit'); else permissions.open(onBack); },
    save: () => runAsync(async () => {
      const saved = await agent.session.save(); if (!saved) { say('当前会话还没有内容，未保存'); return; }
      say(`已保存会话 ${saved.id}（${saved.messageCount} 条消息）→ ${saved.path}${saved.trimmed > 0 ? `（尾部 ${saved.trimmed} 条未完成的工具调用未写入）` : ''}`);
    }),
    sessions: arg => runAsync(async () => {
      if (arg.startsWith('rm')) {
        const id = arg.slice(2).trim(); if (!id) { err('用法: /sessions rm <id>'); return; }
        if (!await agent.session.delete(id)) { err(`会话 ${id} 不存在`); return; }
        say(`已删除会话 ${id}`); if (id === agent.session.id) say('当前会话已从磁盘删除，下一次保存会重建'); return;
      }
      if (arg) { err('用法: /sessions 或 /sessions rm <id>'); return; }
      const listing = await agent.session.list();
      if (!listing.sessions.length && !listing.broken.length) say('(本项目还没有已保存的会话)');
      for (const item of listing.sessions) say(`${item.id}${item.id === agent.session.id ? ' ✓' : ''} · ${item.title} · ${relativeTime(item.updatedAt)} · ${item.messageCount} 条`);
      for (const item of listing.broken) err(`[坏文件] ${item.id}: ${item.error.message}`);
    }),
    resume: arg => runAsync(async () => {
      if (arg) { const [id, flag, ...extra] = arg.split(/\s+/); if (extra.length || (flag && flag !== '--legacy')) throw new Error('用法: /resume <id> [--legacy]'); await agent.session.resume(id, { allowLegacyProvider: flag === '--legacy' }); return; }
      const listing = await agent.session.list(); if (!listing.sessions.length) { say('(本项目还没有已保存的会话)'); return; }
      showPicker('恢复会话', listing.sessions.map(item => ({ value: item.id, label: item.title, description: `${item.id} · ${formatUpdated(item.updatedAt)} · ${item.messageCount} 条` })), value => runAsync(async () => { await agent.session.resume(value); }));
    }),
  };
  return { dispose: () => selectionController?.abort(), commands, settings: { model: onBack => { void commands.model!('', onBack); }, think: onBack => { void commands.think!('', onBack); }, permissions: onBack => permissions.open(onBack) } };
}
