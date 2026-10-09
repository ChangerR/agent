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
afterAll(() => { rmSync(home, { recursive: true, force: true }); });
