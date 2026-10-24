/**
 * 审批桥：连接 ApprovalManager 与终端 UI。
 *
 * ApprovalManager 只接受一个 `(request) => Promise<boolean>` 回调；
 * TUI 的输入是异步键事件，因此需要一个中间层：
 *  - `handler` 交给 ApprovalManager；
 *  - `onRequest` 让 UI 渲染审批提示；
 *  - `respond` 由 UI 在用户按键后调用。
 *
 * 竞态处理：用户可能在 handler 注册 promise 之前就按键（例如预输入），
 * 因此响应会先暂存，下一次 ask 时直接消费。
 */
import type { ApprovalRequest } from '@forgex/shared';
import type { ApprovalHandler } from '@forgex/security';

export class ApprovalBridge {
  private resolver: ((approved: boolean) => void) | null = null;
  private queued: boolean | null = null;
  private listener: ((request: ApprovalRequest) => void) | null = null;

  /** 交给 ApprovalManager 的回调 */
  readonly handler: ApprovalHandler = async (request: ApprovalRequest): Promise<boolean> => {
    this.listener?.(request);
    if (this.queued !== null) {
      const value = this.queued;
      this.queued = null;
      return value;
    }
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  };

  /** UI 注册审批提示回调，返回取消订阅函数 */
  onRequest(listener: (request: ApprovalRequest) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** UI 在用户按下 y/n 后调用 */
  respond(approved: boolean): void {
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(approved);
      return;
    }
    this.queued = approved;
  }

  /** 会话取消时按拒绝处理，避免 Agent 永久挂起 */
  cancel(): void {
    this.respond(false);
  }
}
