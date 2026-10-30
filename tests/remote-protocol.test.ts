import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { RemoteChannel } from '../desktop/remote/channel.js';
import { sshProjectSchema } from '../desktop/remote/protocol.js';
import { shellQuote, sshErrorCode } from '../desktop/main/ssh-host.js';
import { ProjectCatalog } from '../desktop/main/project-catalog.js';

function pair() {
  const a = new PassThrough(),
    b = new PassThrough(),
    epoch = randomUUID();
  const first = new RemoteChannel(a, b, epoch),
    second = new RemoteChannel(b, a, epoch);
  return { first, second, a, b };
}
describe('SSH 分帧与身份边界', () => {
  it('大逻辑消息分片后完整重组，双向请求可交错并保持关联', async () => {
    const { first, second } = pair();
    try {
      first.handle(async (_method, payload) => payload);
      second.handle(async (_method, payload) => payload);
      const value = { text: '中文流式内容'.repeat(30000) };
      const [one, two] = await Promise.all([
        first.request('echo', value),
        second.request('other', { id: 'reverse' }),
      ]);
      expect(one).toEqual(value);
      expect(two).toEqual({ id: 'reverse' });
    } finally {
      first.close();
      second.close();
    }
  });
  it('连接丢失拒绝未结算请求；旧 epoch 和超大物理帧直接关闭', async () => {
    const p = pair();
    p.second.handle(() => new Promise(() => {}));
    const pending = p.first.request('waiting', null);
    p.first.close();
    await expect(pending).rejects.toThrow('CONNECTION_LOST');
    p.second.close();
    const a = new PassThrough(),
      output = new PassThrough(),
      c = new RemoteChannel(a, output, randomUUID());
    const closed = new Promise<string>((r) => c.once('closed', r));
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(65537);
    a.write(bytes);
    expect(await closed).toBe('PROTOCOL_ERROR');
  });
  it('不允许把 SSH 目标解释成选项或命令，远程 shell 路径独立编码', () => {
    for (const target of [
      '-oProxyCommand=bad',
      'host;touch bad',
      'host\ncommand',
      'host$(command)',
    ])
      expect(sshProjectSchema.safeParse({ target, path: '/tmp/project' }).success).toBe(false);
    expect(shellQuote("/home/a'b/node")).toBe("'/home/a'\\''b/node'");
  });
  it('认证/信任错误只映射安全错误码，不回传原始 stderr', () => {
    expect(sshErrorCode(new Error(), 'Host key verification failed. secret')).toBe(
      'HOST_UNTRUSTED',
    );
    expect(sshErrorCode(new Error(), 'Permission denied (publickey)')).toBe('AUTH_FAILED');
    expect(sshErrorCode({ name: 'AbortError' })).toBe('ABORTED');
  });
  it('不同主机的相同目录分别持久化；目标身份变化阻止静默复用', () => {
    const c = new ProjectCatalog();
    const a = c.openRemote({ target: 'first', path: '/srv/repo', mappings: {} }, 'identity-a');
    const b = c.openRemote({ target: 'second', path: '/srv/repo', mappings: {} }, 'identity-b');
    expect(a.id).not.toBe(b.id);
    expect(c.projects).toHaveLength(2);
    expect(() =>
      c.openRemote({ target: 'first', path: '/srv/repo', mappings: {} }, 'changed'),
    ).toThrow('HOST_TARGET_CHANGED');
    const restored = new ProjectCatalog();
    restored.restore({ projects: c.projects });
    expect(restored.projects).toEqual(c.projects);
  });
});
