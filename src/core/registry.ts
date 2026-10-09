/**
 * 注册表：Provider 与 Tool 的挂载点。
 *
 * 插件架构的核心机制 —— core 不 import 任何具体 provider/tool，
 * 一切通过 register() 挂进来，loop 只面向注册表编程。
 */
import { prepareRegistration, type RegistrationBatch } from './registration.js';
import type { ToolAnalysis } from '../sdk/capabilities.js';
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
  /** 本次决策绑定并完成最终重验的分析；工具只能收窄其已批准目标，不扩展范围。 */
  analysis?: ToolAnalysis;
  /** 子工具经过相同授权门，并继承当前工具绑定的请求、runId 与取消信号。 */
  invokeTool?(name: string, input: Record<string, unknown>): Promise<ToolResult>;
}

export interface Tool {
  name: string;
  version?: string;
  /** 宿主装配时填写的来源；工具自行声明不能覆盖实际所有者。 */
  ownerPlugin?: string;
  description: string;
  /** JSON Schema */
  inputSchema: Record<string, unknown>;
  /** 风险声明供展示/调度参考；auto 授权必须基于已验证效果，不凭声明放行。 */
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
  private state = { tools: new Map<string, Tool>(), aliases: new Map<string, string>() };
  private frozen = false;
  freeze(): void { this.frozen = true; }
  alias(name: string, target: string): void {
    if (this.frozen || this.state.tools.has(name) || this.state.aliases.has(name) || !this.state.tools.has(target)) throw new Error(`Invalid or conflicting tool alias: ${name}`);
    this.state = { ...this.state, aliases: new Map(this.state.aliases).set(name, target) };
  }

  register(tool: Tool): void {
    const batch = this.prepareBatch([tool]); batch.commit(); batch.seal();
  }
  /** 工具和别名共享一个状态快照，整批检查、提交与回滚不会留下半个注册。 */
  prepareBatch(tools: readonly Tool[], aliases: readonly { name: string; target: string }[] = []): RegistrationBatch {
    const assertMutable = () => {
      if (this.frozen) throw new Error('Tool registry is frozen; select replacements before session startup');
    };
    assertMutable();
    const next = { tools: new Map(this.state.tools), aliases: new Map(this.state.aliases) };
    for (const tool of tools) {
      if (next.tools.has(tool.name) || next.aliases.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      next.tools.set(tool.name, tool);
    }
    for (const { name, target } of aliases) {
      if (next.tools.has(name) || next.aliases.has(name) || !next.tools.has(target)) throw new Error(`Invalid or conflicting tool alias: ${name}`);
      next.aliases.set(name, target);
    }
    return prepareRegistration(this.state, next, () => this.state, value => { this.state = value; }, assertMutable);
  }
  aliasesFor(name: string): readonly string[] { return Object.freeze([...this.state.aliases].filter(([, target]) => target === name).map(([alias]) => alias)); }

  get(name: string): Tool | undefined {
    return this.state.tools.get(this.state.aliases.get(name) ?? name);
  }

  list(): Tool[] {
    return [...this.state.tools.values()];
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
