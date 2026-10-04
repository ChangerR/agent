/**
 * 注册表：Provider 与 Tool 的挂载点。
 *
 * 插件架构的核心机制 —— core 不 import 任何具体 provider/tool，
 * 一切通过 register() 挂进来，loop 只面向注册表编程。
 */
import type { Provider } from './provider.js';
import type { ToolDefinition, ToolResult } from './protocol/types.js';

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  register(provider: Provider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Provider not found: ${name}. Available: ${[...this.providers.keys()].join(', ')}`);
    return p;
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export type ToolRisk = 'read' | 'write' | 'execute';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema */
  inputSchema: Record<string, unknown>;
  /** 风险级别：权限引擎 auto 模式按此放行只读工具 */
  risk: ToolRisk;
  /** 只读工具可在同一轮内并行执行 */
  isConcurrencySafe?: boolean;
  /**
   * 权限相关输入分析：
   * - patternTarget：规则匹配的靶子（bash → 命令串，文件工具 → 路径）
   * - dangerous：危险操作标记（触发强制 ask）
   * - summary：权限弹层里给用户看的一句话
   */
  analyzeInput?(input: Record<string, unknown>): {
    patternTarget: string;
    dangerous?: boolean;
    summary: string;
  };
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 发给模型的工具定义清单 */
  definitions(): ToolDefinition[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
