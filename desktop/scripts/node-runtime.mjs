/** 开发只暂存当前 Node；分发才要求同一安装的完整许可证，不联网补资产。 */
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

export async function nodeLicenseCandidates(execPath) {
  const executable = await realpath(execPath);
  const bin = dirname(executable);
  const prefix = dirname(bin);
  const formula = basename(dirname(prefix));
  const docs = ['node', 'nodejs', ...(/^node@\d+$/.test(formula) ? [formula] : [])];
  return [
    ...new Set([
      ...[bin, prefix].flatMap((directory) =>
        ['LICENSE', 'LICENSE.txt'].map((name) => join(directory, name)),
      ),
      ...docs.flatMap((name) =>
        ['LICENSE', 'LICENSE.txt'].map((file) => join(prefix, 'share', 'doc', name, file)),
      ),
    ]),
  ];
}

export async function findNodeLicense({ execPath, nodeVersion, repoRoot, licensePath }) {
  const candidates = licensePath ? [resolve(licensePath)] : await nodeLicenseCandidates(execPath);
  // 此资产明确属于这个版本，不能把旧版许可自动用于任意新版 Node。
  if (!licensePath && nodeVersion === 'v22.23.2')
    candidates.push(join(repoRoot, 'desktop/assets/node-LICENSE.txt'));
  for (const path of candidates) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) continue;
      const content = await readFile(path);
      if (!content.toString('utf8').startsWith('Node.js is licensed for use as follows:')) continue;
      return { path, content, sha256: createHash('sha256').update(content).digest('hex') };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
}

export async function stageNodeRuntime({
  out,
  repoRoot,
  mode = 'development',
  execPath = process.execPath,
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  licensePath = process.env.AGENTLAB_NODE_LICENSE,
}) {
  if (!['development', 'distribution'].includes(mode)) throw new Error('未知桌面构建模式。');
  const license = await findNodeLicense({ execPath, nodeVersion, repoRoot, licensePath });
  if (mode === 'distribution' && !license) {
    throw new Error(
      `分发打包缺少 Node ${nodeVersion} 的完整 LICENSE。开发启动不需要此文件，可直接运行 node desktop/scripts/run.mjs。分发时请从当前 Node 安装目录或 https://github.com/nodejs/node/blob/${nodeVersion}/LICENSE 取得同版本官方完整文件，显式设置 AGENTLAB_NODE_LICENSE=/绝对路径/LICENSE 后重新运行 node desktop/scripts/package.mjs --validate；不会自动联网下载。`,
    );
  }
  const directory = join(out, 'node');
  await mkdir(directory, { recursive: true });
  // 不能让前次构建的旧 Node 许可证混入这次没有许可证的开发暂存。
  await rm(join(directory, 'LICENSE'), { force: true });
  await cp(execPath, join(directory, platform === 'win32' ? 'node.exe' : 'node'));
  if (license) await writeFile(join(directory, 'LICENSE'), license.content);
  const runtime = {
    platform,
    arch,
    nodeVersion,
    usage: mode,
    nodeLicense: license ? { sha256: license.sha256 } : null,
  };
  await writeFile(join(directory, 'runtime.json'), JSON.stringify(runtime));
  return runtime;
}

export async function assertDistributionRuntime(out, runtime) {
  if (runtime.usage !== 'distribution' || !runtime.nodeLicense?.sha256)
    throw new Error('开发暂存不能作为分发包；请运行 node desktop/scripts/package.mjs --validate。');
  const content = await readFile(join(out, 'node/LICENSE'));
  if (createHash('sha256').update(content).digest('hex') !== runtime.nodeLicense.sha256)
    throw new Error('随包 Node LICENSE 与本次分发构建记录不一致，请重新构建。');
}
