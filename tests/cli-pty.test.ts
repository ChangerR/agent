/** Linux 真 PTY 冒烟；其余平台的设置/搜索逻辑由现有 Vitest suites 验证。 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';
import { createPtyProject } from './helpers/pty.js';

const command = 'ls -la && echo "---" && cat package.json';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
// 单一离线插件，只脚本化模型输出；权限管线、工具、持久化和 CLI 均使用真实实现。
const provider = `
import { appendFileSync } from 'node:fs';
const log = row => appendFileSync(process.env.HOME + '/events.jsonl', JSON.stringify(row) + '\\n');
const text = value => [{type:'message_start'}, {type:'text_delta',text:value}, {type:'message_stop',stopReason:'end_turn'}];
export default {
  manifest:{id:'test.cli-pty',version:'1.0.0',apiVersion:1},
  setup(ctx) {
    log({kind:'startup',cwd:process.cwd(),argv:process.argv});
    ctx.provide.provider('offline-pty', {
      name:'offline-pty',capabilities:{thinking:false,streaming:true},
      async *stream(request, signal) {
        log({kind:'request',judge:request.tools.length === 0});
        const last = request.messages.at(-1)?.content;
        if (!request.tools.length) { yield* text(JSON.stringify({decision:'ask',reasonCode:'offline',reason:'Offline review'})); return; }
        if (typeof last !== 'string') { yield* text('PTY_REQUEST_COMPLETED'); return; }
        if (last === 'cancel') {
          log({kind:'waiting'});
          await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, {once:true}); });
          return;
        }
        const calls = last === 'failure' ? [{name:'grep',input:{pattern:'[',glob:'sample.md'}}] : [
          {name:'bash',input:{command:${JSON.stringify(command)}}},
          {name:'glob',input:{pattern:'sample.md'}},
          {name:'grep',input:{pattern:'needle',glob:'sample.md'}}
        ];
        yield {type:'message_start'};
        for (let i = 0; i < calls.length; i++) {
          const id = 'pty-' + i;
          yield {type:'tool_use_start',id,name:calls[i].name};
          yield {type:'tool_use_delta',id,input:JSON.stringify(calls[i].input)};
          yield {type:'tool_use_stop',id};
        }
        yield {type:'message_stop',stopReason:'tool_use'};
      }
    });
    ctx.provide.telemetry('pty-events',{onEvent(event) {
      if (['tool_call','tool_result','permission_request','loop_end'].includes(event.type)) log({kind:'event',event});
    }});
  }
};
`;

type RecordRow = { kind: string; judge?: boolean; cwd?: string; argv?: string[]; event?: { type: string; name?: string; reason?: string; result?: { content: string; isError?: boolean } } };
it.skipIf(process.platform !== 'linux')('Linux pnpm dev 真 PTY：单选自动保存、取消、重启、shell/搜索零审批及失败恢复', async () => {
  const fixture = createPtyProject();
  const configPath = join(fixture.project, 'agent.config.json');
  const logPath = join(fixture.home, 'events.jsonl');
  const rows = (): RecordRow[] => existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    // 证明确实沿用仓库 package.json/dev 和每个源码字节，而非重造启动入口。
    const sourceFiles = readdirSync(join(fixture.repo, 'src'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => relative(fixture.repo, join(entry.parentPath, entry.name)));
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', ...sourceFiles]) {
      expect(digest(join(fixture.project, name))).toBe(digest(join(fixture.repo, name)));
    }
    writeFileSync(join(fixture.project, 'offline.mjs'), provider);
    writeFileSync(join(fixture.project, 'sample.md'), 'needle PTY_SEARCH_SENTINEL\n');
    writeFileSync(configPath, JSON.stringify({ provider:'offline-pty',model:'offline-model',pluginEntries:['./offline.mjs'],permissionMode:'ask',preserveUnknown:true }));
    for (let run = 0; run < 2; run++) {
      const start = rows().length; const terminal = fixture.launch();
      try {
        await terminal.wait(() => terminal.output.includes('/settings') && terminal.output.includes('Enter 发送'), 'CLI 未就绪');
        const startup = rows().slice(start).find(row => row.kind === 'startup');
        expect(startup?.cwd).toBe(fixture.project);
        expect(startup?.argv?.slice(1)).toEqual([join(fixture.project, 'src/cli/index.ts')]);
        expect(terminal.output).toContain(JSON.parse(readFileSync(join(fixture.repo, 'package.json'), 'utf8')).scripts.dev);
        if (run === 0) {
          terminal.send('/mode');
          await terminal.wait(() => terminal.output.includes('选择即保存并应用'), '模式菜单未显示');
          terminal.key('\x1b[B'); terminal.key('\r');
          await terminal.wait(() => fixture.readConfig().permissionMode === 'auto', '一次选择未落盘');
          const saved = readFileSync(configPath, 'utf8');
          const offset = terminal.output.length; terminal.send('/mode');
          await terminal.wait(() => terminal.output.slice(offset).includes('选择即保存并应用'), '取消菜单未显示');
          terminal.key('\x1b[B'); const cancelOffset = terminal.output.length; terminal.key('\x1b');
          await terminal.wait(() => terminal.output.slice(cancelOffset).includes('Enter 发送'), '取消后未回输入框');
          expect(readFileSync(configPath, 'utf8')).toBe(saved);
        }
        expect(fixture.readConfig()).toMatchObject({permissionMode:'auto',preserveUnknown:true});
        const successfulRequest = async () => {
          const offset = rows().length; terminal.send('success');
          await terminal.wait(() => rows().slice(offset).some(row => row.event?.type === 'loop_end'), '工具请求未完成');
          const records = rows().slice(offset);
          expect(records.filter(row => row.judge)).toHaveLength(0);
          expect(records.filter(row => row.event?.type === 'permission_request')).toHaveLength(0);
          expect(records.filter(row => row.event?.type === 'tool_call')).toHaveLength(3);
          const resultEvents = records.filter(row => row.event?.type === 'tool_result').map(row => row.event!);
          const results = resultEvents.map(event => event.result!);
          const result = (name: string) => resultEvents.find(event => event.name === name)!.result!.content;
          expect(results).toHaveLength(3); expect(results.every(result => !result.isError)).toBe(true);
          expect(result('bash')).toContain('---\n'); expect(result('bash')).toContain('"name": "agentlab"');
          expect(result('glob')).toContain('sample.md'); expect(result('grep')).toContain('PTY_SEARCH_SENTINEL');
          expect(records.at(-1)?.event).toMatchObject({type:'loop_end',reason:'completed'});
        };
        await successfulRequest();
        if (run === 1) {
          let offset = rows().length; terminal.send('failure');
          await terminal.wait(() => rows().slice(offset).some(row => row.event?.type === 'loop_end'), '失败请求未完成');
          expect(rows().slice(offset).find(row => row.event?.type === 'tool_result')?.event?.result?.isError).toBe(true);
          offset = rows().length; terminal.send('cancel');
          await terminal.wait(() => rows().slice(offset).some(row => row.kind === 'waiting'), '取消夹具未开始等待');
          terminal.key('\x1b');
          await terminal.wait(() => rows().slice(offset).some(row => row.event?.type === 'loop_end' && row.event.reason === 'aborted'), 'Esc 未中断');
          await successfulRequest();
        }
      } finally { await terminal.close(); }
    }
  } finally { fixture.dispose(); }
}, 70_000);
