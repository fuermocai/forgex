/**
 * ApprovalPolicy：审批策略（v0.4.0 Phase 3）。
 *
 * 根据风险级别返回审批要求：
 *   L0 只读 — auto_allow（自动放行）
 *   L1 工作区低风险修改 — optional（可选审批）
 *   L2 敏感操作 — required（必须审批）
 *   L3 高风险 — manual_required（必须人工审批，默认拒绝）
 *
 * 安全约束：
 *   - 策略由可信配置决定，模型不可指定或提升风险级别；
 *   - 生产环境默认只读，L3 操作默认拒绝。
 */
import type { ApprovalRequirement, ApprovalRiskLevel } from '../types.js';
import { APPROVAL_RISK_LEVELS } from '../types.js';

/** 策略配置 */
export interface ApprovalPolicyConfig {
  /** 是否为生产环境（生产环境 L3 默认拒绝） */
  isProduction?: boolean;
  /** 各级别覆盖配置 */
  overrides?: Partial<Record<ApprovalRiskLevel, ApprovalRequirement>>;
}

/** 默认策略映射 */
const DEFAULT_POLICY: Record<ApprovalRiskLevel, ApprovalRequirement> = {
  L0: 'auto_allow',
  L1: 'optional',
  L2: 'required',
  L3: 'manual_required',
};

export class ApprovalPolicy {
  private readonly config: ApprovalPolicyConfig;

  constructor(config: ApprovalPolicyConfig = {}) {
    this.config = config;
  }

  /**
   * 获取指定风险级别的审批要求。
   * 模型不可调用此方法来提升权限——风险级别由可信配置决定。
   */
  getRequirement(riskLevel: ApprovalRiskLevel): ApprovalRequirement {
    if (!APPROVAL_RISK_LEVELS.includes(riskLevel)) {
      // 未知风险级别按最严格处理
      return 'manual_required';
    }
    return this.config.overrides?.[riskLevel] ?? DEFAULT_POLICY[riskLevel];
  }

  /**
   * 是否需要人工审批。
   * L3 始终需要；L2 根据配置；L0/L1 不需要。
   */
  requiresHumanApproval(riskLevel: ApprovalRiskLevel): boolean {
    const req = this.getRequirement(riskLevel);
    return req === 'manual_required';
  }

  /**
   * 是否自动放行（无需审批）。
   * L0 默认自动放行。
   */
  isAutoAllowed(riskLevel: ApprovalRiskLevel): boolean {
    return this.getRequirement(riskLevel) === 'auto_allow';
  }

  /**
   * 生产环境 L3 是否默认拒绝。
   */
  isProductionDefaultDeny(riskLevel: ApprovalRiskLevel): boolean {
    return this.config.isProduction === true && riskLevel === 'L3';
  }
}
