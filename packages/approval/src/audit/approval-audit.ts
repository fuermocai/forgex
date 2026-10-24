/**
 * ApprovalAudit：审批审计（v0.4.0 Phase 3）。
 *
 * 职责：
 *   - 审批事件写入 AuditLogger；
 *   - 包含操作摘要、风险级别、目标环境、申请主体、审批主体、有效期、决策时间；
 *   - 敏感字段脱敏。
 */
import type { AuditLogger, AuditEventInput } from '@forgex/security';
import { redactValue } from '@forgex/shared';
import type { ApprovalRecord } from '../types.js';

export class ApprovalAudit {
  private readonly auditLogger: AuditLogger;

  constructor(auditLogger: AuditLogger) {
    this.auditLogger = auditLogger;
  }

  /** 记录审批请求 */
  async recordRequest(record: ApprovalRecord): Promise<string> {
    const event: AuditEventInput = {
      type: 'approval',
      sessionId: record.applicant,
      tool: record.operation,
      riskLevel: record.riskLevel === 'L0' ? 'read' : record.riskLevel === 'L1' ? 'write' : record.riskLevel === 'L2' ? 'execute' : 'privileged',
      decision: 'ask',
      actor: 'agent',
      meta: {
        approvalId: record.id,
        riskLevel: record.riskLevel,
        targetEnvironment: record.scope.targetEnvironment,
        applicant: record.applicant,
        expiresAt: record.scope.expiresAt,
        summary: record.summary,
      },
    };
    return this.auditLogger.record(redactValue(event) as AuditEventInput);
  }

  /** 记录审批决策 */
  async recordDecision(
    record: ApprovalRecord,
    decision: 'approved' | 'denied',
    approver: string,
  ): Promise<string> {
    const event: AuditEventInput = {
      type: 'approval',
      sessionId: record.applicant,
      tool: record.operation,
      riskLevel: record.riskLevel === 'L0' ? 'read' : record.riskLevel === 'L1' ? 'write' : record.riskLevel === 'L2' ? 'execute' : 'privileged',
      decision,
      actor: 'user',
      ok: decision === 'approved',
      meta: {
        approvalId: record.id,
        riskLevel: record.riskLevel,
        targetEnvironment: record.scope.targetEnvironment,
        applicant: record.applicant,
        approver,
        decidedAt: record.decidedAt,
        expiresAt: record.scope.expiresAt,
        denialReason: record.denialReason,
      },
    };
    return this.auditLogger.record(redactValue(event) as AuditEventInput);
  }
}
