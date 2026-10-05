/**
 * 会话读写的可区分错误。调用方按 code 分支，文案直接给用户看。
 */

export type SessionErrorCode =
  | 'invalid_id'
  | 'not_found'
  | 'corrupt'
  | 'unsupported_version'
  | 'invalid_schema'
  | 'invariant'
  | 'cwd_mismatch'
  | 'provider_mismatch'
  | 'conflict'
  | 'io'
  | 'busy';

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly path?: string;

  constructor(code: SessionErrorCode, message: string, options?: { cause?: unknown; path?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SessionError';
    this.code = code;
    this.path = options?.path;
  }
}

export function invalidIdMessage(id: string): string {
  return `会话 id 不合法: "${id}"。只允许字母、数字、- 和 _，长度 1~64。`;
}

/** Node 文件系统错误上的 code；没有时给一个稳定占位，方便写进 io 文案。 */
export function errnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return 'UNKNOWN';
}
