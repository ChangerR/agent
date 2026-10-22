import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build.mjs';
await buildDesktop({ mode: 'development' });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [joinPath(root, 'desktop/dist'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
  env,
});
function joinPath(...parts) {
  return resolve(...parts);
}
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
child.on('error', () => {
  console.error('无法启动 Electron，请先运行 node node_modules/electron/install.js');
  process.exitCode = 1;
});
