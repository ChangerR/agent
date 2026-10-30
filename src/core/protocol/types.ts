import { createHash } from 'node:crypto';
/**
 * 规范化协议层（Normalized Protocol）
 *
 * 这是整个 agent 的地基：内部所有模块只认识这里定义的类型，
 * 与 Anthropic / OpenAI 等厂商的 wire format 完全解耦。
 * 每个 Provider adapter 的职责就是「厂商格式 <-> 本协议」的双向翻译。
 */

// ---------------------------------------------------------------------------
// 消息（持久化的对话历史）
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /**
   * Anthropic 随思考块下发的签名。回填时必须和原文一起原样送回，
   * 服务端用它校验思考内容没有被改过。OpenAI 兼容协议没有这个字段。
   */
  signature?: string;
}

/** 服务端隐藏了原文的思考块，只剩一段必须原样回填的 data */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
  replay?: { arguments: string; inputHash: string; routeId: string; model: string };
}
export const toolInputHash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function replayArguments(block: ToolUseBlock, routeId: string, model: string): string {
  const replay = block.replay;
  if (
    replay?.routeId === routeId &&
    replay.model === model &&
    replay.inputHash === toolInputHash(block.input)
  ) {
    try {
      if (toolInputHash(JSON.parse(replay.arguments)) === replay.inputHash) return replay.arguments;
    } catch {
      /* 损坏的回放元数据不能影响执行参数。 */
    }
  }
  return JSON.stringify(block.input);
}

export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;

/** 工具结果，作为 user 角色的 content block 回填给模型（与 Anthropic 习惯一致） */
export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface UserMessage {
  role: 'user';
  /** 运行时、摘要及委派数据均不构成用户授权；无 source 的消息才是用户原文。 */
  source?: 'summary' | 'delegation' | 'subagent' | 'tool' | 'runtime';
  content: string | Array<TextBlock | ToolResultBlock>;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
}

export type Message = UserMessage | AssistantMessage;

// ---------------------------------------------------------------------------
// 流式事件（provider.stream() 的产出）
// ---------------------------------------------------------------------------

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

/**
 * 一次模型调用的 token 用量。
 *
 * 归一化约定：`inputTokens` 不含缓存命中。
 * Anthropic 的 `input_tokens` 本来就不含缓存读取；OpenAI 的 `prompt_tokens` 含，
 * adapter 要先减掉 `cached_tokens` 再写入 `inputTokens`。
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** 从缓存读到的输入 token */
  cacheReadTokens: number;
  /** 本次写入缓存的 token。自动前缀缓存的厂商通常给 0 */
  cacheWriteTokens: number;
  cacheWriteTokensByTtl?: Partial<Record<'5m' | '1h' | '30m' | '12h', number>>;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
export function cloneUsage(usage: TokenUsage): TokenUsage {
  return {
    ...usage,
    ...(usage.cacheWriteTokensByTtl
      ? { cacheWriteTokensByTtl: { ...usage.cacheWriteTokensByTtl } }
      : {}),
  };
}
export const usageCountKeys = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;
export function addUsage(target: TokenUsage, usage: TokenUsage) {
  for (const key of usageCountKeys) target[key] += usage[key];
  if (usage.cacheWriteTokensByTtl) {
    target.cacheWriteTokensByTtl ??= {};
    for (const key of Object.keys(usage.cacheWriteTokensByTtl) as Array<
      keyof NonNullable<TokenUsage['cacheWriteTokensByTtl']>
    >)
      target.cacheWriteTokensByTtl[key] =
        (target.cacheWriteTokensByTtl[key] ?? 0) + usage.cacheWriteTokensByTtl[key]!;
  }
}

/** 只覆盖 patch 里有定义的字段。避免后到的 usage 片段把前面的计数冲成 0 */
export function mergeUsage(target: Partial<TokenUsage>, patch: Partial<TokenUsage>): void {
  if (patch.inputTokens !== undefined) target.inputTokens = patch.inputTokens;
  if (patch.outputTokens !== undefined) target.outputTokens = patch.outputTokens;
  if (patch.cacheReadTokens !== undefined) target.cacheReadTokens = patch.cacheReadTokens;
  if (patch.cacheWriteTokens !== undefined) target.cacheWriteTokens = patch.cacheWriteTokens;
  if (patch.cacheWriteTokensByTtl !== undefined)
    target.cacheWriteTokensByTtl = {
      ...target.cacheWriteTokensByTtl,
      ...patch.cacheWriteTokensByTtl,
    };
}

/** 缓存输入字段必须齐全；未命中包括本次写入缓存的输入，缺失字段不按零计。 */
export function cacheUsage(usage: Partial<TokenUsage>) {
  if (
    !['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every((key) => {
      const value = usage[key as keyof TokenUsage];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    })
  )
    return undefined;
  return {
    hitTokens: usage.cacheReadTokens!,
    missTokens: usage.inputTokens! + usage.cacheWriteTokens!,
  };
}

export type StreamEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /** 思考块签名的增量，拼完后挂到对应的 ThinkingBlock.signature 上 */
  | { type: 'signature_delta'; signature: string }
  /** 打码思考块在 content_block_start 时一次到齐 */
  | { type: 'redacted_thinking'; data: string }
  | {
      type: 'tool_use_start';
      id: string;
      name: string;
      source?: { routeId: string; model: string };
    }
  /** input 为 JSON 字符串片段（与 Anthropic input_json_delta 对齐） */
  | { type: 'tool_use_delta'; id: string; input: string }
  | { type: 'tool_use_stop'; id: string }
  | { type: 'message_stop'; stopReason: StopReason }
  | ({ type: 'usage' } & Partial<TokenUsage>);

// ---------------------------------------------------------------------------
// 工具定义（发给模型的 schema 描述）
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object */
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 工具结果（工具执行的产出）
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: string;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// 辅助：把一次 stream 聚合成完整的 AssistantMessage（loop 与测试都会用到）
// ---------------------------------------------------------------------------

export async function collectStreamAsync(events: AsyncIterable<StreamEvent>): Promise<{
  message: AssistantMessage;
  stopReason: StopReason;
  stopped: boolean;
  usage: TokenUsage;
}> {
  const blocks: ContentBlock[] = [];
  let stopReason: StopReason = 'end_turn';
  let stopped = false;
  const usage = emptyUsage();
  // 工具可交错输出；每个增量与结束事件必须明确指定调用 ID。
  const tools = new Map<
    string,
    { block: ToolUseBlock; json: string; source?: { routeId: string; model: string } }
  >();

  // 当前正在累积的 block 状态
  let current:
    { kind: 'text'; text: string } | { kind: 'thinking'; text: string; signature: string } | null =
    null;

  const flush = () => {
    if (!current) return;
    if (current.kind === 'text' && current.text) {
      blocks.push({ type: 'text', text: current.text });
    } else if (current.kind === 'thinking' && (current.text || current.signature)) {
      blocks.push({
        type: 'thinking',
        thinking: current.text,
        ...(current.signature ? { signature: current.signature } : {}),
      });
    }
    current = null;
  };
  const finishTool = (id: string) => {
    const tool = tools.get(id);
    if (!tool) throw new Error(`Unknown streamed tool: ${id}`);
    try {
      tool.block.input = tool.json ? JSON.parse(tool.json) : {};
      if (tool.source && tool.json.length <= 2_000_000)
        tool.block.replay = {
          ...tool.source,
          arguments: tool.json || '{}',
          inputHash: toolInputHash(tool.block.input),
        };
    } catch {
      throw new Error(`Invalid JSON for streamed tool: ${id}`);
    }
    tools.delete(id);
  };

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        break;
      case 'text_delta':
        if (current?.kind !== 'text') {
          flush();
          current = { kind: 'text', text: '' };
        }
        current.text += ev.text;
        break;
      case 'thinking_delta':
        if (current?.kind !== 'thinking') {
          flush();
          current = { kind: 'thinking', text: '', signature: '' };
        }
        current.text += ev.text;
        break;
      case 'signature_delta':
        if (current?.kind !== 'thinking') {
          flush();
          current = { kind: 'thinking', text: '', signature: '' };
        }
        current.signature += ev.signature;
        break;
      case 'redacted_thinking':
        flush();
        blocks.push({ type: 'redacted_thinking', data: ev.data });
        break;
      case 'tool_use_start':
        flush();
        if (typeof ev.id !== 'string' || !ev.id) throw new Error('Streamed tool requires an ID');
        if (tools.has(ev.id)) throw new Error(`Duplicate streamed tool: ${ev.id}`);
        const block: ToolUseBlock = { type: 'tool_use', id: ev.id, name: ev.name, input: {} };
        blocks.push(block);
        tools.set(ev.id, { block, json: '', source: ev.source });
        break;
      case 'tool_use_delta': {
        const tool = tools.get(ev.id);
        if (!tool) throw new Error(`Unknown streamed tool: ${ev.id}`);
        tool.json += ev.input;
        break;
      }
      case 'tool_use_stop':
        flush();
        finishTool(ev.id);
        break;
      case 'message_stop':
        stopped = true;
        stopReason = ev.stopReason;
        break;
      case 'usage':
        mergeUsage(usage, ev);
        break;
    }
  }
  flush();
  for (const id of [...tools.keys()]) finishTool(id);
  return { message: { role: 'assistant', content: blocks }, stopReason, stopped, usage };
}
