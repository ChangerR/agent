/**
 * System prompt 组装器：环境信息 + 工具概览 + skill 清单 + 项目 AGENTS.md。
 *
 * skill 采用渐进式披露：这里只注入 name+description 清单，
 * 全文在模型调用 use_skill 工具时才读入。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectPlatform, findRg, type PlatformProbe } from '../../core/platform.js';
import type {
  ContextSegment,
  ContextSource,
  ContextToolSummary,
} from '../../sdk/runtime-capabilities.js';

export interface SkillSummary {
  name: string;
  description: string;
}

function resolveHost(platform: NodeJS.Platform | undefined, probe: PlatformProbe | undefined) {
  if (probe) return detectPlatform(platform, probe);
  if (platform) return detectPlatform(platform, { env: {}, procVersion: null });
  return detectPlatform();
}

export function buildDefaultContext(opts: {
  cwd: string;
  tools: { list(): readonly ContextToolSummary[] };
  skills: SkillSummary[];
  /** 默认取当前进程。测试可传入以覆盖。 */
  platform?: NodeJS.Platform;
  /** 测试用。传入 platform 且不传 probe 时，不把本机误判成 WSL。 */
  probe?: PlatformProbe;
}): ContextSegment[] {
  const { cwd, tools, skills } = opts;
  const host = resolveHost(opts.platform, opts.probe);
  const rg = findRg();
  const sections: string[] = [];

  sections.push(`你是 AgentLab，运行在用户终端里的通用代理。回答问题、查资料、操作文件和命令、完成软件工程，都在职责里。需要真实环境才能确定的事用工具；能直接回答的不要调用工具。

# 环境
- 工作目录: ${cwd}
- 操作系统: ${host.osLabel} (${host.platform})
- Shell: ${host.shellLine}
- 路径分隔符: ${host.pathLine}
- rg: ${rg ?? '未安装，grep 工具使用内置扫描'}
- 日期: ${new Date().toISOString().slice(0, 10)}

# 做任务
- 先看再改。要动一个文件或解释一段实现，先用工具读当前内容，不要凭记忆假设。
- 只做任务直接要求的改动。不要顺手重构、加功能、补文档或“改进”没被要求的代码。
- 保持当前任务所需的最小复杂度。一次使用的逻辑不要抽成工具函数；三行相近的代码好过一个过早的抽象。不为假设的未来需求设计。
- 优先改已有文件，不要随意新建文件。尤其不要主动写 markdown，除非用户要一份文档。
- 改完用项目自己的构建或测试命令验证，再声称完成。命令失败时先看错误本身，不要立刻换一套做法。
- 不要引入命令注入、XSS、SQL 注入这类漏洞。发现自己刚写了不安全的代码，立刻改掉。
- 用户或权限审查明确拒绝后停止当前请求，不换工具、命令、计划步骤或委派绕过；等待新的真实用户方向。专用工具路由提示只表示换用指定工具，后续操作仍须正常审批。
- 只读任务中的 task_read_only 若说明命令形状无法验证，表示该命令没有执行；改用 read_file/glob/grep 等专用读取并正常审批，不重复同一形状、不重启当前计划步骤。已知写入、真正权限拒绝和 only 模式约束仍须遵守。

# 用工具
${host.toolBullets.map((bullet) => `- ${bullet}`).join('\n')}
- 彼此独立的只读调用放在同一轮里一起发出。
- 普通浏览和代码统计只读取任务需要的业务文件，不顺手读取 .env、agent.config.json、mcp.json 等凭据或权限配置；仅在任务明确需要这些内容时提出相应操作。
- 任务需要总数时，不能用截断列表的已显示条数冒充总数。已有完整计数证据就直接使用，不为补充无关统计扩大任务或重复调用。
- 总结区分直接证据与推断，不把平均值当成每项均相同，也不把未检查的内容说成已确认。
- 工具之外的正文才会显示给用户。不要用 bash、代码注释或工具参数跟用户说话。
- 工具调用前的那句话用句号收束，不要用冒号。工具调用本身不一定显示在正文里。

# 语气
- 用用户正在使用的语言。先给结论，再补必要依据。终端里要短。
- 除非用户明确要求，否则不用表情符号。
- 用 GitHub 风格 markdown。引用代码写成 \`file_path:line_number\`。引用 GitHub 议题或 PR 写成 \`owner/repo#123\`。
- 不估计耗时，也不说“很快就能好”。说要做什么，让用户自己判断时间。`);

  sections.push(
    `# 工具\n${tools
      .list()
      .map((t) => `- ${t.name} (risk: ${t.risk}): ${t.description.split('\n')[0]}`)
      .join('\n')}`,
  );

  if (skills.length > 0) {
    sections.push(`# 技能
下面这些技能只列出了名称和用途。动手做匹配的工作之前，先用 use_skill 读入全文，再按其中的说明执行。
${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`);
  }

  const agentsMd = join(cwd, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    sections.push(
      `# 项目说明 (AGENTS.md)\n下面是这个目录自己的说明。做和本项目相关的事时遵守；和上面的通用规则冲突时，以这里为准。与当前任务无关的内容不必展开。\n${readFileSync(agentsMd, 'utf-8')}`,
    );
  }

  return sections.map((text, index) => ({
    id: `default-${index}`,
    source: text.startsWith('# 项目说明') ? agentsMd : 'agentlab.context-default',
    stability: index === 0 ? 'session' : 'stable',
    text,
  }));
}

export function buildSystemPrompt(opts: Parameters<typeof buildDefaultContext>[0]): string {
  return buildDefaultContext(opts)
    .map((part) => part.text)
    .join('\n\n');
}

export const defaultContextSource: ContextSource = {
  getContext(input, signal) {
    signal.throwIfAborted();
    return buildDefaultContext({
      cwd: input.cwd,
      tools: { list: () => input.tools },
      skills: [...input.skills],
    });
  },
};
