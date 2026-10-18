import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'desktop/dist');
await mkdir(out, { recursive: true });
await bundle({
  entryPoints: [join(root, 'desktop/main/index.ts')],
  outfile: join(out, 'main/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
});
await bundle({
  entryPoints: [join(root, 'desktop/preload/index.ts')],
  outfile: join(out, 'preload/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
});
const native = ['tree-sitter', 'tree-sitter-bash', 'tree-sitter-powershell'];
await bundle({
  entryPoints: [join(root, 'desktop/worker/index.ts')],
  outfile: join(out, 'worker/index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: native,
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
// 只拷贝原生依赖闭包，避免打包本机 .env、配置、会话或整个仓库。
const copied = new Map();
async function copyPackage(name, from) {
  const packagePath = from.resolve(name + '/package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  if (copied.has(name)) {
    if (copied.get(name) !== manifest.version) throw new Error('原生依赖版本冲突：' + name);
    return;
  }
  copied.set(name, manifest.version);
  await cp(dirname(packagePath), join(out, 'node_modules', name), {
    recursive: true,
    dereference: true,
    filter: (source) => !source.includes(join(dirname(packagePath), 'node_modules')),
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    await copyPackage(dependency, createRequire(packagePath));
}
const require = createRequire(join(root, 'package.json'));
for (const name of native) await copyPackage(name, require);
await mkdir(join(out, 'node'), { recursive: true });
await cp(process.execPath, join(out, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
try {
  await access(nodeLicense);
  await cp(nodeLicense, join(out, 'node', 'LICENSE'));
} catch {
  if (process.version !== 'v22.23.2')
    throw new Error('随包 Node 的 LICENSE 缺失，请使用完整官方 Node 安装。');
  await cp(join(root, 'desktop/assets/node-LICENSE.txt'), join(out, 'node', 'LICENSE'));
}
await writeFile(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'agentlab-desktop',
      productName: 'AgentLab Desktop',
      version: '0.1.0',
      main: 'main/index.cjs',
      description: 'AgentLab Windows 聊天工作台',
      author: 'AgentLab',
      license: 'MIT',
    },
    null,
    2,
  ),
);
await viteBuild({
  configFile: false,
  root: join(root, 'desktop/renderer'),
  base: './',
  build: { outDir: join(out, 'renderer'), emptyOutDir: true, target: 'es2022' },
});
console.log('桌面构建完成：' + out);
