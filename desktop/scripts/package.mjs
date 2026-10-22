import { packager } from '@electron/packager';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
await import('./build.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const result = await packager({
  dir: resolve(root, 'desktop/dist'),
  out: resolve(root, 'desktop/release'),
  name: 'AgentLab Desktop',
  executableName: 'AgentLab Desktop',
  platform: process.platform,
  arch: process.arch,
  asar: false,
  prune: false,
  overwrite: true,
});
console.log('桌面应用目录：' + result.join(', '));
