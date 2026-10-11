/** Linux 真 PTY 跑原样 pnpm dev；离线 provider 仅控制时序，绝非真实模型。 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPtyProject } from './helpers/pty.js';
const provider = `
import {appendFileSync,existsSync,watch} from 'node:fs';
const log=row=>appendFileSync(process.env.HOME+'/plans.jsonl',JSON.stringify(row)+'\\n');
let stage=0;
const text=value=>[{type:'message_start'},{type:'text_delta',text:value},{type:'message_stop',stopReason:'end_turn'}];
const tool=(name,input)=>[{type:'message_start'},{type:'tool_use_start',id:'call-'+stage,name},{type:'tool_use_delta',id:'call-'+stage,input:JSON.stringify(input)},{type:'tool_use_stop',id:'call-'+stage},{type:'message_stop',stopReason:'tool_use'}];
export default {manifest:{id:'test.plan-pty',version:'1.0.0',apiVersion:1},setup(ctx){
ctx.provide.provider('offline-plan',{name:'offline-plan',capabilities:{thinking:false,streaming:true},async *stream(req,signal){
  const input=req.messages.at(-1)?.content;log({kind:'request',input});
  if(!req.tools.length){if(input==='PARENT_AFTER'){yield* text('null');return;}stage=0;yield* text(JSON.stringify({goal:'PTY 目标',steps:['写入结果','验证结果']}));return;}
  if(input==='PARENT_AFTER'){yield* text('PARENT_AFTER_OK');return;}
  const p=JSON.parse(req.system.split('当前所属计划（版本变化后须重新读取）: ')[1].split('\\n')[0]);
  const step=stage++;
  if(step===0){yield* tool('plan_update',{revision:p.revision,stepId:p.steps[0].id,status:'running'});return;}
  if(step===1){
    await new Promise(resolve=>{const done=()=>{watcher.close();signal.removeEventListener('abort',done);resolve();};const watcher=watch(process.env.HOME,()=>{if(existsSync(process.env.HOME+'/release'))done();});signal.addEventListener('abort',done,{once:true});if(signal.aborted||existsSync(process.env.HOME+'/release'))done();});
    signal.throwIfAborted();yield* tool('write_file',{path:'pty-result.txt',content:'ok'});return;
  }
  if(step===2){yield* tool('plan_update',{revision:p.revision,stepId:p.steps[0].id,status:'completed',evidence:'pty-result.txt 写入成功'});return;}
  if(step===3){yield* tool('plan_update',{revision:p.revision,stepId:p.steps[1].id,status:'running'});return;}
  if(step===4){yield* tool('read_file',{path:'pty-result.txt'});return;}
  if(step===5){yield* tool('plan_update',{revision:p.revision,stepId:p.steps[1].id,status:'completed',evidence:'读取返回 ok'});return;}
  yield* text('PLAN_FINISHED');
}});
ctx.provide.telemetry('plan-pty-events',{onEvent(event){if(['plan_changed','loop_end','tool_call'].includes(event.type))log({kind:'event',event});}});
}};
`;
it.skipIf(process.platform !== 'linux').each([
  { rows: 40, cols: 140 },
  { rows: 14, cols: 40 },
])(
  'pnpm dev 真终端 %j：当前/下一步、折叠、父输入排队、暂停取消与设置落盘',
  async (size) => {
    const f = createPtyProject();
    const logPath = join(f.home, 'plans.jsonl');
    const rows = (): Array<{
      kind: string;
      input?: string;
      event?: { type: string; plan?: { phase: string } };
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
        permissionMode: 'yolo',
        capabilities: { reviewer: false },
        pluginEntries: ['./offline-plan.mjs'],
      }),
    );
    const terminal = f.launch(size);
    try {
      await terminal.wait(() => terminal.output.includes('就绪'), 'CLI 未就绪');
      terminal.send('实现文件写入并验证结果');
      await terminal.wait(() => terminal.output.includes('当前: 写入结果'), '未显示当前步骤');
      expect(terminal.output).toContain('下一步: 验证结果');
      terminal.send('/plan expand');
      await terminal.wait(
        () => terminal.output.includes('[进行中]') || terminal.output.includes('/plan collapse'),
        '计划未展开',
      );
      terminal.send('/plan collapse');
      terminal.send('PARENT_AFTER');
      await terminal.wait(() => terminal.output.includes('排队 1'), '命令启动的轮次未让父输入排队');
      expect(rows().some((r) => r.input === 'PARENT_AFTER')).toBe(false);
      const finishingOffset = terminal.output.length;
      writeFileSync(join(f.home, 'release'), 'yes');
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
      const mark = rows().length;
      terminal.send('/plan auto 再实现并验证');
      await terminal.wait(
        () =>
          rows()
            .slice(mark)
            .some((r) => r.kind === 'request' && typeof r.input !== 'string'),
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
      expect(terminal.output).not.toContain('already running');
    } finally {
      await terminal.close();
      f.dispose();
    }
  },
  30000,
);
