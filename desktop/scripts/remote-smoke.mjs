import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
await build({
  entryPoints: ['desktop/scripts/remote-smoke.ts'],
  outfile: 'desktop/.validation/remote/smoke.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  banner: {
    js: "import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);",
  },
});
const child = spawn(
  process.execPath,
  [resolve('desktop/.validation/remote/smoke.mjs'), ...process.argv.slice(2)],
  { stdio: 'inherit', windowsHide: true },
);
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
