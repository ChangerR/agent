/** 原样 pnpm dev 真终端：注入 Windows policy 验证审批展示；在 Linux 上绝不执行 PowerShell 命令。 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPtyProject } from './helpers/pty.js';

const plugin = `
import {appendFileSync} from 'node:fs';
import {createDeterministicPolicy} from './src/builtin/policy/index.ts';
const log = row => appendFileSync(process.env.HOME + '/ps-events.jsonl', JSON.stringify(row) + '\\n');
const text = value => [{type:'message_start'},{type:'text_delta',text:value},{type:'message_stop',stopReason:'end_turn'}];
export default {
 manifest:{id:'test.ps-pty',version:'1.0.0',apiVersion:1},
 setup(ctx) {
  ctx.provide.policy('windows-pty',createDeterministicPolicy({cwd:process.cwd(),mode:'auto',platform:'win32',rules:{allow:[],ask:[],deny:[]}}));
  ctx.provide.provider('offline-ps-pty',{
   name:'offline-ps-pty',capabilities:{thinking:false,streaming:true},
   async *stream(request) {
    log({kind:'request',judge:request.tools.length===0});
    if(!request.tools.length) {
     const data=JSON.parse(request.messages[0].content);
     log({kind:'review',completeness:data.analysis.completeness,summary:data.analysis.summary});
     yield* text(JSON.stringify({decision:'ask',reasonCode:'controlled_ask',reason:'受控 provider 要求人工'}));return;
    }
    const last=[...request.messages].reverse().find(m=>m.role!=='user'||m.source!=='runtime')?.content;
    if(typeof last!=='string') {yield* text('PTY_PS_COMPLETED');return;}
    const call=last==='safe-read'?{name:'read_file',input:{path:'sentinel.txt'}}:{name:'bash',input:{command:last==='unknown-shell'?'git status':last==='sensitive-shell'?'sc .env fixture':'echo PREVIEW'}};
    yield {type:'message_start'};yield {type:'tool_use_start',id:'ps-pty-call',name:call.name};
    yield {type:'tool_use_delta',id:'ps-pty-call',input:JSON.stringify(call.input)};yield {type:'tool_use_stop',id:'ps-pty-call'};
    yield {type:'message_stop',stopReason:'tool_use'};
   }
  });
  ctx.provide.telemetry('ps-events',{onEvent(event){
   if(['tool_result','permission_request','loop_end'].includes(event.type))log({kind:'event',event});
  }});
 }
};
`;
type Row = {
  kind: string;
  judge?: boolean;
  completeness?: string;
  summary?: string;
  event?: {
    type: string;
    request?: { summary: string; reasonCode: string };
    result?: { content: string; isError?: boolean };
  };
};
it.skipIf(process.platform !== 'linux')(
  '原样 pnpm dev：PowerShell 摘要、敏感/未知人工、真实 reviewer ask 与普通读取',
  async () => {
    const fixture = createPtyProject();
    const logPath = join(fixture.home, 'ps-events.jsonl');
    const rows = (): Row[] =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    try {
      for (const name of [
        'package.json',
        'src/cli/index.ts',
        'src/builtin/policy/analyzer-powershell.ts',
        'src/tools/powershell.ts',
      ])
        expect(digest(join(fixture.project, name))).toBe(digest(join(fixture.repo, name)));
      writeFileSync(join(fixture.project, 'offline.mjs'), plugin);
      writeFileSync(join(fixture.project, 'sentinel.txt'), 'PTY_ORDINARY_READ_SENTINEL');
      writeFileSync(
        join(fixture.project, 'agent.config.json'),
        JSON.stringify({
          provider: 'offline-ps-pty',
          model: 'controlled-pty',
          permissionMode: 'auto',
          pluginConfig: { 'agentlab.planning': { mode: 'off' } },
          pluginEntries: ['./offline.mjs'],
          capabilities: { policy: 'windows-pty', reviewer: 'model' },
        }),
      );
      const terminal = fixture.launch();
      try {
        await terminal.wait(() => terminal.output.includes('Enter 发送'), '原样 pnpm dev 未启动');
        for (const [request, summary, reason, judges] of [
          ['unknown-shell', 'PowerShell: git status', 'powershell_unknown', 0],
          ['sensitive-shell', 'PowerShell: sc .env fixture', 'sensitive_target', 0],
          ['reviewer-ask', 'PowerShell: echo PREVIEW', 'controlled_ask', 1],
        ] as const) {
          const offset = rows().length;
          const outputOffset = terminal.output.length;
          terminal.send(request);
          await terminal.wait(
            () =>
              rows()
                .slice(offset)
                .some((row) => row.event?.type === 'permission_request'),
            '审批事件缺失',
          );
          await terminal.wait(
            () => terminal.output.slice(outputOffset).includes(summary),
            '终端没有实际解释器摘要',
          );
          const permission = rows()
            .slice(offset)
            .find((row) => row.event?.type === 'permission_request')!.event!.request!;
          expect(permission).toMatchObject({ summary, reasonCode: reason });
          // 先进入正文详情确认，返回后选择拒绝；Enter 在详情里不会批准。
          terminal.key('\t');
          await terminal.wait(
            () => terminal.output.slice(outputOffset).includes('返回选项'),
            '审批详情缺失',
          );
          terminal.key('\r');
          terminal.key('\x1b[B');
          terminal.key('\r');
          await terminal.wait(
            () =>
              rows()
                .slice(offset)
                .some((row) => row.event?.type === 'loop_end'),
            '拒绝后工具未结算',
          );
          const current = rows().slice(offset);
          expect(current.filter((row) => row.judge)).toHaveLength(judges);
          expect(
            current.find((row) => row.event?.type === 'tool_result')!.event!.result!.isError,
          ).toBe(true);
          expect(existsSync(join(fixture.project, '.env'))).toBe(false);
          if (judges)
            expect(current.find((row) => row.kind === 'review')).toMatchObject({
              completeness: 'complete',
              summary,
            });
        }
        const offset = rows().length;
        terminal.send('safe-read');
        await terminal.wait(
          () =>
            rows()
              .slice(offset)
              .some((row) => row.event?.type === 'loop_end'),
          '普通读取未完成',
        );
        const current = rows().slice(offset);
        expect(
          current.filter((row) => row.judge || row.event?.type === 'permission_request'),
        ).toHaveLength(0);
        expect(
          current.find((row) => row.event?.type === 'tool_result')!.event!.result!.content,
        ).toContain('PTY_ORDINARY_READ_SENTINEL');
      } finally {
        await terminal.close();
      }
    } finally {
      fixture.dispose();
    }
  },
  30_000,
);
