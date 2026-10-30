import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageNodeRuntime } from './node-runtime.mjs';
export async function buildDesktop({ mode = 'development' } = {}) {
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
    entryPoints: [join(root, 'desktop/remote/broker-worker.ts')],
    outfile: join(out, 'broker/index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
  });
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
      filter: async (source, destination) => {
        if (source.includes(join(dirname(packagePath), 'node_modules'))) return false;
        // Windows 的运行中原生库不能 unlink；相同资产直接复用，避免中断已有应用。
        try {
          if ((await readFile(source)).equals(await readFile(destination))) return false;
        } catch (error) {
          if (!['ENOENT', 'EISDIR', 'EPERM'].includes(error.code)) throw error;
        }
        return true;
      },
    });
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      await copyPackage(dependency, createRequire(packagePath));
  }
  const require = createRequire(join(root, 'package.json'));
  for (const name of native) await copyPackage(name, require);
  await stageNodeRuntime({ out, repoRoot: root, mode });
  await writeFile(
    join(out, 'package.json'),
    JSON.stringify(
      {
        name: 'agentlab',
        productName: 'agentlab',
        version: '0.1.0',
        main: 'main/index.cjs',
        description: 'agentlab 本地 Agent 工作台',
        author: 'agentlab',
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
  console.log(`桌面${mode === 'development' ? '开发' : '分发'}构建完成：` + out);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildDesktop();
