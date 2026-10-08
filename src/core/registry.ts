/**
 * 注册表：Provider 与 Tool 的挂载点。
 *
 * 插件架构的核心机制 —— core 不 import 任何具体 provider/tool，
 * 一切通过 register() 挂进来，loop 只面向注册表编程。
 */
import { prepareRegistration, type RegistrationBatch } from './registration.js';
import type { Provider } from './provider.js';
import type { ToolDefinition, ToolResult } from './protocol/types.js';

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private frozen = false;
  freeze(): void { this.frozen = true; }

  register(provider: Provider): void {
    const batch = this.prepareBatch([provider]); batch.commit(); batch.seal();
  }
  prepareBatch(providers: readonly Provider[]): RegistrationBatch {
    const assertMutable = () => { if (this.frozen) throw new Error('Provider registry is frozen; select replacements before session startup'); };
    assertMutable();
    const next = new Map(this.providers);
    for (const provider of providers) {
      if (next.has(provider.name)) throw new Error(`Duplicate provider: ${provider.name}`);
      next.set(provider.name, provider);
    }
    return prepareRegistration(this.providers, next, () => this.providers, value => { this.providers = value; }, assertMutable);
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
  /** 子工具和命令必须经过相同的最终授权门；不暴露注册表执行快捷方式。 */
  invokeTool?(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}

export interface Tool {
  name: string;
  version?: string;
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
  private aliases = new Map<string, string>();
  private frozen = false;
  freeze(): void { this.frozen = true; }
  alias(name: string, target: string): void {
    if (this.frozen || this.tools.has(name) || this.aliases.has(name) || !this.tools.has(target)) throw new Error(`Invalid or conflicting tool alias: ${name}`);
    this.aliases = new Map(this.aliases).set(name, target);
  }

  register(tool: Tool): void {
    const batch = this.prepareBatch([tool]); batch.commit(); batch.seal();
  }
  /** 保留既有 alias，整批重复检查后再允许单次提交。 */
  prepareBatch(tools: readonly Tool[]): RegistrationBatch {
    const aliases = this.aliases;
    const assertMutable = () => {
      if (this.frozen) throw new Error('Tool registry is frozen; select replacements before session startup');
      if (this.aliases !== aliases) throw new Error('Tool aliases changed before registration');
    };
    assertMutable();
    const next = new Map(this.tools);
    for (const tool of tools) {
      if (next.has(tool.name) || aliases.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      next.set(tool.name, tool);
    }
    return prepareRegistration(this.tools, next, () => this.tools, value => { this.tools = value; }, assertMutable);
  }
  aliasesFor(name: string): readonly string[] { return Object.freeze([...this.aliases].filter(([, target]) => target === name).map(([alias]) => alias)); }

  get(name: string): Tool | undefined {
    return this.tools.get(this.aliases.get(name) ?? name);
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
