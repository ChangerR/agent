import { DesktopController } from './controller.js';
import type { WorkerMessage, WorkerRequest } from '../shared/protocol.js';
const send = (message: WorkerMessage) => {
  if (process.connected) process.send?.(message);
};
const controller = new DesktopController((state) => send({ type: 'state', state }));
let startup: Promise<void> = Promise.resolve();
process.on('message', async (raw: WorkerRequest) => {
  if (!raw || typeof raw.id !== 'string') return;
  try {
    if (raw.action.type === 'init') {
      startup = controller.initialize(raw.action.cwd, raw.action.demo, raw.action.generation);
      await startup;
    } else if (raw.action.type === 'dispose') {
      await startup.catch(() => {});
      await controller.dispose();
    } else await controller.handle(raw.action);
    send({ type: 'reply', id: raw.id });
  } catch (error) {
    // 任意插件或 SDK 的异常可能含请求与凭证，进程边界只返回固定安全说明。
    send({
      type: 'reply',
      id: raw.id,
      error:
        error instanceof Error &&
        /会话已变化|当前操作尚未结算|审批已结束|选择已失效|此任务已提交/.test(error.message)
          ? error.message
          : '操作失败。请检查项目配置、权限、会话冲突或模型连接。',
    });
  }
});
process.on('disconnect', () => {
  void startup
    .catch(() => {})
    .then(() => controller.dispose())
    .finally(() => process.exit(0));
});
send({ type: 'ready' });
