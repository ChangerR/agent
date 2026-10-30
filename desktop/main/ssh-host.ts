/** 系统 SSH 宿主：固定部署目录、无应用端口、所有模型请求反向交给本地 Broker。 */
import { spawn, execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { RuntimeSnapshot, WorkerRequest } from '../shared/protocol.js';
import { RemoteChannel } from '../remote/channel.js';
import { applySnapshotDelta, type SnapshotDelta } from '../remote/snapshots.js';
import { sshProjectSchema, type SshProjectInput } from '../remote/protocol.js';
import type { ProviderDescription } from '../../src/providers/semantics.js';
import type { RuntimeHost } from './runtime-host.js';

const options = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=3',
];
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export interface SshBroker {
  handle(method: string, payload: unknown): Promise<unknown>;
  activate(): void | Promise<unknown>;
  close(): void;
}
export interface WorkspaceRequirements {
  root: string;
  projectId: string;
  requirements: Array<{ name: string; models: string[] }>;
}
export interface SshHostOptions {
  project: SshProjectInput;
  archive: string;
  defaults: { provider: string; model: string };
  configure(workspace: WorkspaceRequirements): Promise<ProviderDescription[]>;
  broker: SshBroker;
  onState(state: RuntimeSnapshot): void;
  onExit(): void;
  onStatus?(message: string): void;
  /** 测试只覆盖该进程的环境，不读取远程真实 HOME。 */
  remoteHome?: string;
  expectedIdentity?: string;
}
export function sshErrorCode(error: unknown, stderr = '') {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
    return 'ABORTED';
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr))
    return 'HOST_UNTRUSTED';
  if (/permission denied|authentication failed/i.test(stderr)) return 'AUTH_FAILED';
  if (/timed out|no route to host|network is unreachable/i.test(stderr)) return 'CONNECTION_FAILED';
  return 'SSH_SETUP_FAILED';
}
function run(file: string, args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, signal },
      (e, stdout, stderr) => (e ? reject(new Error(sshErrorCode(e, stderr))) : resolve(stdout)),
    );
    child.stdin?.end(input);
  });
}
export class SshHost implements RuntimeHost {
  private channel?: RemoteChannel;
  private child?: ReturnType<typeof spawn>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private state?: RuntimeSnapshot;
  private stopped = false;
  private closing = false;
  private active = false;
  private setupAbort = new AbortController();
  private disposePromise?: Promise<void>;
  workspace?: WorkspaceRequirements;
  identity = '';
  readonly generation = randomUUID();
  constructor(private config: SshHostOptions) {
    config.project = sshProjectSchema.parse(config.project);
  }
  async connect() {
    const execute = (file: string, args: string[], input?: string) =>
      run(file, args, input, this.setupAbort.signal);
    try {
      const { target } = this.config.project;
      this.config.onStatus?.('验证 SSH 与远程环境');
      const resolved = await execute('ssh', ['-G', target]);
      const identityParts = resolved
        .split(/\r?\n/)
        .filter((line) => /^(hostname|port|user|proxyjump|proxycommand) /.test(line));
      this.identity = createHash('sha256').update(identityParts.join('\n')).digest('hex');
      if (this.config.expectedIdentity && this.config.expectedIdentity !== this.identity)
        throw new Error('HOST_TARGET_CHANGED');
      const environment = await execute('ssh', [
        ...options,
        target,
        'uname -s; uname -m; printf "%s\\n" "$HOME"',
      ]);
      const [os, arch, home] = environment.trim().split(/\r?\n/);
      if (os !== 'Linux' || arch !== 'x86_64' || !home?.startsWith('/') || /[\x00-\x1f]/.test(home))
        throw new Error('UNSUPPORTED_PLATFORM');
      const remoteHome = this.config.remoteHome ?? home;
      if (!remoteHome.startsWith('/') || /[\x00-\x1f]/.test(remoteHome))
        throw new Error('INVALID_HOME');
      const meta = JSON.parse(await readFile(this.config.archive + '.json', 'utf8')) as {
        buildId: string;
        sha256: string;
        size: number;
      };
      if (
        !/^[a-f0-9]{24}$/.test(meta.buildId) ||
        !/^[a-f0-9]{64}$/.test(meta.sha256) ||
        (await stat(this.config.archive)).size !== meta.size ||
        createHash('sha256')
          .update(await readFile(this.config.archive))
          .digest('hex') !== meta.sha256
      )
        throw new Error('INSTALL_INTEGRITY_FAILED');
      const base = remoteHome + '/.agentlab/remote/releases';
      const installation = base + '/' + meta.buildId;
      const exists = await execute('ssh', [
        ...options,
        target,
        'test -f ' +
          shellQuote(installation + '/.verified') +
          ' && cat ' +
          shellQuote(installation + '/.verified') +
          ' || true',
      ]);
      if (exists.trim() !== meta.sha256) {
        this.config.onStatus?.('上传并校验 Linux 离线服务包');
        const temporary = base + '/upload-' + randomUUID();
        await execute('ssh', [...options, target, 'umask 077; mkdir -p ' + shellQuote(temporary)]);
        const batch =
          'put "' +
          this.config.archive.replaceAll('\\', '/').replaceAll('"', '\\"') +
          '" "' +
          temporary +
          '/bundle.tgz"\n';
        if (/[\r\n]/.test(this.config.archive)) throw new Error('INVALID_ARCHIVE_PATH');
        // 先上传固定受控目录；项目路径始终不进入 shell/SFTP 命令。
        await execute(
          'sftp',
          ['-q', '-b', '-', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', target],
          batch,
        );
        const script = `set -eu
cd ${shellQuote(temporary)}
printf '%s  bundle.tgz\\n' ${shellQuote(meta.sha256)} | sha256sum -c - >/dev/null
tar -tzf bundle.tgz | LC_ALL=C awk 'BEGIN { ok=1 } /(^\\/|(^|\\/)\\.\\.(\\/|$))/ { ok=0 } END { exit !ok }'
mkdir unpack
tar -xzf bundle.tgz -C unpack --no-same-owner --no-same-permissions
test -z "$(find unpack -type l -print -quit)"
test -z "$(find unpack -type f -links +1 -print -quit)"
chmod 700 unpack/node/bin/node
unpack/node/bin/node --input-type=module -e 'import {createRequire} from "node:module"; const r=createRequire(import.meta.url); for (const n of ["tree-sitter","tree-sitter-bash"]) r("./unpack/node_modules/"+n); await import("./unpack/node_modules/tree-sitter-powershell/bindings/node/index.js")'
test ! -e ${shellQuote(installation)}
mv unpack ${shellQuote(installation)}
printf '%s' ${shellQuote(meta.sha256)} > ${shellQuote(installation + '/.verified')}
`;
        await execute('ssh', [...options, target, 'sh -s'], script);
      }
      this.config.onStatus?.('启动远程 Agent');
      const epoch = randomUUID();
      const command =
        (this.config.remoteHome ? 'env HOME=' + shellQuote(remoteHome) + ' ' : '') +
        shellQuote(installation + '/node/bin/node') +
        ' ' +
        shellQuote(installation + '/worker/index.mjs') +
        ' ' +
        shellQuote(epoch);
      this.child = spawn('ssh', [...options, target, command], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child.stderr?.resume();
      this.channel = new RemoteChannel(this.child.stdout!, this.child.stdin!, epoch);
      this.channel.handle((method, payload) => {
        if (!this.active || !['model.open', 'model.next', 'model.cancel'].includes(method))
          throw new Error('METHOD_UNAVAILABLE');
        return this.config.broker.handle(method, payload);
      });
      const lost = () => {
        if (this.stopped) return;
        this.stopped = true;
        this.active = false;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.config.broker.close();
        this.channel?.close();
        if (!this.closing) this.config.onExit();
      };
      this.channel.on('closed', lost);
      this.child.once('error', lost);
      this.child.once('exit', lost);
      this.channel.on('event', (method: string, payload: unknown) => {
        try {
          if (method === 'runtime.snapshot') this.state = payload as RuntimeSnapshot;
          else if (method === 'runtime.delta' && this.state)
            this.state = applySnapshotDelta(this.state, payload as SnapshotDelta);
          else throw new Error('INVALID_STATE');
          if (
            this.state?.generation !== this.generation ||
            !this.state.sessionId ||
            !Array.isArray(this.state.rows)
          )
            throw new Error('INVALID_STATE');
          this.config.onState(this.state);
        } catch {
          void this.channel!.request<RuntimeSnapshot>('runtime.snapshot', null)
            .then((state) => {
              if (state.generation !== this.generation) throw new Error('STALE_STATE');
              this.state = state;
              this.config.onState(state);
            })
            .catch(() => this.channel?.close());
        }
      });
      const hello = await this.channel.request<{ version: number; buildId: string }>('hello', null);
      if (hello.version !== 1 || hello.buildId !== meta.buildId)
        throw new Error('PROTOCOL_MISMATCH');
      this.heartbeat = setInterval(() => {
        void this.channel?.request('heartbeat', null, 10000).catch(() => this.channel?.close());
      }, 5000);
      this.workspace = await this.channel.request<WorkspaceRequirements>('workspace.resolve', {
        path: this.config.project.path,
        defaults: this.config.defaults,
      });
      const descriptions = await this.config.configure(this.workspace);
      await this.channel.request(
        'runtime.init',
        { generation: this.generation, descriptions },
        60000,
      );
      await this.config.broker.activate();
      this.active = true;
      await this.channel.request('runtime.activate', null);
      this.config.onStatus?.('远程工作区已连接 · 模型请求由本机发送');
    } catch (e) {
      this.channel?.close();
      this.child?.kill();
      this.config.broker.close();
      if (this.heartbeat) clearInterval(this.heartbeat);
      throw e;
    }
  }
  cancelConnect() {
    this.closing = true;
    this.stopped = true;
    this.active = false;
    this.setupAbort.abort();
    this.channel?.close('ABORTED');
    this.child?.kill();
    this.config.broker.close();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
  async request(action: WorkerRequest['action']) {
    if (!this.active || this.stopped || !this.channel || !this.state)
      throw new Error('CONNECTION_LOST');
    if (['init', 'init-settings', 'global-settings', 'dispose'].includes(action.type))
      throw new Error('METHOD_UNAVAILABLE');
    const operationId = action.type === 'submit' ? action.invocationId : randomUUID();
    await this.channel.request('runtime.action', { operationId, action }, 120000);
  }
  dispose() {
    return (this.disposePromise ??= this.finishDispose().catch((e) => {
      this.disposePromise = undefined;
      throw e;
    }));
  }
  private async finishDispose() {
    if (this.stopped) return;
    this.closing = true;
    try {
      if (this.channel) await this.channel.request('runtime.dispose', null, 60000);
      this.active = false;
      this.config.broker.close();
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.channel?.close();
      this.child?.stdin?.end();
    } catch (e) {
      this.closing = false;
      throw e;
    }
  }
}
