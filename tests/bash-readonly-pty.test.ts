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
export default {manifest:{id:'test.bash-pty',version:'1.0.0',apiVersion:1},setup(ctx){
ctx.provide.provider('offline-bash',{name:'offline-bash',capabilities:{thinking:false,streaming:true},async *stream(request){
 if(request.system.startsWith('[agentlab planning:auto]')){log({kind:'planning'});yield* text('null');return;}
 if(!request.tools.length){
  const payload=JSON.parse(request.messages[0].content);
  const decision=payload.currentUserRequest.text==='创建 pty-write.txt，内容为 verified。' && payload.operation.toolName==='write_file' && payload.operation.input.path==='pty-write.txt' && payload.operation.input.content==='verified'?'allow':'deny';
  log({kind:'judge',decision});yield* text(JSON.stringify({decision,reasonCode:'controlled_pty',reason:'受控审批'}));return;
 }
 const last=request.messages.at(-1).content;
 if(typeof last!=='string'){yield* text('BASH_PTY_COMPLETED');return;}
 const write=last==='创建 pty-write.txt，内容为 verified。'||last==='禁止创建 pty-denied.txt。';
 const input=write?{path:last.startsWith('创建')?'pty-write.txt':'pty-denied.txt',content:'verified'}:{command:last};
 yield {type:'message_start'};yield {type:'tool_use_start',id:'bash-call',name:write?'write_file':'bash'};
 yield {type:'tool_use_delta',id:'bash-call',input:JSON.stringify(input)};yield {type:'tool_use_stop',id:'bash-call'};
 yield {type:'message_stop',stopReason:'tool_use'};
}});
ctx.provide.telemetry('bash-events',{onEvent(event){if(['tool_result','permission_request','loop_end','tool_execution'].includes(event.type))log({kind:'event',event});}});
}};
`;

it.skipIf(process.platform !== 'linux')(
  '原样 pnpm dev、默认规划与 auto：原命令零审批，受控 reviewer 写入及拒绝生效',
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
        const nulCommand =
          "find src -type f -name '*.ts' -print0 | xargs -0 cat 2>/dev/null | wc -l";
        const nulExpected = execFileSync(
          '/usr/bin/bash',
          ['--noprofile', '--norc', '-p', '-c', nulCommand],
          { cwd: fixture.project, env: readOnlyShellEnvironment(), encoding: 'utf8' },
        );
        terminal.send(nulCommand);
        await terminal.wait(
          () => rows().filter((row) => row.event?.type === 'loop_end').length === 2,
          'NUL 管道没有完成',
        );
        expect(
          rows()
            .filter((row) => row.event?.type === 'tool_result')
            .at(-1)?.event?.result?.content,
        ).toBe(nulExpected);
        expect(
          rows().filter((row) => row.kind === 'judge' || row.event?.type === 'permission_request'),
        ).toHaveLength(0);
        for (const [i, browse] of [
          'ls -R src/synthetic 2>/dev/null | head -80',
          "cd . && find src/synthetic -name '*.ts' -type f | wc -l && cat src/synthetic/*.ts | wc -l",
        ].entries()) {
          const browseExpected = execFileSync(
            '/usr/bin/bash',
            ['--noprofile', '--norc', '-p', '-c', browse],
            { cwd: fixture.project, env: readOnlyShellEnvironment(), encoding: 'utf8' },
          );
          terminal.send(browse);
          await terminal.wait(
            () => rows().filter((row) => row.event?.type === 'loop_end').length === 3 + i,
            '真实 trace 的读取没有完成',
          );
          expect(
            rows()
              .filter((row) => row.event?.type === 'tool_result')
              .at(-1)?.event?.result?.content,
          ).toBe(browseExpected);
          expect(
            rows().filter(
              (row) => row.kind === 'judge' || row.event?.type === 'permission_request',
            ),
          ).toHaveLength(0);
        }
        terminal.send('创建 pty-write.txt，内容为 verified。');
        await terminal.wait(
          () => rows().filter((row) => row.event?.type === 'loop_end').length === 5,
          '受许可写入没有完成',
        );
        expect(readFileSync(join(fixture.project, 'pty-write.txt'), 'utf8')).toBe('verified');
        expect(rows().filter((row) => row.kind === 'judge')).toHaveLength(1);
        terminal.send('禁止创建 pty-denied.txt。');
        await terminal.wait(
          () => rows().filter((row) => row.event?.type === 'loop_end').length === 6,
          '受控拒绝没有完成',
        );
        expect(existsSync(join(fixture.project, 'pty-denied.txt'))).toBe(false);
        expect(rows().filter((row) => row.kind === 'judge')).toHaveLength(2);
        expect(rows().filter((row) => row.event?.type === 'permission_request')).toHaveLength(0);
        expect(
          rows()
            .filter((row) => row.event?.type === 'tool_result')
            .at(-1)?.event?.result?.isError,
        ).toBe(true);
      } finally {
        await terminal.close();
      }
    } finally {
      fixture.dispose();
    }
  },
  30_000,
);
