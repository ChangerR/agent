/**
 * 独立可信 ESM 插件：只改配置即可替换 policy / compactor / store。
 * 不导入 Agent、默认实现或终端代码；注册函数即其依赖边界。
 * 此示例存储只存在于当前进程，退出后丢失，不能用于需要持久化的会话。
 */
export default {
  manifest: { id: 'example.replace-capabilities', version: '1.0.0', apiVersion: 1, configVersion: 1 },
  config: { defaults: { prefix: 'example' }, applyMode: 'new-session' },
  setup(ctx) {
    const counters = { compactions: 0, decisions: 0, tools: 0, requests: 0 };
    const files = new Map();
    const tombstones = new Map();
    const path = (cwd, id) => `memory:${cwd}/${id}`;
    const conflict = () => Object.assign(new Error('Memory session revision conflict'), { code: 'conflict' });
    const store = {
      path,
      async load(cwd, id) {
        const file = files.get(path(cwd, id));
        if (!file) throw Object.assign(new Error(`Unknown session: ${id}`), { code: 'not_found' });
        return structuredClone(file);
      },
      async save(file, options = {}) {
        const key = path(file.cwd, file.id);
        const current = files.get(key);
        const deleted = tombstones.get(key);
        const revision = current?.revision ?? deleted ?? 0;
        const recreate = !current && deleted !== undefined && options.recreate === true && revision === (options.recreateRevision ?? (file.revision ?? 0) + 1);
        if ((!recreate && (file.revision ?? 0) !== revision) || (!current && deleted !== undefined && !recreate)) throw conflict();
        files.set(key, structuredClone({ ...file, revision: revision + 1 }));
        return { path: key, revision: revision + 1 };
      },
      async list(cwd) {
        const sessions = [...files.values()].filter(file => file.cwd === cwd).map(file => ({ id: file.id, title: file.title, createdAt: file.createdAt, updatedAt: file.updatedAt, model: file.model, messageCount: file.messages.length, path: path(cwd, file.id) }));
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
        return { sessions, broken: [] };
      },
      async delete(cwd, id) {
        const key = path(cwd, id); const current = files.get(key);
        if (!current) return { deleted: false, revision: tombstones.get(key) ?? 0 };
        const revision = (current.revision ?? 0) + 1;
        tombstones.set(key, revision); files.delete(key);
        return { deleted: true, revision };
      },
      async latest(cwd) { return (await store.list(cwd)).sessions[0]?.id; },
    };
    ctx.provide.sessionStore('example-memory', store);
    ctx.provide.compactor('example-noop', { async compact(messages, _provider, signal) { signal.throwIfAborted(); counters.compactions++; return messages; } });
    ctx.provide.policy('example-policy', {
      id: 'example-policy', version: '1.0.0',
      decide({ tool, input }, signal) {
        signal.throwIfAborted(); counters.decisions++;
        const allowed = tool.name === 'example_echo' && input.message !== 'blocked';
        return { kind: allowed ? 'allow' : 'deny', source: 'config', reason: '仅允许演示 echo 工具的非 blocked 输入', reasonCode: allowed ? 'example_allow' : 'example_deny' };
      },
    });
    ctx.provide.tool('example_echo', {
      name: 'example_echo', version: '1.0.0', description: '返回文字并验证统一执行路径', risk: 'write',
      inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
      async execute(input, context) { context.signal.throwIfAborted(); counters.tools++; return { content: `${ctx.config.value.prefix}: ${input.message}` }; },
    });
    ctx.provide.command('example', {
      description: '经过相同权限入口调用演示工具', aliases: ['example-echo'],
      async handler(input, context) {
        const result = await context.invokeTool('example_echo', { message: String(input.args ?? input.message ?? '') });
        return { type: 'text', text: result.content };
      },
    });
    ctx.provide.settings('example-state', {
      title: '插件替换验证', schema: { type: 'object' }, applyMode: 'new-session',
      read() { return { ...counters, storedSessions: files.size, prefix: ctx.config.value.prefix }; },
    });
    ctx.provide.contextSource('example-context', {
      getContext(_input, signal) { signal.throwIfAborted(); return [{ id: 'example', source: 'example.replace-capabilities', stability: 'stable', text: '这是独立 ESM 插件提供的上下文。' }]; },
    });
    ctx.provide.provider('architecture-demo', {
      name: 'architecture-demo', capabilities: { thinking: false, streaming: true },
      async *stream(request, signal) {
        signal.throwIfAborted(); counters.requests++;
        yield { type: 'message_start' };
        if (typeof request.messages.at(-1)?.content === 'string') {
          yield { type: 'tool_use_start', id: `example-${counters.requests}`, name: 'example_echo' };
          yield { type: 'tool_use_delta', input: JSON.stringify({ message: 'model invocation' }) };
          yield { type: 'tool_use_stop' };
          yield { type: 'message_stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: 'example complete' };
          yield { type: 'message_stop', stopReason: 'end_turn' };
        }
        yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      },
    });
  },
};
