/** 测试项目必须有自己的根边界，不能继承运行环境祖先目录里的配置。 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
export async function mkdtempProject(prefix: string): Promise<string> {
  const path = await mkdtemp(prefix);
  await mkdir(join(path, '.git'));
  return path;
}
export function mkdtempProjectSync(prefix: string): string {
  const path = mkdtempSync(prefix);
  mkdirSync(join(path, '.git'));
  return path;
}
