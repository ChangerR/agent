/** 构建目标 Linux 离线包；Node 与 LICENSE 必须由调用方提供，不在服务器安装依赖。 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function buildRemote({
  assets = process.env.AGENTLAB_REMOTE_ASSETS ?? join(root, 'desktop/remote-assets/linux-x64'),
  out = join(root, 'desktop/dist/remote/linux-x64'),
} = {}) {
  const native = ['tree-sitter', 'tree-sitter-bash', 'tree-sitter-powershell'];
  const input = await build({
    entryPoints: [join(root, 'desktop/remote/index.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: native,
    metafile: true,
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
  const buildId = createHash('sha256')
    .update(input.outputFiles[0].contents)
    .digest('hex')
    .slice(0, 24);
  await mkdir(join(out, 'worker'), { recursive: true });
  await writeFile(
    join(out, 'worker/index.mjs'),
    "const __AGENTLAB_REMOTE_BUILD__ = '" + buildId + "';\n" + input.outputFiles[0].text,
  );
  const require = createRequire(join(root, 'package.json')),
    copied = new Set();
  async function copyPackage(name, from) {
    if (copied.has(name)) return;
    copied.add(name);
    const packageFile = from.resolve(name + '/package.json'),
      packageRoot = dirname(packageFile);
    const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
    await cp(packageRoot, join(out, 'node_modules', name), {
      recursive: true,
      dereference: true,
      filter: (source) =>
        !source.includes(join(packageRoot, 'node_modules')) &&
        (!source.includes(join(packageRoot, 'prebuilds')) ||
          !/prebuilds[/\\][^/\\]+/.test(source) ||
          source.includes(join('prebuilds', 'linux-x64'))),
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyPackage(dependency, createRequire(packageFile));
  }
  for (const name of native) await copyPackage(name, require);
  await mkdir(join(out, 'node/bin'), { recursive: true });
  const executable = await readFile(join(assets, 'node'));
  if (
    executable.subarray(0, 4).toString('hex') !== '7f454c46' ||
    executable[4] !== 2 ||
    executable.readUInt16LE(18) !== 62
  )
    throw new Error('需要 Linux x64 ELF Node 二进制');
  await writeFile(join(out, 'node/bin/node'), executable, { mode: 0o755 });
  const license = await readFile(join(assets, 'LICENSE'));
  if (!license.toString().startsWith('Node.js is licensed for use as follows:'))
    throw new Error('缺少完整 Node LICENSE');
  await writeFile(join(out, 'node/LICENSE'), license);
  const files = [];
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name),
        relative = prefix + name;
      if ((await stat(path)).isDirectory()) await walk(path, relative + '/');
      else if (relative !== 'manifest.json') {
        const bytes = await readFile(path);
        files.push({
          path: relative,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      }
    }
  }
  await walk(out);
  const manifest = {
    version: 1,
    buildId,
    platform: 'linux',
    arch: 'x64',
    protocolVersion: 1,
    files,
  };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const archive = out + '.tgz';
  execFileSync('tar', ['-czf', archive, '-C', out, '.'], { windowsHide: true });
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(
    archive + '.json',
    JSON.stringify({ buildId, sha256, size: (await stat(archive)).size }),
  );
  console.log(JSON.stringify({ archive, buildId, sha256 }));
  return { archive, buildId, sha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildRemote();
