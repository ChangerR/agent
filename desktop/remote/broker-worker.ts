/** 本地独立模型进程；凭据只通过本地 IPC 注入，绝不写出配置或日志。 */
import { ModelBroker, configureBroker } from './broker.js';
import type { AgentConfig } from '../../src/core/config.js';
const broker = new ModelBroker();
process.on('message', async (m: { id: string; method: string; payload: unknown }) => {
  if (!m || typeof m.id !== 'string') return;
  try {
    let result: unknown;
    if (m.method === 'configure') {
      const p = m.payload as {
        config: AgentConfig;
        requirements: Array<{ name: string; models: string[] }>;
        mappings: Record<string, string>;
        credentials: Record<string, { key: string; binding: string }>;
      };
      result = configureBroker(broker, p.config, p.requirements, p.mappings, (ref, identity) => {
        const item = p.credentials[ref];
        if (!item || item.binding !== identity) throw new Error('CREDENTIAL_UNAVAILABLE');
        return item.key;
      });
    } else if (m.method === 'activate') {
      broker.activate();
      result = null;
    } else if (m.method === 'dispose') {
      broker.close();
      result = null;
    } else result = await broker.handle(m.method, m.payload);
    if (process.connected) process.send?.({ id: m.id, result });
  } catch (e) {
    if (process.connected)
      process.send?.({
        id: m.id,
        error:
          e instanceof Error && /^[A-Z_]{2,80}$/.test(e.message)
            ? e.message
            : 'BROKER_REQUEST_FAILED',
      });
  }
});
process.on('disconnect', () => {
  broker.close();
  process.exit(0);
});
