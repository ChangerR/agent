/** 配置和运行状态的唯一目录约定；只计算路径，不创建目录。 */
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const PROJECT_CONFIG = 'agent.config.json';

export interface AgentPaths {
  /** 保留启动位置的语义，但解析符号链接和相对路径。 */
  readonly cwd: string;
  readonly projectRoot: string;
  readonly agentHome: string;
  readonly globalConfigPath: string;
  readonly projectConfigPath: string;
  readonly projectId: string;
  readonly projectStateDir: string;
  readonly sessionsDir: string;
  readonly logsDir: string;
}

/** HOME 可以在启动/测试之间变化，不能在模块导入时缓存。 */
export function getGlobalConfigPath(): string {
  return join(homedir(), '.agent', 'config.json');
}

/** 尚未创建的路径按最近存在的父目录规范化，不吞掉权限等真实 I/O 错误。 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(canonicalPath(parent), basename(absolute));
  }
}

/** 最近的显式项目标记形成边界；不越过用户目录、系统临时目录或文件系统根。 */
export function resolveProjectRoot(cwd: string): string {
  const start = canonicalPath(cwd);
  const boundaries = new Set([canonicalPath(homedir()), canonicalPath(tmpdir())]);
  for (let current = start; ; current = dirname(current)) {
    // 明确在这些目录启动仍可把它们当作项目，但子目录不能被其配置静默吸收。
    if (current !== start && (boundaries.has(current) || dirname(current) === current)) break;
    // Git worktree/submodule 的 .git 是文件，不限定为目录，也不执行 git 命令。
    if ([PROJECT_CONFIG, '.git', 'package.json'].some(marker => existsSync(join(current, marker)))) return current;
    if (dirname(current) === current) break;
  }
  return start;
}

export function resolveAgentPaths(cwd: string): AgentPaths {
  const canonicalCwd = canonicalPath(cwd);
  const projectRoot = resolveProjectRoot(canonicalCwd);
  const globalConfigPath = getGlobalConfigPath();
  const agentHome = dirname(globalConfigPath);
  const identity = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
  const projectId = createHash('sha256').update(identity).digest('hex');
  const projectStateDir = join(agentHome, 'state', 'projects', projectId);
  return Object.freeze({
    cwd: canonicalCwd, projectRoot, agentHome, globalConfigPath,
    projectConfigPath: join(projectRoot, PROJECT_CONFIG), projectId, projectStateDir,
    sessionsDir: join(projectStateDir, 'sessions'), logsDir: join(projectStateDir, 'logs'),
  });
}
