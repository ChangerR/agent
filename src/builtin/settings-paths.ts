/** 注册领域配置只允许留在它所属的配置根内，包括尚未创建的父目录。 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  PluginConfigStore,
  SettingsPartialSaveError,
  type ConfigSnapshot,
} from '../runtime/config-store.js';
/** 显式领域保存同时激活所选层引用；先检查两份 CAS，失败时只回滚自己的写入。 */
export function commitSettingsReference(
  store: PluginConfigStore,
  base: ConfigSnapshot,
  field: 'modelsFile' | 'mcpConfig',
  path: string,
  activate: boolean,
  write: () => ConfigSnapshot,
  rollback: (written: ConfigSnapshot) => void,
): void {
  store.assertUnchanged(base);
  const written = write();
  if (activate)
    try {
      store.commitFields(base, { [field]: path });
    } catch (error) {
      try {
        rollback(written);
      } catch {
        throw new SettingsPartialSaveError();
      }
      throw error;
    }
}
function canonical(path: string): string {
  const pending: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error('配置根不存在。');
    pending.unshift(relative(parent, current));
    current = parent;
  }
  return join(realpathSync(current), ...pending);
}
export function assertManagedSettingsPath(root: string, path: string): void {
  const base = canonical(root),
    parent = canonical(dirname(path)),
    r = relative(base, parent);
  if (
    isAbsolute(r) ||
    r === '..' ||
    r.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
  )
    throw new Error('配置路径超出所属项目或用户配置根；请在图形路径设置中选择受管位置。');
}
