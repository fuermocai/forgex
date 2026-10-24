/**
 * 增强版 ApprovalManager（v0.4.0 Phase 3）。
 *
 * 职责：
 *   - 四级风险审批（L0 自动放行 / L1 可选 / L2 必须 / L3 人工）；
 *   - 参数哈希绑定，参数变化后重新审批；
 *   - 审批记录持久化（ApprovalStore）；
 *   - 撤销、过期检查；
 *   - 子代理操作强制审批；
 *   - 全字段审计。
 *
 * 安全约束：
 *   - 权限由可信配置决定，模型不可自行决定；
 *   - L3 操作必须人工审批，非交互环境默认拒绝；
 *   - 不允许通过命令拆分绕过审批；
 *   - 默认不允许自动执行生产变更。
 */
import { ForgeError } from '@forgex/shared';
import type { AuditLogger } from '@forgex/security';
import type {
  ApprovalRecord,
  ApprovalRequest,
  ApprovalRiskLevel,
  ApprovalScope,
  ApprovalStatus,
} from './types.js';
import {
  newApprovalId,
  approvalNowIso,
  expiryIso,
} from './types.js';
import { ApprovalPolicy, type ApprovalPolicyConfig } from './policy/approval-policy.js';
import { hashParams } from './requests/param-hasher.js';
import { ApprovalStore } from './store/approval-store.js';
import { ApprovalAudit } from './audit/approval-audit.js';

/** 人工审批处理器 */
export type HumanApprovalHandler = (
  request: ApprovalRequest,
) => Promise<{ approved: boolean; approver: string; reason?: string }>;

export interface ApprovalManagerOptions {
  /** 审批存储 */
  store: ApprovalStore;
  /** 审计日志 */
  auditLogger: AuditLogger;
  /** 策略配置 */
  policyConfig?: ApprovalPolicyConfig;
  /** 人工审批处理器（不传则非交互模式，L3 默认拒绝） */
  approvalHandler?: HumanApprovalHandler;
  /** 默认审批有效期（毫秒），默认 1 小时 */
  defaultTtlMs?: number;
  /** 申请主体 ID */
  applicant?: string;
}

export interface RequestApprovalParams {
  operation: string;
  riskLevel: ApprovalRiskLevel;
  summary: string;
  params: Record<string, unknown>;
  targetEnvironment: string;
  ttlMs?: number;
}

export class ApprovalManager {
  private readonly store: ApprovalStore;
  private readonly audit: ApprovalAudit;
  private readonly policy: ApprovalPolicy;
  private readonly handler: HumanApprovalHandler | undefined;
  private readonly defaultTtlMs: number;
  private readonly applicant: string;

  constructor(options: ApprovalManagerOptions) {
    this.store = options.store;
    this.audit = new ApprovalAudit(options.auditLogger);
    this.policy = new ApprovalPolicy(options.policyConfig);
    this.handler = options.approvalHandler;
    this.defaultTtlMs = options.defaultTtlMs ?? 60 * 60 * 1000;
    this.applicant = options.applicant ?? 'forgex-agent';
  }

  /**
   * 请求审批。
   *
   * 流程：
   *   1. 计算参数哈希；
   *   2. 检查是否已有有效审批（相同 scope hash）；
   *   3. L0 自动放行；
   *   4. L3 必须人工审批，非交互模式拒绝；
   *   5. L1/L2 根据策略决定。
   *
   * @returns 审批结果（approved/denied）和审批记录
   */
  async requestApproval(params: RequestApprovalParams): Promise<{ approved: boolean; record: ApprovalRecord }> {
    const paramHash = hashParams(params.operation, params.params);
    const scope: ApprovalScope = {
      operation: params.operation,
      paramHash,
      targetEnvironment: params.targetEnvironment,
      expiresAt: expiryIso(params.ttlMs ?? this.defaultTtlMs),
    };

    // 检查是否已有有效审批
    if (this.store.hasValidApproval(paramHash)) {
      const existing = this.store.listByScope(paramHash).find(
        (r) => r.status === 'approved' && r.scope.expiresAt > approvalNowIso(),
      );
      if (existing) {
        return { approved: true, record: existing };
      }
    }

    // 创建审批记录
    const record: ApprovalRecord = {
      id: newApprovalId(),
      operation: params.operation,
      riskLevel: params.riskLevel,
      summary: params.summary,
      scope,
      applicant: this.applicant,
      approver: '',
      status: 'pending',
      createdAt: approvalNowIso(),
    };
    this.store.create(record);
    await this.audit.recordRequest(record);

    // L0 自动放行
    if (this.policy.isAutoAllowed(params.riskLevel)) {
      this.store.updateStatus(record.id, 'approved', 'auto');
      record.status = 'approved';
      record.approver = 'auto';
      record.decidedAt = approvalNowIso();
      return { approved: true, record };
    }

    // 生产环境 L3 默认拒绝
    if (this.policy.isProductionDefaultDeny(params.riskLevel)) {
      this.store.updateStatus(record.id, 'denied', 'system', '生产环境 L3 操作默认拒绝');
      record.status = 'denied';
      record.denialReason = '生产环境 L3 操作默认拒绝';
      return { approved: false, record };
    }

    // L3 必须人工审批
    if (this.policy.requiresHumanApproval(params.riskLevel)) {
      if (!this.handler) {
        // 非交互模式，默认拒绝
        this.store.updateStatus(record.id, 'denied', 'system', '非交互模式，L3 操作默认拒绝');
        record.status = 'denied';
        record.denialReason = '非交互模式，L3 操作默认拒绝';
        return { approved: false, record };
      }

      const request: ApprovalRequest = {
        id: record.id,
        operation: record.operation,
        riskLevel: record.riskLevel,
        summary: record.summary,
        params: params.params,
        scope: record.scope,
        applicant: record.applicant,
        createdAt: record.createdAt,
      };

      const decision = await this.handler(request);
      if (decision.approved) {
        this.store.updateStatus(record.id, 'approved', decision.approver);
        record.status = 'approved';
        record.approver = decision.approver;
        record.decidedAt = approvalNowIso();
        await this.audit.recordDecision(record, 'approved', decision.approver);
        return { approved: true, record };
      } else {
        this.store.updateStatus(record.id, 'denied', decision.approver, decision.reason ?? '用户拒绝');
        record.status = 'denied';
        record.approver = decision.approver;
        record.denialReason = decision.reason ?? '用户拒绝';
        record.decidedAt = approvalNowIso();
        await this.audit.recordDecision(record, 'denied', decision.approver);
        return { approved: false, record };
      }
    }

    // L1 可选、L2 必须（但无 handler 时 L2 也拒绝）
    const requirement = this.policy.getRequirement(params.riskLevel);
    if (requirement === 'optional') {
      // L1 可选：无 handler 时放行
      this.store.updateStatus(record.id, 'approved', 'auto-optional');
      record.status = 'approved';
      record.approver = 'auto-optional';
      record.decidedAt = approvalNowIso();
      return { approved: true, record };
    }

    // L2 必须：无 handler 时拒绝
    if (!this.handler) {
      this.store.updateStatus(record.id, 'denied', 'system', '非交互模式，L2 操作被拒绝');
      record.status = 'denied';
      record.denialReason = '非交互模式，L2 操作被拒绝';
      return { approved: false, record };
    }

    const request: ApprovalRequest = {
      id: record.id,
      operation: record.operation,
      riskLevel: record.riskLevel,
      summary: record.summary,
      params: params.params,
      scope: record.scope,
      applicant: record.applicant,
      createdAt: record.createdAt,
    };

    const decision = await this.handler(request);
    if (decision.approved) {
      this.store.updateStatus(record.id, 'approved', decision.approver);
      record.status = 'approved';
      record.approver = decision.approver;
      record.decidedAt = approvalNowIso();
      await this.audit.recordDecision(record, 'approved', decision.approver);
      return { approved: true, record };
    } else {
      this.store.updateStatus(record.id, 'denied', decision.approver, decision.reason ?? '用户拒绝');
      record.status = 'denied';
      record.denialReason = decision.reason ?? '用户拒绝';
      await this.audit.recordDecision(record, 'denied', decision.approver);
      return { approved: false, record };
    }
  }

  /** 撤销审批 */
  revoke(approvalId: string): void {
    const record = this.store.get(approvalId);
    if (!record) {
      throw new ForgeError('APPROVAL_REVOKED', `审批记录不存在: ${approvalId}`);
    }
    if (record.status === 'approved') {
      this.store.updateStatus(approvalId, 'revoked');
    }
  }

  /** 检查审批是否过期 */
  isExpired(approvalId: string): boolean {
    const record = this.store.get(approvalId);
    if (!record) return true;
    return record.scope.expiresAt < approvalNowIso();
  }

  /** 清理过期审批 */
  expireOutdated(): number {
    return this.store.expireOutdated();
  }

  /** 检查指定操作+参数是否已有有效审批 */
  hasValidApproval(operation: string, params: Record<string, unknown>): boolean {
    const paramHash = hashParams(operation, params);
    return this.store.hasValidApproval(paramHash);
  }
}
