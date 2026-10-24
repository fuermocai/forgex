/**
 * LegacyApprovalManager：旧 ApprovalManager 兼容包装（v0.4.0 Phase 3）。
 *
 * 使 v0.3.0 的调用方（使用 security.ApprovalManager 的旧接口）无需修改。
 * 旧接口：request(ApprovalRequest, signal?) → Promise<'approved' | 'denied' | 'timeout'>
 *
 * 映射关系：
 *   - 旧 riskLevel ('read'|'write'|'execute'|'privileged') → 新 L0-L3
 *   - 旧 ApprovalRequest.input → 新 params
 *   - 旧 'timeout' → 新 'denied'（超时视为拒绝）
 */
import type { ApprovalRequest as SharedApprovalRequest, RiskLevel, Logger } from '@forgex/shared';
import { ApprovalManager } from '../approval-manager.js';
import type { ApprovalRiskLevel } from '../types.js';

export type LegacyApprovalDecision = 'approved' | 'denied' | 'timeout';

/** 旧 riskLevel → 新 L0-L3 映射 */
function mapRiskLevel(risk: RiskLevel): ApprovalRiskLevel {
  switch (risk) {
    case 'read':
      return 'L0';
    case 'write':
      return 'L1';
    case 'execute':
      return 'L2';
    case 'privileged':
      return 'L3';
    default:
      return 'L2';
  }
}

export interface LegacyApprovalManagerOptions {
  approvalManager: ApprovalManager;
  logger?: Logger;
  /** 审批等待上限（毫秒），默认 120s */
  timeoutMs?: number;
}

export class LegacyApprovalManager {
  private readonly manager: ApprovalManager;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;

  constructor(options: LegacyApprovalManagerOptions) {
    this.manager = options.approvalManager;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** 是否具备交互审批能力 */
  get interactive(): boolean {
    // 新 ApprovalManager 如果配置了 handler 则为交互模式
    // 这里通过尝试 L3 操作是否会被默认拒绝来判断
    return true; // 简化处理：总是返回 true，实际审批由内部 handler 决定
  }

  /**
   * 旧接口 request。
   * 映射到新 ApprovalManager.requestApproval。
   */
  async request(
    request: SharedApprovalRequest,
    signal?: AbortSignal,
  ): Promise<LegacyApprovalDecision> {
    if (signal?.aborted) {
      return 'denied';
    }

    this.logger?.info('发起审批请求（兼容接口）', {
      id: request.id,
      tool: request.tool,
      riskLevel: request.riskLevel,
      reason: request.reason,
    });

    // 设置超时
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        this.logger?.warn('审批超时', { id: request.id });
      }
    }, this.timeoutMs);
    timer.unref?.();

    // 信号监听
    const onAbort = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await this.manager.requestApproval({
        operation: request.tool,
        riskLevel: mapRiskLevel(request.riskLevel),
        summary: request.reason,
        params: { input: request.input, preview: request.preview },
        targetEnvironment: 'default',
      });

      if (settled) {
        // 已超时或取消
        return signal?.aborted ? 'denied' : 'timeout';
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      return result.approved ? 'approved' : 'denied';
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      this.logger?.error('审批异常，按拒绝处理', {
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'denied';
    }
  }
}
