/**
 * Approval Engine 类型定义（v0.4.0 Phase 3）。
 *
 * 四级风险模型：
 *   L0 只读操作 — 自动放行
 *   L1 工作区内低风险修改 — 可选审批
 *   L2 敏感操作 — 必须审批
 *   L3 高风险操作 — 必须人工审批，默认拒绝
 *
 * 审批绑定具体操作及参数（参数哈希），参数变化后重新审批。
 */
import { uuid } from '@forgex/shared';

/** 审批风险等级 */
export type ApprovalRiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

export const APPROVAL_RISK_LEVELS: readonly ApprovalRiskLevel[] = ['L0', 'L1', 'L2', 'L3'];

/** 审批状态 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired';

/** 审批范围——绑定具体操作、参数、目标环境、有效期 */
export interface ApprovalScope {
  /** 操作名（如 edit_file、run_command、git_commit） */
  operation: string;
  /** 参数哈希（SHA-256，包含完整参数） */
  paramHash: string;
  /** 目标环境（如 production、staging、local） */
  targetEnvironment: string;
  /** 有效期截止时间（ISO 字符串） */
  expiresAt: string;
}

/** 审批请求 */
export interface ApprovalRequest {
  /** 审批 ID */
  id: string;
  /** 操作名 */
  operation: string;
  /** 风险等级 */
  riskLevel: ApprovalRiskLevel;
  /** 操作摘要（给人看） */
  summary: string;
  /** 完整参数（已脱敏，用于展示） */
  params: Record<string, unknown>;
  /** 审批范围 */
  scope: ApprovalScope;
  /** 申请主体（Agent ID 或用户 ID） */
  applicant: string;
  /** 创建时间 ISO */
  createdAt: string;
}

/** 审批记录（持久化） */
export interface ApprovalRecord {
  /** 审批 ID */
  id: string;
  /** 操作名 */
  operation: string;
  /** 风险等级 */
  riskLevel: ApprovalRiskLevel;
  /** 操作摘要 */
  summary: string;
  /** 审批范围 */
  scope: ApprovalScope;
  /** 申请主体 */
  applicant: string;
  /** 审批主体（用户 ID，未审批时为空） */
  approver: string;
  /** 审批状态 */
  status: ApprovalStatus;
  /** 审批决策时间 ISO */
  decidedAt?: string;
  /** 拒绝原因 */
  denialReason?: string;
  /** 创建时间 ISO */
  createdAt: string;
}

/** 审批要求级别 */
export type ApprovalRequirement =
  | 'auto_allow' // L0: 自动放行
  | 'optional' // L1: 可选审批
  | 'required' // L2: 必须审批
  | 'manual_required'; // L3: 必须人工审批

/** 生成审批 ID */
export function newApprovalId(): string {
  return `appr_${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** 当前 UTC 时间 ISO */
export function approvalNowIso(): string {
  return new Date().toISOString();
}

/** 计算有效期截止时间 */
export function expiryIso(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}
