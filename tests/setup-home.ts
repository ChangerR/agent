/** 所有测试使用隔离的用户目录，禁止读取/写入运行机器的真实配置和状态。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'agentlab-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
// 默认 provider 工厂也会读取环境变量；测试只给固定假凭据，不使用机器上的值。
process.env.ANTHROPIC_API_KEY = 'test-only-never-sent';
process.env.OPENAI_API_KEY = 'test-only-never-sent';
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.OPENAI_BASE_URL;
// 代理回归自行显式设置假地址；其余测试不能继承宿主网络配置。
for (const name of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
])
  delete process.env[name];
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
