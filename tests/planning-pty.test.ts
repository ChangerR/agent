/** Linux 真 PTY 跑原样 pnpm dev；离线 provider 仅控制时序，绝非真实模型。 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPtyProject } from './helpers/pty.js';
const provider = `
import {appendFileSync,existsSync,watch} from 'node:fs';
const log=row=>appendFileSync(process.env.HOME+'/plans.jsonl',JSON.stringify(row)+'\\n');
let stage=0;let verified=false;
const text=value=>[{type:'message_start'},{type:'text_delta',text:value},{type:'message_stop',stopReason:'end_turn'}];
const tool=(name,input)=>[{type:'message_start'},{type:'tool_use_start',id:'call-'+stage,name},{type:'tool_use_delta',id:'call-'+stage,input:JSON.stringify(input)},{type:'tool_use_stop',id:'call-'+stage},{type:'message_stop',stopReason:'tool_use'}];
export default {manifest:{id:'test.plan-pty',version:'1.0.0',apiVersion:1},setup(ctx){
ctx.provide.provider('offline-plan',{name:'offline-plan',capabilities:{thinking:false,streaming:true},async *stream(req,signal){
  const input=req.messages.filter(m=>m.source!=='runtime').at(-1)?.content;log({kind:'request',input});
  if(!req.tools.length){if(input==='PARENT_AFTER'||input==='CHILD_WRITE'){yield* text('null');return;}stage=0;verified=false;yield* text(JSON.stringify({goal:'PTY 目标',steps:['写入结果','验证结果']}));return;}
  if(input==='PARENT_AFTER'){yield* text('PARENT_AFTER_OK');return;}
  if(input==='CHILD_WRITE'){yield* tool('write_file',{path:'child-result.txt',content:'child ok'});return;}
  const state=[...req.messages].reverse().find(m=>m.source==='runtime');
  const p=state?JSON.parse(state.content).plan:null;
  if(!p||!req.tools.some(t=>t.name==='plan_update')){yield* text('CHILD_DONE');return;}
  stage++;
  if(p.steps[0].status!=='completed'){
    if(p.activeStepId!==p.steps[0].id){yield* tool('plan_update',{revision:p.revision,stepId:p.steps[0].id,status:'running'});return;}
    if(!existsSync(process.cwd()+'/pty-result.txt')){
      await new Promise(resolve=>{const done=()=>{watcher.close();signal.removeEventListener('abort',done);resolve();};const watcher=watch(process.env.HOME,()=>{if(existsSync(process.env.HOME+'/release'))done();});signal.addEventListener('abort',done,{once:true});if(signal.aborted||existsSync(process.env.HOME+'/release'))done();});
      signal.throwIfAborted();yield* tool('write_file',{path:'pty-result.txt',content:'ok'});return;
    }
    yield* tool('plan_update',{revision:p.revision,stepId:p.steps[0].id,status:'completed',evidence:'pty-result.txt 写入成功'});return;
  }
  if(p.steps[1].status==='pending'){yield* tool('plan_update',{revision:p.revision,stepId:p.steps[1].id,status:'running'});return;}
  if(p.steps[1].status!=='completed'){
    if(!verified){verified=true;yield* tool('read_file',{path:'pty-result.txt'});return;}
    yield* tool('plan_update',{revision:p.revision,stepId:p.steps[1].id,status:'completed',evidence:'读取返回 ok'});return;
  }
  yield* text('PLAN_FINISHED');
}});
ctx.provide.telemetry('plan-pty-events',{onEvent(event){if(['plan_changed','loop_end','tool_call','permission_request','subagent_event','session_restored'].includes(event.type))log({kind:'event',event});}});
}};
`;
it.skipIf(process.platform !== 'linux').each([
  { rows: 40, cols: 140 },
  { rows: 14, cols: 40 },
])(
  'pnpm dev 真终端 %j：摘要浏览、父子审批、父输入排队、暂停取消、设置重启与恢复',
  async (size) => {
    const f = createPtyProject();
    const logPath = join(f.home, 'plans.jsonl');
    const rows = (): Array<{
      kind: string;
      input?: string;
      event?: {
        type: string;
        plan?: { phase: string };
        request?: { agentId?: string };
        kind?: string;
        status?: string;
      };
    }> =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((s) => JSON.parse(s))
        : [];
    writeFileSync(join(f.project, 'offline-plan.mjs'), provider);
    writeFileSync(
      join(f.project, 'agent.config.json'),
      JSON.stringify({
        provider: 'offline-plan',
        model: 'offline-current',
        permissionMode: 'ask',
        capabilities: { reviewer: false },
        pluginEntries: ['./offline-plan.mjs'],
      }),
    );
    let terminal = f.launch(size);
    const transcripts: string[] = [];
    try {
      await terminal.wait(() => terminal.output.includes('就绪'), 'CLI 未就绪');
      terminal.send('实现文件写入并验证结果');
      await terminal.wait(() => terminal.output.includes('进行中 · 写入结果'), '未显示当前步骤');
      expect(terminal.output).not.toContain('[待办] 验证结果');
      terminal.key('\x14');
      await terminal.wait(() => terminal.output.includes('[进行中]'), '计划未展开');
      terminal.key('\x1b[1;3B');
      await terminal.wait(() => terminal.output.includes('[待办] 验证结果'), 'Alt+下未浏览下一步');
      terminal.key('\x1b[1;3A');
      terminal.key('\x14');
      terminal.send('/agents spawn CHILD_WRITE');
      await terminal.wait(
        () =>
          rows().some((r) => r.event?.type === 'permission_request' && r.event.request?.agentId),
        'child 未请求审批',
      );
      terminal.key('\x14');
      terminal.key('\x1b[1;3B');
      terminal.key('\r');
      expect(existsSync(join(f.project, 'child-result.txt'))).toBe(false);
      terminal.key('\x07');
      terminal.key('PARENT_AFTER');
      terminal.key('\x14');
      terminal.key('\r');
      await terminal.wait(() => terminal.output.includes('排队 1'), '命令启动的轮次未让父输入排队');
      expect(rows().some((r) => r.input === 'PARENT_AFTER')).toBe(false);
      terminal.key('\x07');
      terminal.key('\x1b[B');
      terminal.key('\r');
      await terminal.wait(
        () => existsSync(join(f.project, 'child-result.txt')),
        'child 明确批准未执行',
      );
      await terminal.wait(
        () => rows().some((r) => r.event?.type === 'subagent_event' && r.event.kind === 'complete'),
        'child 未结算',
      );
      const finishingOffset = terminal.output.length;
      writeFileSync(join(f.home, 'release'), 'yes');
      await terminal.wait(
        () =>
          rows().some((r) => r.event?.type === 'permission_request' && !r.event.request?.agentId),
        'root 未请求审批',
      );
      terminal.key('\x14');
      terminal.key('\x1b[1;3B');
      terminal.key('\r');
      expect(existsSync(join(f.project, 'pty-result.txt'))).toBe(false);
      terminal.key('\x1b[B');
      terminal.key('\r');
      await terminal.wait(
        () => rows().some((r) => r.event?.plan?.phase === 'completed'),
        '计划未完成',
      );
      await terminal.wait(() => terminal.output.includes('PARENT_AFTER_OK'), '父排队输入未处理');
      await terminal.wait(
        () => terminal.output.slice(finishingOffset).includes('就绪'),
        '父轮次尚未完全结算',
      );
      expect(readFileSync(join(f.project, 'pty-result.txt'), 'utf8')).toBe('ok');
      rmSync(join(f.home, 'release'));
      rmSync(join(f.project, 'pty-result.txt'));
      const mark = rows().length;
      terminal.send('/plan auto 再实现并验证');
      await terminal.wait(
        () =>
          rows()
            .slice(mark)
            .filter((r) => r.kind === 'request' && r.input === '再实现并验证').length >= 2,
        '第二轮未开始',
      );
      terminal.send('/plan pause');
      await terminal.wait(
        () =>
          rows()
            .slice(mark)
            .some((r) => r.event?.plan?.phase === 'paused'),
        '暂停未显示',
      );
      terminal.send('/plan cancel');
      await terminal.wait(
        () =>
          rows()
            .slice(mark)
            .some((r) => r.event?.plan?.phase === 'cancelled'),
        '取消未显示',
      );
      terminal.send('/plan mode');
      await terminal.wait(() => terminal.output.includes('规划方式'), '模式选择器未显示');
      terminal.key('\x1b[B');
      terminal.key('\r');
      await terminal.wait(
        () => f.readConfig().pluginConfig?.['agentlab.planning']?.mode === 'only',
        '选择未自动落盘',
      );
      const saved = readFileSync(join(f.project, 'agent.config.json'), 'utf8');
      const modeOffset = terminal.output.length;
      terminal.send('/plan mode');
      await terminal.wait(
        () => terminal.output.slice(modeOffset).includes('规划方式'),
        '取消设置菜单未显示',
      );
      terminal.key('\x1b[B');
      const cancelOffset = terminal.output.length;
      terminal.key('\x1b');
      await terminal.wait(
        () => terminal.output.slice(cancelOffset).includes('就绪'),
        '取消设置未返回输入',
      );
      expect(readFileSync(join(f.project, 'agent.config.json'), 'utf8')).toBe(saved);
      expect(terminal.output).not.toContain('already running');
      transcripts.push(terminal.output);
      await terminal.close();
      const requestsBefore = rows().filter((r) => r.kind === 'request').length;
      terminal = f.launch(size);
      await terminal.wait(() => terminal.output.includes('就绪'), '重启未就绪');
      expect(terminal.output).not.toContain('计划 0/2');
      terminal.send('/plan');
      await terminal.wait(() => terminal.output.includes('"mode":"only"'), '重启未加载已保存设置');
      const restoreOffset = terminal.output.length;
      terminal.send('/resume latest');
      await terminal.wait(
        () => rows().some((r) => r.event?.type === 'session_restored'),
        '未恢复会话',
      );
      await terminal.wait(
        () => terminal.output.slice(restoreOffset).includes('计划 0/2 取消'),
        '恢复未显示具体取消步骤',
      );
      expect(terminal.output.slice(restoreOffset)).not.toContain('Alt+↑↓ 浏览');
      expect(rows().filter((r) => r.kind === 'request')).toHaveLength(requestsBefore);
    } finally {
      if (process.env.AGENTLAB_PTY_EVIDENCE_DIR) {
        const evidence = process.env.AGENTLAB_PTY_EVIDENCE_DIR;
        mkdirSync(evidence, { recursive: true });
        const name = `planning-${size.cols}x${size.rows}`;
        writeFileSync(
          join(evidence, name + '.ansi'),
          [...transcripts, terminal.output].join('\n--- RESTART ---\n'),
        );
        writeFileSync(
          join(evidence, name + '.jsonl'),
          existsSync(logPath) ? readFileSync(logPath) : '',
        );
      }
      await terminal.close();
      f.dispose();
    }
  },
  45000,
);
