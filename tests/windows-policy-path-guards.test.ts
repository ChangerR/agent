/**
 * Windows 安全分支回归：真实临时目录与目录链接 + platform 注入。
 * 这些测试验证策略分支和 realpath 结果，不声称已经验收原生 NTFS 语义。
 */
import { realpathSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '../src/core/config.js';
import {
  createDeterministicPolicy,
  matchRule,
  parseRule,
  windowsAmbiguousPath,
} from '../src/builtin/policy/index.js';
import { EventBus, type PermissionRequest } from '../src/core/events.js';
import { HookRunner } from '../src/core/hooks.js';
import type { SessionRules } from '../src/core/permission/contracts.js';
import { ToolRegistry, type Tool } from '../src/core/registry.js';
import { ToolExecutor } from '../src/core/tool-executor.js';
import type { PolicyInput, Reviewer } from '../src/sdk/capabilities.js';
import { bashTool } from '../src/tools/bash.js';
import { editFileTool } from '../src/tools/edit.js';
import { createGlobTool } from '../src/tools/glob.js';
import { createGrepTool } from '../src/tools/grep.js';
import { readFileTool } from '../src/tools/read.js';
import { writeFileTool } from '../src/tools/write.js';

const trusted = (tool: Tool): Tool => ({
  ...tool,
  ownerPlugin: 'agentlab.local-tools',
  version: '1.0.0',
});
const tools = {
  read_file: trusted(readFileTool),
  write_file: trusted(writeFileTool),
  edit_file: trusted(editFileTool),
  glob: trusted(createGlobTool()),
  grep: trusted(createGrepTool()),
  bash: trusted(bashTool),
};
type ToolName = keyof typeof tools;
const signal = () => new AbortController().signal;
const rules = (patch: Partial<SessionRules> = {}): SessionRules => ({
  allow: [],
  ask: [],
  deny: [],
  ...patch,
});
const fileInput = (name: ToolName, path: string) =>
  name === 'write_file'
    ? { path, content: 'OVERWRITTEN' }
    : name === 'edit_file'
      ? { path, old_string: 'needle', new_string: 'OVERWRITTEN' }
      : { path };
const exact = (name: ToolName, path: string) => `${name}(=${JSON.stringify(path)})`;
let root: string;
let cwd: string;
let cwdAlias: string;
let rawAmbiguousCwd: string;
const directoryLink = (target: string, path: string) =>
  symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

beforeAll(async () => {
  root = await mkdtemp(join(realpathSync.native(tmpdir()), 'win-policy-guards-'));
  cwd = join(root, 'project');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src/only-canonical.ts'), 'needle\n');
  await directoryLink(join(cwd, 'src'), join(cwd, 'alias'));
  await mkdir(join(cwd, 'src/TARGET~1'));
  await writeFile(join(cwd, 'src/TARGET~1/existing.ts'), 'needle\n');
  await directoryLink(join(cwd, 'src/TARGET~1'), join(cwd, 'src/ambiguous-alias'));
  await mkdir(join(root, 'PROJECT~1/src'), { recursive: true });
  await writeFile(join(root, 'PROJECT~1/src/existing.ts'), 'needle\n');
  cwdAlias = join(root, 'cwd-alias');
  await directoryLink(join(root, 'PROJECT~1'), cwdAlias);
  rawAmbiguousCwd = join(root, 'ALIAS~1');
  await directoryLink(cwd, rawAmbiguousCwd);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function decide(
  name: ToolName,
  input: Record<string, unknown>,
  options: {
    mode?: PermissionMode;
    platform?: NodeJS.Platform;
    cwd?: string;
    rules?: SessionRules;
    session?: Partial<SessionRules>;
    writeRoots?: string[];
  } = {},
) {
  const project = options.cwd ?? cwd;
  const policy = createDeterministicPolicy({
    cwd: project,
    mode: options.mode ?? 'auto',
    platform: options.platform ?? 'win32',
    rules: options.rules ?? rules(),
    writeRoots: options.writeRoots,
  });
  for (const kind of ['allow', 'ask', 'deny'] as const)
    for (const raw of options.session?.[kind] ?? []) policy.controller!.addSessionRule(kind, raw);
  const operation: PolicyInput = {
    tool: tools[name],
    input,
    cwd: project,
    configRevision: 'c',
    policyRevision: policy.revision,
  };
  const analysis = await policy.analyzer!.analyze(operation, signal());
  const decision = await policy.decide({ ...operation, analysis }, signal());
  return { policy, operation, analysis, decision };
}

function executor(
  mode: PermissionMode,
  ruleSet = rules(),
  project = cwd,
  review?: Reviewer['review'],
) {
  const registry = new ToolRegistry();
  for (const tool of Object.values(tools)) registry.register(tool);
  const policy = createDeterministicPolicy({
    cwd: project,
    mode,
    rules: ruleSet,
    platform: 'win32',
  });
  const events = new EventBus();
  const requests: PermissionRequest[] = [];
  events.on('permission_request', (event) => {
    requests.push(event.request);
    event.resolve({ allow: false });
  });
  const reviewer = {
    review: vi.fn<Reviewer['review']>(
      review ??
        (async () => ({ decision: 'allow', reasonCode: 'fixture_allow', reason: 'fixture' })),
    ),
  };
  const instance = new ToolExecutor({
    tools: registry,
    policy,
    reviewer,
    events,
    hooks: new HookRunner(),
    cwd: project,
  });
  const run = (name: ToolName, input: Record<string, unknown>) =>
    instance.invokeTool(name, input, {
      signal: signal(),
      runId: 'windows-guards',
      userRequest: '访问项目内文件',
      messages: [],
    });
  return { run, requests, reviewer, policy };
}

describe('Windows 文件限制规则：大小写别名不能越过 deny / ask', () => {
  const cases = (['auto', 'yolo'] as const).flatMap((mode) =>
    (['deny', 'ask'] as const).flatMap((kind) =>
      (['config', 'session'] as const).flatMap((source) =>
        (['read_file', 'write_file', 'edit_file'] as const).map((name) => ({
          mode,
          kind,
          source,
          name,
        })),
      ),
    ),
  );
  it.each(cases)(
    '$mode $source $kind $name 匹配不存在的新文件大小写变体',
    async ({ mode, kind, source, name }) => {
      const path = 'SRC/BLOCKED.TS';
      await expect(lstat(join(cwd, path))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const restriction of [
        `${name}(src/blocked.ts)`,
        `${name}(src/**)`,
        exact(name, 'src/blocked.ts'),
      ]) {
        const patch = { [kind]: [restriction] };
        const result = await decide(name, fileInput(name, path), {
          mode,
          rules: rules({ allow: [exact(name, path)], ...(source === 'config' ? patch : {}) }),
          session: source === 'session' ? patch : undefined,
        });
        expect(result.decision).toMatchObject({
          kind,
          reasonCode: kind === 'deny' ? 'deny_rule' : 'explicit_ask',
          source,
        });
      }
    },
  );

  it.each(['deny', 'ask'] as const)(
    '真实目标大小写也受 %s 约束（链接输入不命中原始规则）',
    async (kind) => {
      for (const name of ['read_file', 'write_file', 'edit_file'] as const) {
        const path = 'alias/only-canonical.ts';
        const result = await decide(name, fileInput(name, path), {
          rules: rules({
            [kind]: [exact(name, 'SRC/ONLY-CANONICAL.TS')],
            allow: [exact(name, path)],
          }),
        });
        expect(result.analysis.targets).toContain(await realpath(join(cwd, path)));
        expect(result.decision).toMatchObject({
          kind,
          reasonCode: kind === 'deny' ? 'deny_rule' : 'explicit_ask',
        });
      }
    },
  );

  it('glob 的路径模式与 grep 的真实候选文件采用大小写无关的限制匹配', async () => {
    expect(
      (
        await decide(
          'glob',
          { pattern: 'SRC/BLOCKED.TS' },
          { rules: rules({ deny: ['glob(src/blocked.ts)'] }) },
        )
      ).decision.kind,
    ).toBe('deny');
    for (const kind of ['deny', 'ask'] as const) {
      expect(
        (
          await decide(
            'grep',
            { pattern: 'needle', path: 'alias', glob: 'only-canonical.ts' },
            { rules: rules({ [kind]: [exact('grep', 'SRC/ONLY-CANONICAL.TS')] }) },
          )
        ).decision,
      ).toMatchObject({ kind, reasonCode: kind === 'deny' ? 'deny_rule' : 'explicit_ask' });
    }
  });

  it('原始 deny 先于分析器，分析失败不能绕过文件规则', async () => {
    const policy = createDeterministicPolicy({
      cwd,
      mode: 'yolo',
      rules: rules({ deny: ['write_file(src/**)'] }),
      platform: 'win32',
    });
    const analyze = vi
      .spyOn(policy.analyzer!, 'analyze')
      .mockRejectedValue(new Error('fixture analysis failed'));
    expect(
      await policy.decide(
        { tool: tools.write_file, input: fileInput('write_file', 'SRC/BLOCKED.TS'), cwd },
        signal(),
      ),
    ).toMatchObject({ kind: 'deny', reasonCode: 'deny_rule' });
    expect(analyze).not.toHaveBeenCalled();
  });

  it.each(['auto', 'yolo'] as const)(
    '%s 不扩大大小写不同的 allow，匹配精确 allow 仍可用',
    async (mode) => {
      for (const allow of ['write_file(src/blocked.ts)', exact('write_file', 'src/blocked.ts')]) {
        expect(
          (
            await decide('write_file', fileInput('write_file', 'SRC/BLOCKED.TS'), {
              mode,
              rules: rules({ allow: [allow] }),
            })
          ).decision,
        ).toMatchObject({ kind: 'review', reasonCode: 'platform_write_review' });
      }
      expect(
        (
          await decide('write_file', fileInput('write_file', 'SRC/BLOCKED.TS'), {
            mode,
            rules: rules({ allow: [exact('write_file', 'SRC/BLOCKED.TS')] }),
          })
        ).decision,
      ).toMatchObject({ kind: 'allow', reasonCode: 'exact_allow' });
    },
  );

  it('Shell、grep 搜索字面量和未验证外部工具不采用文件大小写语义', async () => {
    for (const kind of ['deny', 'ask'] as const) {
      expect(
        (
          await decide(
            'bash',
            { command: 'echo Safe' },
            { rules: rules({ [kind]: [exact('bash', 'echo safe')] }) },
          )
        ).decision,
      ).toMatchObject({ kind: 'review', reasonCode: 'review_uncertain' });
      expect(
        (
          await decide(
            'grep',
            { pattern: 'needle', path: 'src', glob: 'only-canonical.ts' },
            { rules: rules({ [kind]: [exact('grep', 'NEEDLE')] }) },
          )
        ).decision,
      ).toMatchObject({ kind: 'allow', reasonCode: 'safe_read' });
    }
    const policy = createDeterministicPolicy({
      cwd,
      mode: 'auto',
      rules: rules({ deny: ['read_file(src/**)'] }),
      platform: 'win32',
    });
    expect(
      await policy.decide(
        {
          cwd,
          tool: { ...tools.read_file, ownerPlugin: 'external.custom' },
          input: { path: 'SRC/BLOCKED.TS' },
        },
        signal(),
      ),
    ).toMatchObject({ kind: 'review', reasonCode: 'review_uncertain' });
  });

  it.each(['linux', 'darwin'] as const)('%s 文件规则仍区分大小写', async (platform) => {
    for (const kind of ['deny', 'ask'] as const) {
      expect(
        (
          await decide('write_file', fileInput('write_file', 'SRC/BLOCKED.TS'), {
            platform,
            mode: 'yolo',
            rules: rules({ [kind]: ['write_file(src/blocked.ts)'] }),
          })
        ).decision,
      ).toMatchObject({ kind: 'allow', reasonCode: 'yolo_complete' });
    }
  });

  it('大小写无关限制只增加保护，不缩窄原有否定字符类匹配', async () => {
    for (const kind of ['deny', 'ask'] as const) {
      expect(
        (
          await decide('write_file', fileInput('write_file', 'src/A.ts'), {
            rules: rules({ [kind]: ['write_file(src/[!a].ts)'] }),
          })
        ).decision,
      ).toMatchObject({ kind, reasonCode: kind === 'deny' ? 'deny_rule' : 'explicit_ask' });
    }
  });

  it('matchRule 默认保持区分大小写，显式 nocase 同时支持 glob 与 JSON 精确目标', () => {
    for (const raw of ['write_file(src/**)', exact('write_file', 'src/a*.ts')]) {
      const rule = parseRule(raw);
      expect(matchRule(rule, 'write_file', 'SRC/A*.TS')).toBe(false);
      expect(matchRule(rule, 'write_file', 'SRC/A*.TS', { nocase: true })).toBe(true);
      expect(matchRule(rule, 'read_file', 'SRC/A*.TS', { nocase: true })).toBe(false);
    }
    expect(
      matchRule(parseRule(exact('write_file', 'src/a*.ts')), 'write_file', 'SRC/AB.TS', {
        nocase: true,
      }),
    ).toBe(false);
  });
});

const ambiguousCases: Array<[ToolName, Record<string, unknown>]> = [
  ['write_file', fileInput('write_file', 'src/ambiguous-alias/new.ts')],
  ['write_file', fileInput('write_file', 'src/ambiguous-alias/existing.ts')],
  ['edit_file', fileInput('edit_file', 'src/ambiguous-alias/existing.ts')],
  ['read_file', fileInput('read_file', 'src/ambiguous-alias/existing.ts')],
  ['glob', { path: 'src/ambiguous-alias', pattern: '*.ts' }],
  ['grep', { path: 'src/ambiguous-alias', pattern: 'needle', glob: '*.ts' }],
];

describe('Windows realpath 歧义：必须人工，不回退通用 complete', () => {
  it.each(ambiguousCases)('%s %j 的安全拼写链接落入歧义真实目标', async (name, input) => {
    expect(windowsAmbiguousPath(String(input.path))).toBe(false);
    expect(windowsAmbiguousPath(await realpath(join(cwd, 'src/ambiguous-alias')))).toBe(true);
    for (const mode of ['ask', 'auto', 'yolo'] as const) {
      const result = await decide(name, input, {
        mode,
        rules: rules({ allow: [exact(name, String(input.path))] }),
        writeRoots: ['src'],
      });
      expect(result.analysis).toMatchObject({
        completeness: 'unknown',
        reasonCode: 'native_windows_unverified',
      });
      expect(result.analysis.targets?.some(windowsAmbiguousPath)).toBe(true);
      expect(result.analysis.evidence?.[0]).toMatchObject({ source: 'platform-support' });
      expect(result.decision).toMatchObject({ kind: 'ask', reasonCode: 'platform_unverified' });
    }
  });

  it('搜索枚举发现歧义名称也必须人工（搜索根与输入本身正常）', async () => {
    for (const name of ['glob', 'grep'] as const) {
      const input =
        name === 'glob'
          ? { path: 'src', pattern: '**/*.ts' }
          : { path: 'src', pattern: 'needle', glob: '**/*.ts' };
      expect((await decide(name, input)).decision).toMatchObject({
        kind: 'ask',
        reasonCode: 'platform_unverified',
      });
    }
  });

  it('输入 cwd 与 canonical cwd 的歧义都必须人工', async () => {
    expect(windowsAmbiguousPath(cwdAlias)).toBe(false);
    expect(windowsAmbiguousPath(await realpath(cwdAlias))).toBe(true);
    expect(windowsAmbiguousPath(rawAmbiguousCwd)).toBe(true);
    expect(windowsAmbiguousPath(await realpath(rawAmbiguousCwd))).toBe(false);
    for (const project of [cwdAlias, rawAmbiguousCwd])
      for (const mode of ['auto', 'yolo'] as const)
        for (const name of ['read_file', 'write_file', 'edit_file'] as const) {
          const path = 'src/new.ts';
          const result = await decide(name, fileInput(name, path), {
            cwd: project,
            mode,
            rules: rules({ allow: [exact(name, path)] }),
          });
          expect(result.analysis).toMatchObject({
            completeness: 'unknown',
            reasonCode: 'native_windows_unverified',
          });
          expect(result.decision).toMatchObject({ kind: 'ask', reasonCode: 'platform_unverified' });
        }
  });

  it('canonical deny 仍比歧义路径人工约束优先', async () => {
    expect(
      (
        await decide('write_file', fileInput('write_file', 'src/ambiguous-alias/new.ts'), {
          rules: rules({ deny: ['write_file(SRC/TARGET~1/**)'] }),
        })
      ).decision,
    ).toMatchObject({ kind: 'deny', reasonCode: 'deny_rule' });
  });

  it('非 Windows 的 ~1 普通路径保持原行为', async () => {
    expect(
      (
        await decide('write_file', fileInput('write_file', 'src/ambiguous-alias/new.ts'), {
          platform: 'linux',
          mode: 'yolo',
        })
      ).decision,
    ).toMatchObject({ kind: 'allow', reasonCode: 'yolo_complete' });
    expect(
      (
        await decide(
          'read_file',
          { path: 'src/ambiguous-alias/existing.ts' },
          { platform: 'linux' },
        )
      ).decision,
    ).toMatchObject({ kind: 'allow', reasonCode: 'safe_read' });
  });
});

describe('Windows 路径约束通过唯一 ToolExecutor 生效', () => {
  it.each(['auto', 'yolo'] as const)(
    '%s 大小写 deny/ask 不调用 reviewer、不创建目标',
    async (mode) => {
      for (const kind of ['deny', 'ask'] as const)
        for (const source of ['config', 'session'] as const) {
          const restriction = exact('write_file', 'src/blocked.ts');
          const f = executor(
            mode,
            rules({
              allow: [exact('write_file', 'SRC/BLOCKED.TS')],
              ...(source === 'config' ? { [kind]: [restriction] } : {}),
            }),
          );
          if (source === 'session') f.policy.controller!.addSessionRule(kind, restriction);
          expect(
            (await f.run('write_file', fileInput('write_file', 'SRC/BLOCKED.TS'))).isError,
          ).toBe(true);
          expect(f.reviewer.review).not.toHaveBeenCalled();
          expect(f.requests).toHaveLength(kind === 'ask' ? 1 : 0);
          if (kind === 'ask') expect(f.requests[0]).toMatchObject({ reasonCode: 'explicit_ask' });
          await expect(lstat(join(cwd, 'SRC/BLOCKED.TS'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
    },
  );

  it.each(['auto', 'yolo'] as const)(
    '%s canonical 歧义读写均必须人工，模型 allow 和精确规则不能越过',
    async (mode) => {
      for (const [name, input] of ambiguousCases) {
        const f = executor(mode, rules({ allow: [exact(name, String(input.path))] }));
        expect((await f.run(name, input)).isError).toBe(true);
        expect(f.requests).toHaveLength(1);
        expect(f.requests[0]).toMatchObject({ reasonCode: 'platform_unverified' });
        expect(f.reviewer.review).not.toHaveBeenCalled();
      }
      expect(await readFile(join(cwd, 'src/TARGET~1/existing.ts'), 'utf8')).toBe('needle\n');
      await expect(lstat(join(cwd, 'src/TARGET~1/new.ts'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('安全 cwd 链接的 canonical cwd 歧义在 executor 中同样不交给模型', async () => {
    for (const name of ['read_file', 'write_file'] as const) {
      const f = executor('yolo', rules({ allow: [exact(name, 'src/existing.ts')] }), cwdAlias);
      expect((await f.run(name, fileInput(name, 'src/existing.ts'))).isError).toBe(true);
      expect(f.requests[0]).toMatchObject({ reasonCode: 'platform_unverified' });
      expect(f.reviewer.review).not.toHaveBeenCalled();
    }
    expect(await readFile(join(root, 'PROJECT~1/src/existing.ts'), 'utf8')).toBe('needle\n');
  });

  it('模型批准后链接变成歧义真实目录，重验失效并改为人工，不写入新目标', async () => {
    await mkdir(join(cwd, 'src/rebind-safe'));
    const alias = join(cwd, 'src/rebind-alias');
    await directoryLink(join(cwd, 'src/rebind-safe'), alias);
    const f = executor('auto', rules(), cwd, async () => {
      await unlink(alias);
      await directoryLink(join(cwd, 'src/TARGET~1'), alias);
      return { decision: 'allow', reasonCode: 'fixture_allow', reason: 'fixture' };
    });
    expect(
      (await f.run('write_file', fileInput('write_file', 'src/rebind-alias/rebound.ts'))).isError,
    ).toBe(true);
    expect(f.reviewer.review).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ reasonCode: 'platform_unverified' });
    for (const dir of ['src/rebind-safe', 'src/TARGET~1'])
      await expect(lstat(join(cwd, dir, 'rebound.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
