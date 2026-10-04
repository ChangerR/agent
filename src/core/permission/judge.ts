/**
 * LLM 审批员（AutoJudge）—— auto 模式的可选增强。
 *
 * 定位：确定性规则管线的"兜底顾问"，而不是替代品。
 * 仅在 模式=auto 且 确定性管线判定为 ask（来源是模式默认值）时介入：
 * deny 规则、危险命令检测、allow/ask 规则的判定结果都不经过它。
 *
 * 审批员用一个小而快的模型（如 deepseek-flash / claude-haiku）判断
 * 这次工具调用是否明显安全：
 *   allow → 静默放行
 *   ask/不确定/出错 → 回落为询问用户（保守倾向：宁可多问，不可错放）
 */
import { complete, type Provider } from '../provider.js';
import type { Tool } from '../registry.js';
import type { Decision } from './engine.js';

const JUDGE_PROMPT = `你是 coding agent 的权限审批员。用户已开启 auto 模式，授权你放行"明显安全"的操作。

判定标准：
- 只放行明显安全的操作：读文件、列目录、跑测试、构建、查看状态、写入项目内普通源码文件等
- 以下情况必须回答 ask：删除/覆盖无法恢复的数据、修改系统或项目外文件、网络上传、发布（npm publish/git push）、安装未知脚本、任何你拿不准的操作

只输出 JSON：{"verdict": "allow" 或 "ask", "reason": "一句话理由"}`;

export interface JudgeVerdict {
  verdict: 'allow' | 'ask';
  reason: string;
}

export class AutoJudge {
  constructor(
    private provider: Provider,
    private model: string,
  ) {}

  async review(tool: Tool, input: Record<string, unknown>, signal: AbortSignal): Promise<JudgeVerdict> {
    try {
      const { text } = await complete(
        this.provider,
        {
          model: this.model,
          system: JUDGE_PROMPT,
          messages: [
            {
              role: 'user',
              content: `工具: ${tool.name}\n风险级别: ${tool.risk}\n参数: ${JSON.stringify(input).slice(0, 2000)}`,
            },
          ],
          tools: [],
          maxTokens: 256,
        },
        signal,
      );
      const m = /\{[\s\S]*\}/.exec(text);
      const parsed = JSON.parse(m?.[0] ?? '{}') as Partial<JudgeVerdict>;
      if (parsed.verdict === 'allow') {
        return { verdict: 'allow', reason: parsed.reason ?? 'LLM 审批员认为安全' };
      }
      return { verdict: 'ask', reason: parsed.reason ?? 'LLM 审批员不确定' };
    } catch {
      // 审批员不可用：保守回落
      return { verdict: 'ask', reason: 'LLM 审批员调用失败，回落为询问用户' };
    }
  }
}

/** 把审批员的结论合并进决策：allow 才覆盖，其余保持 ask */
export function mergeJudgeDecision(original: Decision, verdict: JudgeVerdict): Decision {
  if (verdict.verdict === 'allow') {
    return { kind: 'allow', reason: `LLM 审批员放行：${verdict.reason}`, source: 'judge' };
  }
  return { ...original, reason: `${original.reason}（LLM 审批员倾向询问：${verdict.reason}）` };
}
