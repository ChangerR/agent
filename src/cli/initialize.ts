/** CLI 首启准备：只写静态内置默认，绝不保存合并后的项目配置或环境变量。 */
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfigSchema } from '../core/config.js';
import { resolveAgentPaths } from '../core/paths.js';

export function initializeCliHome(cwd: string): void {
  const paths = resolveAgentPaths(cwd);
  mkdirSync(paths.agentHome, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.globalConfigPath)) {
    const temporary = join(paths.agentHome, `.config-${randomUUID()}.tmp`);
    // 先完整写临时文件，再用不可覆盖的原子链接发布；并发启动不会读到半份 JSON。
    try {
      writeFileSync(temporary, JSON.stringify(AgentConfigSchema.parse({}), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      try { linkSync(temporary, paths.globalConfigPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally {
      try { unlinkSync(temporary); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  for (const path of [paths.sessionsDir, paths.logsDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
}
