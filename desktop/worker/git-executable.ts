import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, sep } from 'node:path';

/** 解析宿主 PATH 中项目外的绝对 Git 路径，避免 Windows 从项目目录拾取 git.exe。 */
export async function resolveGitExecutable(cwd: string): Promise<string> {
  const envPath =
    Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const project = await realpath(cwd);
  for (const directory of envPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = await realpath(
        join(directory, process.platform === 'win32' ? 'git.exe' : 'git'),
      );
      const target = relative(project, candidate);
      if (!target || (target !== '..' && !target.startsWith('..' + sep) && !isAbsolute(target)))
        continue;
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('未找到项目外的 Git 安装');
}
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EXTERNAL_DIFF: '',
    GIT_PAGER: 'cat',
  };
}
