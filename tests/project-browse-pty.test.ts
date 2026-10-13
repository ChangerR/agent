/** 原提示、真实仓库源码与真 PTY；受控 provider 仅复现已观测的委派/结案路径。 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createPtyProject } from './helpers/pty.js';

const plugin = `
import {appendFileSync} from 'node:fs';
const log=row=>appendFileSync(process.env.HOME+'/browse.jsonl',JSON.stringify(row)+'\\n');
const text=value=>[{type:'message_start'},{type:'text_delta',text:value},{type:'message_stop',stopReason:'end_turn'}];
const turns={root:0,child:0};
let seq=0;
const call=(name,input)=>[{type:'message_start'},{type:'tool_use_start',id:'c'+(++seq),name},{type:'tool_use_delta',id:'c'+seq,input:JSON.stringify(input)},{type:'tool_use_stop',id:'c'+seq},{type:'message_stop',stopReason:'tool_use'}];
export default {manifest:{id:'test.browse-pty',version:'1.0.0',apiVersion:1},setup(ctx){
ctx.provide.provider('offline-browse',{name:'offline-browse',capabilities:{thinking:false,streaming:true},async *stream(req){
 const child=req.messages.find(m=>m.role==='user'&&typeof m.content==='string')?.content!=='浏览一下当前项目，看看优化点';
 const actor=child?'child':'root';
 if(req.system.startsWith('[agentlab planning:auto]')){if(child)throw Error('child不得调用planner');log({kind:'planner',actor});yield* text(JSON.stringify({goal:'核对项目并给优化建议',steps:child?['读取子任务实现','综合建议']:['浏览核心入口','核对子任务实现','综合建议'],readOnly:true}));return;}
 if(!req.tools.length){log({kind:'judge'});throw Error('项目读取不应调用judge');}
 log({kind:'request',actor});
 if(child){if(++turns.child===1){yield* call('read_file',{path:'src/runtime/subagents.ts'});return;}if(!JSON.stringify(req.messages).includes('class AgentSupervisor'))throw Error('缺少实际child源码');yield* text('子任务完成：建议暴露任务结算状态');return;}
 const plan=JSON.parse([...req.messages].reverse().find(m=>m.source==='runtime').content).plan;
 const n=++turns[actor];
 const update=(i,status,extra={})=>call('plan_update',{revision:plan.revision,stepId:plan.steps[i].id,status,...extra});
 if(n===1){yield* call('read_file',{path:child?'src/runtime/subagents.ts':'src/core/loop.ts'});return;}
 if(n===2){
   const evidence=JSON.stringify(req.messages);if(!evidence.includes(child?'class AgentSupervisor':'class AgentLoop'))throw Error('缺少实际源码结果');
   yield* update(0,'completed',{evidence:child?'已读 AgentSupervisor 实现':'已读 AgentLoop 实现'});return;
 }
 if(n===3){yield* call('agent_spawn',{task:'只核对任务结算实现并返回建议',planStepId:plan.steps[1].id,readOnly:true,allowedTools:['read_file']});return;}
 if(n===4){yield* call('agent_wait',{agentId:plan.steps[1].children[0].agentId});return;}
 if(n===5){yield* update(1,'completed',{evidence:'已消费child结论，结合真实源码核对'});return;}
 if(n===6){yield* update(2,'running');return;}
 if(n===7){yield* update(2,'completed',{evidence:'汇总loop和supervisor结算可观测性建议',evidenceStepIds:plan.steps.slice(0,2).map(s=>s.id)});return;}
 yield* text('BROWSE_FINISHED：已核对 src/core/loop.ts 和 src/runtime/subagents.ts，建议为父子任务结算增加状态与耗时观测。');
}});
ctx.provide.telemetry('browse-events',{onEvent(event){if(['tool_result','loop_end','plan_changed','subagent_event','permission_request'].includes(event.type))log({kind:'event',event});}});
}};
`;

it.skipIf(process.platform !== 'linux')(
  '原样浏览提示：受限child结算、计划完成、停止请求并返回可输入TUI',
  async () => {
    const f = createPtyProject();
    for (const file of ['AGENTS.md', 'README.md', 'docs'])
      cpSync(join(f.repo, file), join(f.project, file), { recursive: true });
    const path = join(f.home, 'browse.jsonl');
    type Row = {
      kind: string;
      event?: {
        type: string;
        plan?: { phase: string };
        kind?: string;
        status?: string;
        result?: { isError?: boolean };
      };
    };
    const rows = (): Row[] =>
      existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((s) => JSON.parse(s))
        : [];
    writeFileSync(join(f.project, 'offline-browse.mjs'), plugin);
    writeFileSync(
      join(f.project, 'agent.config.json'),
      JSON.stringify({
        provider: 'offline-browse',
        model: 'offline-current',
        permissionMode: 'auto',
        pluginEntries: ['./offline-browse.mjs'],
      }),
    );
    const terminal = f.launch();
    try {
      await terminal.wait(() => terminal.output.includes('Enter 发送'), 'TUI未就绪');
      terminal.send('浏览一下当前项目，看看优化点');
      await terminal.wait(() => rows().some((r) => r.event?.type === 'loop_end'), '浏览未完成');
      await terminal.wait(() => terminal.output.includes('BROWSE_FINISHED'), '最终建议尚未渲染');
      expect(
        rows().filter((r) => r.kind === 'judge' || r.event?.type === 'permission_request'),
      ).toHaveLength(0);
      expect(
        rows().filter((r) => r.event?.type === 'tool_result' && r.event.result?.isError),
      ).toHaveLength(0);
      expect(
        rows()
          .filter((r) => r.event?.type === 'subagent_event' && r.event.kind === 'complete')
          .map((r) => r.event?.status),
      ).toEqual(['completed']);
      expect(
        rows()
          .filter((r) => r.event?.type === 'plan_changed')
          .at(-1)?.event?.plan?.phase,
      ).toBe('completed');
      expect(rows().filter((r) => r.kind === 'planner')).toHaveLength(1);
      const requests = rows().filter((r) => r.kind === 'request').length;
      await delay(300);
      terminal.send('/help');
      await terminal.wait(
        () => terminal.output.includes('命令（由已加载插件提供）'),
        '结束后未能处理新输入',
      );
      expect(rows().filter((r) => r.kind === 'request')).toHaveLength(requests);
    } finally {
      await terminal.close();
      f.dispose();
    }
  },
  30_000,
);
