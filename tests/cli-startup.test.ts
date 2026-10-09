import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AgentConfigSchema } from '../src/core/config.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-startup-')); roots.push(root);
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const config = join(home, '.agent', 'config.json');
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), resolve('src/cli/index.ts'), ...args], {
    cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', OPENAI_BASE_URL: 'https://secret-endpoint.invalid', STARTUP_SECRET: 'never-persist-this' }, encoding: 'utf8', timeout: 15000,
  });
  return { home, project, config, run };
}
it('实际 CLI 无 key 首启初始化安全内置默认和项目状态目录；再次启动不覆盖', () => {
  const f = fixture();
  expect(f.run('--command', '/permissions', '--json')).toContain('"mode":"ask"');
  expect(existsSync(f.config)).toBe(true);
  const initial = readFileSync(f.config, 'utf8');
  expect(JSON.parse(initial)).toEqual(AgentConfigSchema.parse({}));
  expect(initial).not.toContain('secret');
  const dirs = execFileSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `import {resolveAgentPaths} from ${JSON.stringify(resolve('src/core/paths.ts'))}; console.log(JSON.stringify(resolveAgentPaths(process.cwd())))`], { cwd: f.project, env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, encoding: 'utf8' });
  const paths = JSON.parse(dirs);
  for (const path of [paths.sessionsDir, paths.logsDir]) expect(statSync(path).isDirectory()).toBe(true);
  if (process.platform !== 'win32') expect(statSync(f.config).mode & 0o777).toBe(0o600);
  const custom = '{ "permissionMode": "auto", "customUnknown": 42 }\n';
  writeFileSync(f.config, custom);
  expect(f.run('--command', '/permissions', '--json')).toContain('"mode":"auto"');
  expect(readFileSync(f.config, 'utf8')).toBe(custom);
});
it('初始化不把项目权限、插件授权、相对路径或环境配置提升为全局默认', () => {
  const f = fixture();
  writeFileSync(join(f.project, 'agent.config.json'), JSON.stringify({ provider: 'fake', permissionMode: 'yolo', permissions: { allow: ['read_file(*)'] }, modelsFile: './private-models.json' }));
  expect(f.run('--command', '/permissions', '--json')).toContain('"mode":"yolo"');
  expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual(AgentConfigSchema.parse({}));
});
it('help 和无效参数不初始化，已有无效用户配置不会被覆盖', () => {
  const f = fixture(); f.run('--help'); expect(existsSync(f.config)).toBe(false);
  expect(() => f.run('--invalid-option')).toThrow(); expect(existsSync(f.config)).toBe(false);
  mkdirSync(join(f.home, '.agent')); writeFileSync(f.config, '{ invalid');
  expect(() => f.run('--sessions')).toThrow(); expect(readFileSync(f.config, 'utf8')).toBe('{ invalid');
});
it('SDK 配置读取保持只读；并发 CLI 首启不会覆盖或留下临时配置', async () => {
  const f = fixture();
  const { loadConfigWithSources } = await import('../src/core/config.js');
  const { spawn } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  const oldHome = process.env.HOME; const oldProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = f.home; process.env.USERPROFILE = f.home;
    expect(loadConfigWithSources(f.project).config.permissionMode).toBe('ask');
    expect(existsSync(join(f.home, '.agent'))).toBe(false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', `import {initializeCliHome} from ${JSON.stringify(resolve('src/cli/initialize.ts'))}; initializeCliHome(process.cwd());`], {
      cwd: f.project, env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, stdio: 'pipe',
    });
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? done() : reject(new Error(errors)));
  })));
  expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual(AgentConfigSchema.parse({}));
  expect(readdirSync(join(f.home, '.agent')).sort()).toEqual(['config.json', 'state']);
});
