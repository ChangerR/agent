/** 拒绝只终止该真实用户请求及其委派；计划状态和模型文本不能解除。 */
export class RequestPermissionGuard {
  private readonly denied = new Set<string>();

  deny(scope: string): void {
    this.denied.add(scope);
  }
  isDenied(scope: string): boolean {
    return this.denied.has(scope);
  }
}
