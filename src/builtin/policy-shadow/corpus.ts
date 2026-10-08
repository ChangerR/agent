/** 人工选取的边界样例；expected 是验收标签，不是某次真实用户的授权。 */
import type { ApprovalTool } from '../../sdk/index.js';
import { bashTool } from '../../tools/bash.js';
import { readFileTool } from '../../tools/read.js';
import { writeFileTool } from '../../tools/write.js';
import { PermissionEngine, createLegacyPolicy } from '../policy-legacy/index.js';
import { createDeterministicPolicy } from '../policy-deterministic-v2/index.js';
import type { ShadowFixture } from './types.js';
import { runOfflineShadow } from './offline.js';
const empty = () => ({ allow: [] as string[], ask: [] as string[], deny: [] as string[] });
function metadata(tool: typeof bashTool): ApprovalTool {
  const { execute: _execute, ...descriptor } = tool;
  return { ...descriptor, ownerPlugin: 'agentlab.local-tools', version: '1.0.0' };
}
export function curatedShadowFixtures(cwd: string): ShadowFixture[] {
  const read = metadata(readFileTool); const write = metadata(writeFileTool); const bash = metadata(bashTool);
  const sample = (id: string, tool: ApprovalTool, input: Record<string, unknown>, rationale: string, patch: Partial<ShadowFixture> = {}): ShadowFixture => ({ id, input: { cwd, tool, input }, mode: 'auto', rules: empty(), annotation: { source: 'curated-fixture', rationale }, ...patch });
  return [
    sample('project-read', read, { path: 'package.json' }, '完整验证的项目内普通文件读取；v1 auto 已经放行，不能声称新增节省模型调用。'),
    sample('sensitive-dotenv', read, { path: '.env' }, '声明 read 不能覆盖凭据路径保护；真实内容不会被样例打印。'),
    sample('outside-project', read, { path: '../outside-shadow-file.txt' }, '即使路径存在也不应跨项目边界确定性放行。'),
    sample('literal-shell', bash, { command: 'pwd' }, '字面量 Shell 仍受解释器、PATH 与环境影响；仅语法简单不足以授权。'),
    sample('project-script', bash, { command: 'npm test' }, 'npm test 会运行项目脚本，不能自动当成只读。'),
    sample('dynamic-shell', bash, { command: 'echo $(cat package.json)' }, '命令替换可能调用其他程序，应保持未知或需审核。'),
    sample('rule-priority-conflict', bash, { command: 'git push origin topic' }, 'v1 allow 先于 ask，v2 明确 ask 优先；必须显示迁移冲突。', { rules: { allow: ['bash(*)'], ask: ['bash(git push*)'], deny: [] } }),
    sample('dangerous-force-push', bash, { command: 'git push --force origin main' }, '危险操作不可因宽 allow 或 yolo 静默放行。', { mode: 'yolo', rules: { allow: ['bash(*)'], ask: [], deny: [] } }),
    sample('explicit-file-write', write, { path: 'shadow-output.txt', content: 'fixture content' }, '精确目标规则和项目内完整写入；仅评估，不创建文件。', { rules: { allow: ['write_file(="shadow-output.txt")'], ask: [], deny: [] } }),
    sample('explicit-src-write-grant', write, { path: 'src/shadow-output.ts', content: 'synthetic fixture; never written' }, '仅此合成样例显式授予 writeRoots:[src]。v1 auto 仍需 reviewer；v2 在完整验证且无 ask/deny/敏感约束后可放行。此标签不授予真实运行权限。', { writeRoots: ['src'], annotation: { source: 'curated-fixture', expectedCandidate: 'allow', rationale: '显式 src 写入范围是本样例的授权前提；没有该配置时不能复用此结论。' } }),
    sample('protected-hook-write', write, { path: '.git/hooks/pre-commit', content: 'never executed' }, '即使有精确 allow，受保护的执行入口仍需人工确认。', { rules: { allow: ['write_file(=".git/hooks/pre-commit")'], ask: [], deny: [] } }),
    sample('untrusted-read-declaration', { name: 'mcp__fixture__read', description: 'Claims read-only', risk: 'read', ownerPlugin: 'fixture.mcp', version: '1.0.0', inputSchema: { type: 'object' } }, { resource: 'unknown' }, '未知 MCP 的自称只读不是确定性证据。', { recordedReviewer: { legacy: { decision: 'ask', reasonCode: 'synthetic_recorded_fixture_ask' }, candidate: { decision: 'unknown', reasonCode: 'synthetic_recorded_fixture_unknown' } } }),
    sample('deny-still-first', read, { path: 'package.json' }, '明确 deny 在两种策略里都保持拒绝。', { rules: { allow: ['read_file'], ask: [], deny: ['read_file'] } }),
  ];
}
export function runCuratedShadow(cwd: string, options: { mode?: 'deterministic-only' | 'recorded-reviewer-fixtures'; signal?: AbortSignal; timeoutMs?: number } = {}) {
  return runOfflineShadow({ ...options, fixtures: curatedShadowFixtures(cwd),
    createLegacy(fixture) { const controller = new PermissionEngine({ mode: fixture.mode, rules: structuredClone(fixture.rules), dangerForceAsk: true }); if (fixture.sessionRules) controller.setSessionRules(fixture.sessionRules); return createLegacyPolicy(controller); },
    createCandidate(fixture) { const candidate = createDeterministicPolicy({ cwd: fixture.input.cwd, mode: fixture.mode, rules: structuredClone(fixture.rules), writeRoots: fixture.writeRoots }); if (fixture.sessionRules) candidate.controller?.setSessionRules(fixture.sessionRules); return candidate; },
  });
}
