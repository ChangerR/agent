/** Linux 真 PTY 原样 pnpm dev：保留默认规划、确定性 policy 和模型 reviewer，仅 provider 离线。 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readOnlyShellEnvironment } from '../src/tools/shell-readonly.js';
import { createPtyProject } from './helpers/pty.js';

const plugin = `
import {appendFileSync} from 'node:fs';
const log=row=>appendFileSync(process.env.HOME+'/bash-events.jsonl',JSON.stringify(row)+'\\n');
const text=value=>[{type:'message_start'},{type:'text_delta',text:value},{type:'message_stop',stopReason:'end_turn'}];
let emitted=false;
export default {manifest:{id:'test.bash-pty',version:'1.0.0',apiVersion:1},setup(ctx){
ctx.provide.provider('offline-bash',{name:'offline-bash',capabilities:{thinking:false,streaming:true},async *stream(request){
 if(request.system.startsWith('[agentlab planning:auto]')){log({kind:'planning'});yield* text('null');return;}
 if(!request.tools.length){log({kind:'judge'});yield* text(JSON.stringify({decision:'ask',reasonCode:'controlled_ask',reason:'受控审批'}));return;}
 if(emitted){yield* text('BASH_PTY_COMPLETED');return;}
 emitted=true; const input={command:request.messages.at(-1).content};
 yield {type:'message_start'};yield {type:'tool_use_start',id:'bash-call',name:'bash'};
 yield {type:'tool_use_delta',id:'bash-call',input:JSON.stringify(input)};yield {type:'tool_use_stop',id:'bash-call'};
 yield {type:'message_stop',stopReason:'tool_use'};
}});
ctx.provide.telemetry('bash-events',{onEvent(event){if(['tool_result','permission_request','loop_end','tool_execution'].includes(event.type))log({kind:'event',event});}});
}};
`;

it.skipIf(process.platform !== 'linux')(
  '原样 pnpm dev、默认规划与 auto：200+ TS 原命令输出一致、零 judge、零人工',
  async () => {
    const fixture = createPtyProject();
    const logPath = join(fixture.home, 'bash-events.jsonl');
    type Row = {
      kind: string;
      event?: {
        type: string;
        phase?: string;
        reasonCode?: string;
        result?: { content: string; isError?: boolean };
      };
    };
    const rows = (): Row[] =>
      existsSync(logPath)
        ? readFileSync(logPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    try {
      mkdirSync(join(fixture.project, 'src', 'synthetic'));
      for (let i = 0; i < 220; i++)
        writeFileSync(join(fixture.project, 'src', 'synthetic', `fixture-${i}.ts`), 'export {};\n');
      writeFileSync(join(fixture.project, 'offline.mjs'), plugin);
      writeFileSync(
        join(fixture.project, 'agent.config.json'),
        JSON.stringify({
          provider: 'offline-bash',
          model: 'controlled-pty',
          permissionMode: 'auto',
          pluginEntries: ['./offline.mjs'],
        }),
      );
      const command = `cd ${fixture.project} && ls -la && echo "---" && find src -type f -name '*.ts' | head -100 && echo "---" && wc -l $(find src -type f -name '*.ts') | tail -5`;
      const terminal = fixture.launch();
      try {
        await terminal.wait(() => terminal.output.includes('Enter 发送'), 'pnpm dev 未启动');
        const expected = execFileSync(
          '/usr/bin/bash',
          ['--noprofile', '--norc', '-p', '-c', command],
          { cwd: fixture.project, env: readOnlyShellEnvironment(), encoding: 'utf8' },
        );
        terminal.send(command);
        await terminal.wait(
          () => rows().some((row) => row.event?.type === 'loop_end'),
          '原命令没有完成',
        );
        const observed = rows();
        expect(observed.filter((row) => row.kind === 'planning')).toHaveLength(1);
        expect(
          observed.filter(
            (row) => row.kind === 'judge' || row.event?.type === 'permission_request',
          ),
        ).toHaveLength(0);
        const result = observed.find((row) => row.event?.type === 'tool_result')!.event!.result!;
        expect(result.isError).toBeFalsy();
        expect(result.content).toBe(expected);
        expect(
          observed.find(
            (row) => row.event?.type === 'tool_execution' && row.event.phase === 'policy',
          )?.event?.reasonCode,
        ).toBe('safe_read');
      } finally {
        await terminal.close();
      }
    } finally {
      fixture.dispose();
    }
  },
  30_000,
);
