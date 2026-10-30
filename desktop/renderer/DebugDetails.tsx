import type { DebugEntry, DebugRequest } from '../shared/debug.js';
import { MessageMarkdown } from './MessageMarkdown.js';

export const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const roles: Record<string, string> = {
  main: '主模型',
  agent: '主模型',
  planner: '规划模型',
  judge: '审批模型',
  compact: '压缩模型',
  child: '子 Agent',
};
export const status: Record<string, string> = {
  running: '请求中',
  completed: '已完成',
  error: '请求失败',
  aborted: '已停止',
  interrupted: '响应未完整结束',
};
const phases: Record<string, string> = {
  validation: '参数校验',
  analysis: '分析影响',
  policy: '策略判定',
  reviewer: '模型审批',
  human: '人工审批',
  execution: '实际执行',
  pipeline: '权限管线',
  user: '人工决定',
  judge: '审批模型',
};
const meanings: Record<string, string> = {
  model_request: 'Agent 将系统指令、消息历史和工具定义组成规范化请求，交给 Provider 翻译。',
  model_response: 'Provider 将模型输出翻译为文本、可见思考和工具调用。输出上限与正常完成分别记录。',
  model_usage: '记录服务返回的 token 与缓存计数；未报告用量不等于零消耗。',
  tool_call: '模型提出调用工具。此时还没有获得执行权限。',
  tool_execution: '唯一 ToolExecutor 依次校验参数、分析影响、检查策略与审批，再执行工具。',
  permission_decision: 'deny、危险检测、显式 ask/allow 和审批结果在权限管线中判定。',
  permission_request: '等待用户决定；查看调试页面不会自动批准工具。',
  tool_result: '工具结果写回消息历史，供下一次模型请求继续使用。',
  plan_changed: '更新当前计划及步骤状态，后续执行继续受权限管线约束。',
  compacted: '历史被压缩为摘要，后续请求使用压缩后的上下文。',
};
export const time = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
export const duration = (ms?: number) =>
  ms === undefined ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
export function Json({ value }: { value: unknown }) {
  return <pre className="debug-json">{JSON.stringify(value, null, 2)}</pre>;
}
function Content({ value }: { value: unknown }) {
  if (typeof value === 'string') return <MessageMarkdown text={value} />;
  if (!Array.isArray(value)) return <Json value={value} />;
  return (
    <>
      {value.map((raw, index) => {
        const block = object(raw);
        if (block.type === 'text')
          return <MessageMarkdown key={index} text={String(block.text ?? '')} />;
        if (block.type === 'thinking')
          return (
            <details key={index}>
              <summary>模型返回的思考</summary>
              <pre>{String(block.thinking ?? '')}</pre>
            </details>
          );
        if (block.type === 'redacted_thinking')
          return <p key={index}>服务隐藏的思考块（不展示签名或不透明数据）</p>;
        return (
          <div className="debug-content-block" key={index}>
            <h4>
              {block.type === 'tool_use' ? '工具调用' : '工具结果'}{' '}
              {String(block.name ?? block.toolUseId ?? '')}
            </h4>
            <Json value={block.input ?? block.content ?? block} />
          </div>
        );
      })}
    </>
  );
}
export function RequestView({ entry }: { entry?: DebugEntry }) {
  if (!entry) return <p className="small">这次请求没有可读取的请求正文。</p>;
  const request = object(entry.data.request),
    messages = Array.isArray(request.messages) ? request.messages : [],
    tools = Array.isArray(request.tools) ? request.tools : [];
  return (
    <>
      <p className="debug-explanation">
        {meanings.model_request} 这里展示的是统一协议内容；实际地址、请求头与 JSON 请切换到“API
        请求”。
      </p>
      <details className="debug-section" open>
        <summary>系统指令 · System</summary>
        <pre>{String(request.system ?? '')}</pre>
      </details>
      <section className="debug-section">
        <h3>
          消息历史 <span>{messages.length} 条</span>
        </h3>
        {messages.map((raw, index) => {
          const message = object(raw);
          return (
            <details className="debug-message" key={index} open={index === messages.length - 1}>
              <summary>
                <span className="debug-number">{index + 1}</span>
                {message.role === 'assistant' ? '模型消息' : '用户 / 工具结果'}{' '}
                {message.source ? `· ${String(message.source)}` : ''}
              </summary>
              <div className="debug-markdown">
                <Content value={message.content} />
              </div>
            </details>
          );
        })}
      </section>
      <section className="debug-section">
        <h3>
          可用工具 <span>{tools.length} 个</span>
        </h3>
        {tools.map((raw, index) => {
          const tool = object(raw);
          return (
            <details key={index}>
              <summary>{String(tool.name)}</summary>
              <p>{String(tool.description ?? '')}</p>
              <Json value={tool.inputSchema} />
            </details>
          );
        })}
      </section>
      <details className="debug-section">
        <summary>请求参数与估算</summary>
        <Json
          value={{
            model: request.model,
            thinking: request.thinking,
            maxTokens: request.maxTokens,
            toolChoice: request.toolChoice,
            cache: request.cache,
            size: entry.data.size,
            estimate: entry.data.estimate,
          }}
        />
      </details>
    </>
  );
}
export function ResponseView({ entry, request }: { entry?: DebugEntry; request?: DebugRequest }) {
  if (!entry)
    return (
      <p className="debug-explanation">
        {request?.status === 'running'
          ? '请求仍在进行。响应结束后会展示服务实际返回的内容。'
          : '没有完整的响应记录；不会用聊天内容推测或补造响应。'}
      </p>
    );
  const response = object(entry.data.response),
    tools = Array.isArray(response.tools) ? response.tools : [];
  return (
    <>
      <p className="debug-explanation">{meanings.model_response}</p>
      <dl className="debug-metrics">
        <div>
          <dt>结束原因</dt>
          <dd>{String(response.stopReason ?? response.status)}</dd>
        </div>
        <div>
          <dt>流事件数</dt>
          <dd>{String(response.chunks ?? '—')}</dd>
        </div>
      </dl>
      {response.truncated && (
        <p className="info">响应过长，调试副本已截断；原始执行结果不受影响。</p>
      )}
      {response.stopReason === 'max_tokens' && (
        <p className="info">模型输出达到上限；这次响应可能未完成，不能据此认为任务成功。</p>
      )}
      {response.errorCode && (
        <p className="error-banner">
          请求失败：
          {(
            {
              http_401: 'HTTP 401：认证失败，请检查 API Key。',
              http_403: 'HTTP 403：服务拒绝访问，请检查账户权限。',
              http_429: 'HTTP 429：服务限流或额度不足。',
              ENOTFOUND: '无法解析模型服务地址。',
              ECONNREFUSED: '模型服务拒绝连接。',
              ETIMEDOUT: '模型连接超时。',
            } as Record<string, string>
          )[String(response.errorCode)] ?? String(response.errorCode)}
        </p>
      )}
      {response.thinking ? (
        <details className="debug-section">
          <summary>模型返回的思考（仅服务已返回的内容）</summary>
          <pre>{String(response.thinking)}</pre>
        </details>
      ) : null}
      <section className="debug-section debug-markdown">
        <h3>回复正文</h3>
        {response.text ? (
          <MessageMarkdown text={String(response.text)} />
        ) : (
          <p className="small">本次未返回文本正文。</p>
        )}
      </section>
      {tools.length > 0 && (
        <section className="debug-section">
          <h3>模型提出的工具调用</h3>
          {tools.map((raw, index) => {
            const tool = object(raw);
            let args: unknown = tool.arguments;
            try {
              args = JSON.parse(String(args));
            } catch {}
            return (
              <details open key={index}>
                <summary>{String(tool.name)}</summary>
                <Json value={{ id: tool.id, arguments: args }} />
              </details>
            );
          })}
        </section>
      )}
    </>
  );
}
export function EventView({ entry }: { entry: DebugEntry }) {
  const data = entry.data,
    decision = object(data.decision),
    permission = object(data.request);
  const decisionId = String(decision.kind ?? data.decision ?? ''),
    phase = String(data.phase ?? '');
  const phaseHelp: Record<string, string> = {
    validation: '验证工具参数是否满足工具的 inputSchema，并检查前置钩子的修改。',
    analysis: '分析本次操作会读取、写入或执行什么，形成后续权限判定的证据。',
    policy: '检查禁止规则、危险操作和明确的 ask / allow 规则，再决定是否委托审批。',
    reviewer: '将不确定操作的上下文交给审批模型。模型不能绕过明确 deny 或 ask。',
    human: '只采用绑定本次工具调用的人工决定。取消或过期批准不会继续执行。',
    execution: '通过权限检查后执行工具，并记录耗时与结果。',
  };
  const reasons: Record<string, string> = {
    input_valid: '参数符合工具声明的格式',
    execution_completed: '工具执行已结束',
    user_allow: '用户允许本次操作',
    user_deny: '用户拒绝本次操作',
    explicit_ask: '规则要求人工确认',
    explicit_deny: '命中明确禁止规则',
    analysis_complete: '影响分析完成',
    analysis_partial: '影响分析只完成一部分',
    analyzer_error: '影响分析失败，需要人工判断',
  };
  let content;
  if (entry.type === 'model_request') return <RequestView entry={entry} />;
  if (entry.type === 'model_response') return <ResponseView entry={entry} />;
  if (entry.type === 'user_input' || entry.type === 'notice')
    content = <MessageMarkdown text={String(data.text ?? '')} />;
  else if (entry.type === 'tool_call')
    content = (
      <>
        <h4>{String(object(data.toolUse).name ?? '工具参数')}</h4>
        <Json value={object(data.toolUse).input} />
      </>
    );
  else if (entry.type === 'tool_result')
    content = (
      <>
        <p>{object(data.result).isError ? '执行结果：失败' : '执行结果：成功'}</p>
        <pre>{String(object(data.result).content ?? '')}</pre>
      </>
    );
  else if (entry.type === 'permission_request')
    content = (
      <>
        <p>
          <strong>{String(permission.summary ?? permission.toolName ?? '工具审批')}</strong>
        </p>
        <p>{String(permission.reason ?? '')}</p>
        <h4>等待批准的参数</h4>
        <Json value={permission.input} />
      </>
    );
  else if (entry.type === 'tool_execution' || entry.type === 'permission_decision')
    content = (
      <>
        <dl className="debug-metrics">
          <div>
            <dt>阶段</dt>
            <dd>{phases[phase] ?? phase}</dd>
          </div>
          <div>
            <dt>结论</dt>
            <dd>
              {(
                {
                  allow: '允许',
                  ask: '需要人工确认',
                  deny: '禁止执行',
                  review: '交给审批模型',
                } as Record<string, string>
              )[decisionId] ?? '记录本阶段检查'}
            </dd>
          </div>
          {data.durationMs !== undefined && (
            <div>
              <dt>耗时</dt>
              <dd>{duration(Number(data.durationMs))}</dd>
            </div>
          )}
        </dl>
        <p>
          {String(decision.reason ?? reasons[String(data.reasonCode)] ?? data.reasonCode ?? '')}
        </p>
        {data.input !== undefined && (
          <>
            <h4>本次操作参数</h4>
            <Json value={data.input} />
          </>
        )}
      </>
    );
  else if (entry.type === 'plan_changed') {
    const plan = object(data.plan);
    content = (
      <>
        <h3>{String(plan.goal ?? '当前计划')}</h3>
        <p>状态：{String(plan.phase ?? '无活动计划')}</p>
        <ol>
          {(Array.isArray(plan.steps) ? plan.steps : []).map((raw, index) => {
            const step = object(raw);
            return (
              <li key={index}>
                <strong>{String(step.title)}</strong> · {String(step.status)}
                {step.evidence ? <p>{String(step.evidence)}</p> : null}
              </li>
            );
          })}
        </ol>
      </>
    );
  } else content = <Json value={data} />;
  return (
    <div className="debug-event-content">
      <p className="debug-explanation">{phaseHelp[phase] ?? meanings[entry.type]}</p>
      {content}
      <details>
        <summary>技术字段（ID、版本与原始数据）</summary>
        <Json value={data} />
      </details>
    </div>
  );
}
