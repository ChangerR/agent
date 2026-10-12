/** 复用原样 pnpm dev 的 Linux 真终端；所有模型与工作区均隔离。 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPtyProject } from './helpers/pty.js';

const provider = `
import { appendFileSync, existsSync, watch } from 'node:fs';
const log = row => appendFileSync(process.env.HOME + '/agents.jsonl', JSON.stringify(row) + '\\n');
export default {
  manifest:{id:'test.agents-pty',version:'1.0.0',apiVersion:1},
  setup(ctx) {
    ctx.provide.provider('offline-agents', {name:'offline-agents',capabilities:{thinking:false,streaming:true},async *stream(request, signal) {
      if (request.system.startsWith('[agentlab planning:auto]')) {
        yield {type:'message_start'};yield {type:'text_delta',text:'null'};yield {type:'message_stop',stopReason:'end_turn'};return;
      }
      const input = request.messages.at(-1)?.content;
      log({kind:'request',input,model:request.model});
      yield {type:'message_start'};
      yield {type:'text_delta',text:input === 'PARENT' ? 'PARENT_COMPLETE' : 'PRIVATE_CHILD_' + input};
      if (input !== 'PARENT') await new Promise(resolve => {
        const ready = () => input !== 'FOLLOWUP' && existsSync(process.env.HOME + '/release');
        const finish = () => { watcher.close(); signal.removeEventListener('abort', finish); resolve(); };
        const watcher = watch(process.env.HOME, () => { if (ready()) finish(); });
        signal.addEventListener('abort',finish,{once:true}); if (signal.aborted || ready()) finish();
      });
      yield {type:'usage',inputTokens:5,outputTokens:3};
      yield {type:'message_stop',stopReason:'end_turn'};
    }});
    ctx.provide.telemetry('agents-pty-events',{onEvent(event){
      if (['subagent_event','loop_end','permission_request'].includes(event.type)) log({kind:'event',event});
    }});
  }
};
`;
type Row = {
  kind: string;
  input?: string;
  model?: string;
  event?: { type: string; agentId?: string; runId?: string; kind?: string; status?: string };
};
it.skipIf(process.platform !== 'linux')(
  'Linux 真 PTY：两个后台 child、父输入、实时列表、补充取消、设置单选落盘',
  async () => {
    const f = createPtyProject();
    const path = join(f.home, 'agents.jsonl');
    const rows = (): Row[] =>
      existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((row) => JSON.parse(row))
        : [];
    writeFileSync(join(f.project, 'offline-agents.mjs'), provider);
    writeFileSync(
      join(f.project, 'agent.config.json'),
      JSON.stringify({
        provider: 'offline-agents',
        model: 'offline-current',
        permissionMode: 'auto',
        pluginConfig: { 'agentlab.planning': { mode: 'off' } },
        capabilities: { reviewer: false },
        pluginEntries: ['./offline-agents.mjs'],
        untouched: true,
      }),
    );
    const terminal = f.launch();
    try {
      await terminal.wait(() => terminal.output.includes('Enter 发送'), 'CLI 未就绪');
      terminal.send('/agents spawn A');
      await terminal.wait(() => rows().some((r) => r.input === 'A'), 'child A 未启动');
      terminal.send('/agents spawn B');
      await terminal.wait(() => rows().some((r) => r.input === 'B'), 'child B 未并行启动');
      const ids = [...new Set(rows().flatMap((r) => (r.event?.agentId ? [r.event.agentId] : [])))];
      expect(ids).toHaveLength(2);
      expect(
        rows()
          .filter((r) => r.kind === 'request')
          .every((r) => r.model === 'offline-current'),
      ).toBe(true);
      expect(rows().some((r) => r.event?.kind === 'complete')).toBe(false);
      await terminal.wait(
        () =>
          terminal.output.includes('子任务 agent-1') &&
          terminal.output.includes('PRIVATE_CHILD_A') &&
          terminal.output.includes('PRIVATE_CHILD_B'),
        '子任务进度未显示',
      );
      terminal.send('PARENT');
      await terminal.wait(
        () => rows().some((r) => r.event?.type === 'loop_end'),
        '父输入被后台任务阻塞',
      );
      await terminal.wait(() => terminal.output.includes('PARENT_COMPLETE'), '父流未渲染');
      expect(rows().filter((r) => r.event?.type === 'loop_end')).toHaveLength(1);
      terminal.send('/agents');
      await terminal.wait(() => terminal.output.includes('子 agents'), '列表未显示');
      writeFileSync(join(f.home, 'release'), 'release');
      await terminal.wait(
        () => rows().filter((r) => r.event?.kind === 'complete').length === 2,
        'child 未主动通知完成',
      );
      await terminal.wait(() => terminal.output.includes('agent-1 · completed'), '列表未实时刷新');
      const closedOffset = terminal.output.length;
      terminal.key('\x1b');
      await terminal.wait(
        () => terminal.output.slice(closedOffset).includes('Enter 发送'),
        '列表未关闭回输入框',
      );
      terminal.send('/agents send ' + ids[0] + ' FOLLOWUP');
      await terminal.wait(() => rows().some((r) => r.input === 'FOLLOWUP'), '补充任务未启动');
      terminal.send('/agents cancel ' + ids[0]);
      await terminal.wait(
        () => rows().some((r) => r.event?.kind === 'complete' && r.event.status === 'cancelled'),
        '取消未结算',
      );
      terminal.send('/agent-limit');
      await terminal.wait(() => terminal.output.includes('子 agent 并发上限'), '设置菜单未显示');
      terminal.key('\x1b[B');
      terminal.key('\r');
      await terminal.wait(
        () => f.readConfig().pluginConfig?.['agentlab.subagents']?.maxRunning === 4,
        '一次选择未自动保存',
      );
      expect(f.readConfig().untouched).toBe(true);
      expect(rows().filter((r) => r.event?.type === 'permission_request')).toHaveLength(0);
    } finally {
      if (process.env.AGENTLAB_PTY_EVIDENCE_DIR) {
        const evidence = process.env.AGENTLAB_PTY_EVIDENCE_DIR;
        mkdirSync(evidence, { recursive: true });
        writeFileSync(join(evidence, 'subagents-140x40.ansi'), terminal.output);
        writeFileSync(
          join(evidence, 'subagents-140x40.jsonl'),
          existsSync(path) ? readFileSync(path) : '',
        );
      }
      await terminal.close();
      f.dispose();
    }
  },
  60_000,
);
