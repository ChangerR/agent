/** 跨进程回归夹具：两个 FakeProvider agent 先恢复同一版本，再同时尝试保存。 */
import { createAgent } from '../../src/index.js';

const [cwd, id, text] = process.argv.slice(2);
const agent = await createAgent(cwd, { autoSaveSessions: false });
await agent.session.resume(id);
process.send?.({ type: 'ready' });
process.once('message', async () => {
  try {
    await agent.loop.run(text);
    await agent.session.save();
    process.send?.({ type: 'result', ok: true });
  } catch (error) {
    process.send?.({ type: 'result', ok: false, code: (error as { code?: string }).code, message: String(error) });
  } finally {
    // 结果已明确报告；夹具仅清理进程，避免重复发送 flush 中的同一错误。
    await agent.dispose().catch(() => undefined);
    process.disconnect?.();
  }
});
