/**
 * ApprovalManager：人工审批通道。
 *
 * 行为约定：
 *  - 非交互环境（没有审批回调）一律拒绝，绝不"默认放行"；
 *  - 审批超时视为拒绝（timeout），避免 Agent 永久挂起；
 *  - 用户取消（AbortSignal）视为拒绝；
 *  - 回调抛错视为拒绝，并记录日志，不让异常冒泡到 Agent Loop。
 */
import type { ApprovalRequest, Logger } from '@forgex/shared';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout';

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean> | boolean;

export interface ApprovalManagerOptions {
  /** 交互式审批回调；缺省表示非交互环境 */
  handler?: ApprovalHandler;
  /** 审批等待上限（毫秒），默认 120s */
  timeoutMs?: number;
  logger?: Logger;
}

export class ApprovalManager {
  private readonly handler: ApprovalHandler | undefined;
  private readonly timeoutMs: number;
  private readonly logger: Logger | undefined;

  constructor(options: ApprovalManagerOptions = {}) {
    this.handler = options.handler;
    this.timeoutMs = Math.max(50, options.timeoutMs ?? 120_000);
    this.logger = options.logger;
  }

  /** 是否具备交互审批能力（CLI 用于提示用户） */
  get interactive(): boolean {
    return typeof this.handler === 'function';
  }

  async request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (!this.handler) {
      this.logger?.warn('非交互模式，自动拒绝审批请求', { tool: request.tool, reason: request.reason });
      return 'denied';
    }
    if (signal?.aborted) {
      return 'denied';
    }

    this.logger?.info('发起审批请求', {
      id: request.id,
      tool: request.tool,
      riskLevel: request.riskLevel,
      reason: request.reason,
    });

    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.logger?.info('审批结束', { id: request.id, decision });
        resolve(decision);
      };

      const onAbort = () => finish('denied');
      signal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => finish('timeout'), this.timeoutMs);
      timer.unref?.();

      void (async () => {
        try {
          const approved = await this.handler!(request);
          finish(approved ? 'approved' : 'denied');
        } catch (err) {
          this.logger?.error('审批回调异常，按拒绝处理', {
            id: request.id,
            error: err instanceof Error ? err.message : String(err),
          });
          finish('denied');
        }
      })();
    });
  }
}
