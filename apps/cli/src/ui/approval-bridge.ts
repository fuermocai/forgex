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
  private active: { request: ApprovalRequest; resolve: (approved: boolean) => void } | null = null;
  private readonly pending: Array<{ request: ApprovalRequest; resolve: (approved: boolean) => void }> = [];
  private queued: boolean | null = null;
  private listener: ((request: ApprovalRequest) => void) | null = null;

  /** 交给 ApprovalManager 的回调 */
  readonly handler: ApprovalHandler = async (request: ApprovalRequest): Promise<boolean> => {
    if (this.active === null && this.pending.length === 0 && this.queued !== null) {
      const value = this.queued;
      this.queued = null;
      return value;
    }
    return new Promise<boolean>((resolvePromise) => {
      this.pending.push({ request, resolve: resolvePromise });
      this.showNext();
    });
  };

  /** UI 注册审批提示回调，返回取消订阅函数 */
  onRequest(listener: (request: ApprovalRequest) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  /** Resolves the visible approval choice selected by the user. */
  respond(approved: boolean): void {
    if (this.active) {
      const active = this.active;
      this.active = null;
      active.resolve(approved);
      this.showNext();
      return;
    }
    this.queued = approved;
  }

  /** Removes an approval whose manager-side timeout or cancellation has settled. */
  dismiss(requestId: string): void {
    if (this.active?.request.id === requestId) {
      const active = this.active;
      this.active = null;
      active.resolve(false);
      this.showNext();
      return;
    }

    const pendingIndex = this.pending.findIndex((item) => item.request.id === requestId);
    if (pendingIndex < 0) return;
    const [pending] = this.pending.splice(pendingIndex, 1);
    pending?.resolve(false);
  }

  /** 会话取消时按拒绝处理，避免 Agent 永久挂起 */
  cancel(): void {
    this.active?.resolve(false);
    this.active = null;
    for (const pending of this.pending.splice(0)) pending.resolve(false);
    this.queued = null;
  }

  private showNext(): void {
    if (this.active || this.pending.length === 0) return;
    this.active = this.pending.shift() ?? null;
    if (!this.active) return;
    this.listener?.(this.active.request);
  }
}
