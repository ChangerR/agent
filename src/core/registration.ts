/** 启动期原子注册计划；封存或冻结后不能再回滚、变更会话能力图。 */
export interface RegistrationBatch {
  validate(): void;
  commit(): void;
  rollback(): void;
  seal(): void;
}
export function prepareRegistration<T>(before: T, after: T, read: () => T, write: (value: T) => void, assertMutable: () => void): RegistrationBatch {
  let committed = false; let sealed = false;
  const validate = () => {
    if (sealed || committed) throw new Error('Registration batch is closed');
    assertMutable();
    if (read() !== before) throw new Error('Registration target changed before commit');
  };
  return Object.freeze({
    validate,
    commit() { validate(); write(after); committed = true; },
    rollback() {
      if (sealed) throw new Error('Registration batch is closed');
      if (committed) {
        assertMutable();
        if (read() !== after) throw new Error('Registration target changed; rollback would remove unrelated registrations');
        write(before);
      }
      sealed = true;
    },
    seal() { sealed = true; },
  });
}
