/** 项目环境变量只从规范化项目根加载；绝不输出文件内容或凭据。 */
import { join } from 'node:path';
import { constants } from 'node:os';

export function loadProjectEnv(projectRoot: string): void {
  const path = join(projectRoot, '.env');
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('当前 Node.js 不支持加载项目 .env；请使用 Node.js 22.19.0 或更新版本重新启动。');
  }
  try {
    // Node 原生语义：已存在的进程变量（包括空字符串）优先，不被 .env 覆盖。
    process.loadEnvFile(path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return; // .env 可选，允许只使用 shell 环境变量。
    // 原始错误可能包含被解析的文本；只显示受限错误码和应检查的文件。
    const label = typeof code === 'string' && Object.hasOwn(constants.errno, code) ? `（${code}）` : '';
    throw new Error(`无法加载项目环境文件 ${path}${label}；请检查它是可读取的文件，然后重新启动。`);
  }
}
