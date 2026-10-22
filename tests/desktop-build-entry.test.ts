/** 缺少 LICENSE 的真实 Node 安装布局：开发入口可用，分发入口仍严格校验。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const runtimeTools = await import(
  new URL('../desktop/scripts/node-runtime.mjs', import.meta.url).href
);
let temporary: string;
let root: string;
let executable: string;
let preload: string;
let env: NodeJS.ProcessEnv;
const licenseFixture =
  'Node.js is licensed for use as follows:\nunit test fixture, never distributed\n';

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'agent-desktop-entry-'));
  root = join(temporary, 'app');
  const home = join(temporary, 'home');
  const bin = join(temporary, 'manager', 'versions', 'node', process.version, 'bin');
  await mkdir(root);
  await mkdir(home);
  await mkdir(bin, { recursive: true });
  executable = join(bin, process.platform === 'win32' ? 'node.exe' : 'node');
  await cp(process.execPath, executable);
  for (const name of ['package.json', 'tsconfig.json', 'src', 'desktop'])
    await cp(join(repo, name), join(root, name), {
      recursive: true,
      filter: (source) =>
        !['dist', 'release', '.validation'].some(
          (part) =>
            source === join(repo, 'desktop', part) ||
            source.startsWith(join(repo, 'desktop', part) + '/'),
        ),
    });
  // 即使测试机恰为 v22.23.2，也不能让仓库的对应版本资产掩盖缺失布局。
  await rm(join(root, 'desktop/assets/node-LICENSE.txt'), { force: true });
  await symlink(
    resolve(repo, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  preload = join(temporary, 'electron-launch.cjs');
  await writeFile(
    preload,
    `
const Module = require('node:module');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const load = Module._load, spawn = cp.spawn;
Module._load = function(name, ...args) { return name === 'electron' ? 'agent-test-electron' : load.call(this, name, ...args); };
cp.spawn = function(file, args, options) {
 if (file !== 'agent-test-electron') return spawn.call(this, file, args, options);
 const out = args[0];
 const runtime = JSON.parse(fs.readFileSync(path.join(out, 'node/runtime.json'), 'utf8'));
 if (runtime.usage !== 'development' || runtime.nodeLicense !== null || fs.existsSync(path.join(out, 'node/LICENSE'))) throw Error('开发暂存状态错误');
 for (const file of ['main/index.cjs','preload/index.cjs','worker/index.mjs','renderer/index.html']) if (!fs.existsSync(path.join(out,file))) throw Error('缺少真实构建产物');
 console.log('ELECTRON_LAUNCH_REACHED');
 return spawn.call(this, process.execPath, ['-e', 'process.exit(0)'], options);
};
Module.syncBuiltinESMExports();
`,
  );
  env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
});
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe('真实开发 / 打包入口', () => {
  it('没有 LICENSE 的 Node 安装执行真实 build.mjs 仍完成开发构建', async () => {
    const { stdout } = await exec(executable, ['desktop/scripts/build.mjs'], {
      cwd: root,
      env,
      timeout: 10_000,
    });
    expect(stdout).toContain('桌面开发构建完成');
    expect(
      JSON.parse(await readFile(join(root, 'desktop/dist/node/runtime.json'), 'utf8')),
    ).toMatchObject({ usage: 'development', nodeLicense: null, nodeVersion: process.version });
  });
  it('同样的安装执行真实 run.mjs 可到 Electron 启动阶段，无需变量或下载', async () => {
    const { stdout } = await exec(executable, ['--require', preload, 'desktop/scripts/run.mjs'], {
      cwd: root,
      env,
      timeout: 10_000,
    });
    expect(stdout).toContain('ELECTRON_LAUNCH_REACHED');
    expect(stdout).toContain('桌面开发构建完成');
  });
  it('同样的安装不能作为分发包，真实 package --validate 给出同版本指引', async () => {
    const result = await exec(executable, ['desktop/scripts/package.mjs', '--validate'], {
      cwd: root,
      env,
      timeout: 10_000,
    }).then(
      () => ({ stderr: '' }),
      (error: { stderr: string }) => error,
    );
    expect(result.stderr).toContain(`分发打包缺少 Node ${process.version}`);
    expect(result.stderr).toContain('开发启动不需要此文件');
    expect(result.stderr).toContain(
      `https://github.com/nodejs/node/blob/${process.version}/LICENSE`,
    );
  });
});

it('在解析后的版本目录发现 nvm / 官方前缀与 Homebrew 文档许可证，忽略其他 Node 安装', async () => {
  const install = join(temporary, 'Cellar', 'node@24', '24.11.1');
  const binary = join(install, 'bin', 'node');
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, 'test binary');
  const documented = join(install, 'share/doc/node@24/LICENSE');
  await mkdir(dirname(documented), { recursive: true });
  await writeFile(documented, licenseFixture);
  const linkedPrefix = join(temporary, 'linked-install');
  await symlink(install, linkedPrefix, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = join(linkedPrefix, 'bin', 'node');
  const found = await runtimeTools.findNodeLicense({
    execPath: linked,
    nodeVersion: 'v24.11.1',
    repoRoot: root,
  });
  expect(found.path).toBe(documented);
  await rm(documented);
  await writeFile(join(install, 'LICENSE'), licenseFixture);
  expect(
    (
      await runtimeTools.findNodeLicense({
        execPath: linked,
        nodeVersion: 'v24.11.1',
        repoRoot: root,
      })
    ).path,
  ).toBe(join(install, 'LICENSE'));
});

it('darwin 开发暂存清除旧 LICENSE；分发验证拒绝开发暂存与被修改的许可证', async () => {
  const fake = join(temporary, 'fake-node');
  await writeFile(fake, 'test binary');
  const out = join(temporary, 'staging');
  await mkdir(join(out, 'node'), { recursive: true });
  await writeFile(join(out, 'node/LICENSE'), 'stale previous license');
  const options = {
    out,
    repoRoot: root,
    execPath: fake,
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v24.11.1',
    licensePath: '',
  };
  const development = await runtimeTools.stageNodeRuntime(options);
  expect(development).toMatchObject({
    platform: 'darwin',
    arch: 'arm64',
    usage: 'development',
    nodeLicense: null,
  });
  await expect(readFile(join(out, 'node/LICENSE'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(runtimeTools.assertDistributionRuntime(out, development)).rejects.toThrow(
    '开发暂存不能作为分发包',
  );
  const licensePath = join(temporary, 'test-LICENSE');
  await writeFile(licensePath, licenseFixture);
  const distribution = await runtimeTools.stageNodeRuntime({
    ...options,
    mode: 'distribution',
    licensePath,
  });
  await runtimeTools.assertDistributionRuntime(out, distribution);
  await writeFile(join(out, 'node/LICENSE'), 'tampered');
  await expect(runtimeTools.assertDistributionRuntime(out, distribution)).rejects.toThrow('不一致');
});
