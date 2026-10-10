#!/usr/bin/env python3
"""隔离 HOME/项目，以真实 pnpm dev + PTY 验证只读 shell 与 auto 模式重启持久化。"""
import fcntl
import json
import os
import pathlib
import pty
import select
import shlex
import shutil
import signal
import struct
import sys
import tempfile
import termios
import time

REPO = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parents[1]).resolve()
COMMAND = 'ls -la && echo "---" && cat package.json'


def main():
    with tempfile.TemporaryDirectory(prefix='agent-shell-pty-') as temp:
        root = pathlib.Path(temp)
        home, project = root / 'home', root / 'project'
        home.mkdir()
        project.mkdir()
        (project / '.git').mkdir()
        log = root / 'events.jsonl'
        config = project / 'agent.config.json'
        entry = root / 'offline-provider.mjs'
        plugin = r'''
import { appendFileSync } from 'node:fs';
const log = __LOG__;
const text = value => [{type:'message_start'}, {type:'text_delta',text:value}, {type:'message_stop',stopReason:'end_turn'}, {type:'usage',inputTokens:10,outputTokens:10}];
export default {
  manifest: {id:'test.shell-pty',version:'1.0.0',apiVersion:1},
  setup(ctx) {
    ctx.provide.provider('shell-pty', {
      name:'shell-pty', capabilities:{thinking:false,streaming:true},
      async *stream(request) {
        appendFileSync(log, JSON.stringify({pid:process.pid,kind:'provider_request',judge:request.tools.length===0})+'\n');
        let events;
        if (!request.tools.length) events = text(JSON.stringify({decision:'ask',reasonCode:'offline_pty_review',reason:'离线审批测试'}));
        else if (typeof request.messages.at(-1)?.content === 'string') events = [
          {type:'message_start'}, {type:'tool_use_start',id:'pty-shell',name:'bash'},
          {type:'tool_use_delta',id:'pty-shell',input:JSON.stringify({command:__COMMAND__})},
          {type:'tool_use_stop',id:'pty-shell'}, {type:'message_stop',stopReason:'tool_use'},
          {type:'usage',inputTokens:10,outputTokens:10}
        ];
        else events = text('PTY_SHELL_COMPLETED');
        for (const event of events) yield event;
      }
    });
    ctx.provide.telemetry('shell-pty-log', {onEvent(event) {
      if (['model_request','tool_call','tool_result','permission_request','permission_decision','loop_end'].includes(event.type))
        appendFileSync(log, JSON.stringify({pid:process.pid,kind:'event',event})+'\n');
    }});
  }
};
'''.replace('__LOG__', json.dumps(str(log))).replace('__COMMAND__', json.dumps(COMMAND))
        entry.write_text(plugin)
        config.write_text(json.dumps({'provider': 'shell-pty', 'model': 'offline-pty-model', 'pluginEntries': [str(entry)], 'permissionMode': 'ask', 'preserveUnknown': True}))
        package = {'name': 'shell-pty-fixture', 'private': True, 'scripts': {'dev': 'node --import ' + shlex.quote(str(REPO / 'node_modules/tsx/dist/loader.mjs')) + ' ' + shlex.quote(str(REPO / 'src/cli/index.ts'))}}
        (project / 'package.json').write_text(json.dumps(package) + '\n')
        pnpm = shutil.which('pnpm')
        assert pnpm, 'pnpm is required'
        env = {'HOME': str(home), 'USERPROFILE': str(home), 'PATH': os.environ.get('PATH', ''), 'TERM': 'xterm-256color', 'AGENTLAB_SCREEN': 'alt', 'NO_COLOR': '1', 'XDG_DATA_HOME': str(home / '.local/share'), 'COREPACK_ENABLE_NETWORK': '0'}
        reports = []
        for run in range(2):
            start = len(read_log(log))
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(project)
                os.execve(pnpm, [pnpm, 'dev'], env)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
            output = bytearray()

            def pump(duration=0.05):
                ready, _, _ = select.select([fd], [], [], duration)
                if ready:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        data = b''
                    output.extend(data)

            def wait_until(predicate, description, seconds=12):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline:
                    pump()
                    if predicate():
                        return
                raise AssertionError(description + '\nTerminal tail:\n' + output.decode(errors='replace')[-10000:] + '\nEvents:\n' + json.dumps(read_log(log)[start:], ensure_ascii=False)[-8000:])

            def send(value):
                os.write(fd, value.encode() + b'\r')

            try:
                wait_until(lambda: b'AgentLab' in output and b'/settings' in output, 'TUI did not initialize')
                if run == 0:
                    send('/mode auto')
                    wait_until(lambda: json.loads(config.read_text()).get('permissionMode') == 'auto', '/mode auto did not persist')
                else:
                    assert json.loads(config.read_text())['permissionMode'] == 'auto'
                panel_start = len(output)
                send('/permissions')
                wait_until(lambda: '本项目启动模式: auto'.encode() in output[panel_start:], 'persisted auto mode not visible in TUI')
                panel_end = len(output)
                os.write(fd, b'\x1b')
                wait_until(lambda: 'Enter 发送'.encode() in output[panel_end:], 'permissions picker did not close')
                send('Inspect the project package with the requested read-only command.')
                wait_until(lambda: any(item.get('event', {}).get('type') == 'loop_end' for item in read_log(log)[start:]) or any(item.get('event', {}).get('type') == 'permission_request' for item in read_log(log)[start:]), 'shell request did not finish or reach approval')
                items = read_log(log)[start:]
                events = [item['event'] for item in items if item['kind'] == 'event']
                judge = sum(item['kind'] == 'provider_request' and item['judge'] for item in items)
                manual = sum(event['type'] == 'permission_request' for event in events)
                results = [event['result'] for event in events if event['type'] == 'tool_result']
                report = {'run': run + 1, 'persistedMode': json.loads(config.read_text())['permissionMode'], 'judge': judge, 'manual': manual, 'executed': sum(event['type'] == 'tool_call' for event in events), 'results': results}
                reports.append(report)
                assert judge == 0 and manual == 0, json.dumps(report, ensure_ascii=False)
                assert len(results) == 1 and not results[0].get('isError'), json.dumps(report, ensure_ascii=False)
                assert '---\n' in results[0]['content'] and 'shell-pty-fixture' in results[0]['content'], json.dumps(report, ensure_ascii=False)
                assert any(event['type'] == 'loop_end' and event['reason'] == 'completed' for event in events), json.dumps(report, ensure_ascii=False)
            finally:
                try:
                    os.write(fd, b'\x03\x03')
                    deadline = time.monotonic() + 1.5
                    while time.monotonic() < deadline:
                        pump()
                        stopped, _ = os.waitpid(pid, os.WNOHANG)
                        if stopped:
                            break
                    else:
                        os.killpg(pid, signal.SIGTERM)
                        os.waitpid(pid, 0)
                except (OSError, ChildProcessError):
                    pass
                os.close(fd)
        assert json.loads(config.read_text())['preserveUnknown'] is True
        print(json.dumps({'command': COMMAND, 'launch': 'pnpm dev', 'runs': reports}, ensure_ascii=False, indent=2))


def read_log(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


if __name__ == '__main__':
    main()
