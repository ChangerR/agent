/** 已由测试作者审查的桌面夹具；启动信任 UI 在 startup-trust.test.ts 单独验收。 */
import { DesktopController as Base } from '../../desktop/worker/controller.js';
import { createAgent } from './trusted-agent.js';
export class DesktopController extends Base {
  constructor(...args: ConstructorParameters<typeof Base>) {
    super(args[0], (cwd, options) =>
      (args[1] ?? createAgent)(cwd, { ...options, approveStartup: () => true }),
    );
  }
}
