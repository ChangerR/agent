import { packager } from '@electron/packager';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { packagingOptions } from './packaging.mjs';
if (process.argv.slice(2).some((arg) => arg !== '--validate'))
  throw new Error('仅支持本机平台 / 架构打包；可传 --validate 只验证。');
await import('./build.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = JSON.parse(await readFile(resolve(root, 'desktop/dist/node/runtime.json'), 'utf8'));
const options = packagingOptions(root, process.platform, process.arch, runtime);
await access(resolve(root, 'desktop/dist/node/LICENSE'));
await access(resolve(root, 'desktop/dist/renderer/index.html'));
if (process.argv.includes('--validate'))
  console.log(
    '打包输入验证通过：' + process.platform + '/' + process.arch + '（未签名、未公证、未发布）',
  );
else {
  const result = await packager(options);
  console.log('桌面应用目录：' + result.join(', '));
}
