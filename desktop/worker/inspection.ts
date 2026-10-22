import { execFile } from 'node:child_process';
import { definePlugin } from '../../src/sdk/index.js';
import { gitEnvironment, resolveGitExecutable } from './git-executable.js';
/** 桌面检查也是注册工具；内部读检查继续经过同一 ToolExecutor。 */
export function inspectionPlugin(resolveGit = resolveGitExecutable) {
  return definePlugin({
    manifest: { id: 'agentlab.desktop-inspection', version: '1.0.0', apiVersion: 1 },
    setup(ctx) {
      ctx.provide.tool('desktop_git_diff', {
        name: 'desktop_git_diff',
        description:
          'Inspect Git changes against HEAD for up to 200 existing ordinary project files authorized by glob/read_file. Excludes deleted, hidden, ignored and protected files. Includes pre-existing user changes; untracked files are not included.',
        risk: 'read',
        isConcurrencySafe: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        analyzeInput: () => ({
          patternTarget: 'ordinary-tracked-worktree',
          summary: '检查项目普通文件的 Git 差异（含已有改动，最多 200 个文件）',
        }),
        async execute(_input, context) {
          if (!context.invokeTool)
            return { isError: true, content: '检查需要唯一执行器的子工具入口。' };
          const listing = await context.invokeTool('glob', { pattern: '**/*' });
          if (listing.isError) return listing;
          const candidates = listing.content
            .split('\n')
            .filter((path) => path && !path.startsWith('('))
            .slice(0, 200);
          const allowed: string[] = [];
          for (const path of candidates) {
            context.signal.throwIfAborted();
            // 不能用 Git 读取绕过 read_file 的明确 deny/ask 和敏感路径检查。
            const check = await context.invokeTool('read_file', { path, limit: 1 });
            if (!check.isError) allowed.push(path);
          }
          if (!allowed.length) return { content: '没有本次已授权且可读取的普通项目文件。' };
          let executable: string;
          try {
            executable = await resolveGit(context.cwd);
          } catch {
            return {
              isError: true,
              content: '未找到可用的 Git 安装，请先安装 Git 并重新启动应用。',
            };
          }
          const args = [
            '--no-pager',
            '--no-optional-locks',
            '--literal-pathspecs',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'diff.external=',
            '-c',
            'core.pager=cat',
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            'HEAD',
            '--',
            ...allowed,
          ];
          return new Promise((resolve) => {
            execFile(
              executable,
              args,
              {
                cwd: context.cwd,
                signal: context.signal,
                windowsHide: true,
                maxBuffer: 2 * 1024 * 1024,
                env: gitEnvironment(),
              },
              (error, stdout) => {
                if (error)
                  resolve({
                    isError: true,
                    content: '无法检查 Git 差异：请确认已安装 Git、项目已有提交且任务未取消。',
                  });
                else
                  resolve({
                    content:
                      stdout ||
                      '本次已授权的普通文件与 HEAD 相同。未跟踪、已删除、隐藏和受保护文件未纳入。',
                  });
              },
            );
          });
        },
      });
    },
  });
}
