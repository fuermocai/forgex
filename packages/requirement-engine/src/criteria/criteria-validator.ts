/**
 * AcceptanceCriteriaValidator：验收标准验证器（v0.5.0 Phase 1）。
 *
 * 安全门禁（类型级强制）：
 *   - 所有 AcceptanceCriterion.approved === true 才视为有效；
 *   - CriteriaGenerator 生成的全是 draft（approved=false），必须由用户显式批准；
 *   - 不允许模型在生成时偷偷设置 approved=true。
 *
 * 不做批准操作本身 —— 批准必须由上层（UI/CLI/人工审批流程）驱动。
 */
import { ForgeError } from '@forgex/shared';
import type { AcceptanceCriterion } from '../types.js';

export interface CriteriaValidationResult {
  valid: boolean;
  /** 总数量 */
  total: number;
  /** 已批准数量 */
  approved: number;
  /** 不可验证标准（testable=false） */
  nonTestable: number;
  /** 不可用原因 */
  reasons: string[];
}

export class AcceptanceCriteriaValidator {
  /**
   * 验证验收标准列表是否可用于执行。
   *
   * 规则：
   *   1. 至少 1 条标准；
   *   2. 所有标准必须 approved=true；
   *   3. 标准描述非空；
   *   4. 不可测试的标准必须有 verificationMethod（说明怎么人工验证）。
   */
  validate(criteria: AcceptanceCriterion[]): CriteriaValidationResult {
    const reasons: string[] = [];

    if (criteria.length === 0) {
      reasons.push('验收标准列表为空');
      return { valid: false, total: 0, approved: 0, nonTestable: 0, reasons };
    }

    const approved = criteria.filter((c) => c.approved).length;
    const nonTestable = criteria.filter((c) => !c.testable).length;

    if (approved < criteria.length) {
      const unapproved = criteria.length - approved;
      reasons.push(`存在 ${unapproved} 条未批准的验收标准 —— 必须由用户显式批准`);
    }

    // 描述空检查
    const emptyDesc = criteria.filter((c) => !c.description.trim()).length;
    if (emptyDesc > 0) {
      reasons.push(`存在 ${emptyDesc} 条描述为空的验收标准`);
    }

    // 不可测试标准的 verificationMethod 必须非空
    const missingMethod = criteria.filter(
      (c) => !c.testable && !c.verificationMethod.trim(),
    ).length;
    if (missingMethod > 0) {
      reasons.push(
        `存在 ${missingMethod} 条不可测试但缺少人工验证方法的验收标准`,
      );
    }

    return {
      valid: reasons.length === 0,
      total: criteria.length,
      approved,
      nonTestable,
      reasons,
    };
  }

  /**
   * 断言有效，否则抛错。供下游消费前调用。
   */
  assertValid(criteria: AcceptanceCriterion[]): void {
    const result = this.validate(criteria);
    if (!result.valid) {
      throw new ForgeError(
        'REQUIREMENT_CRITERIA_UNAPPROVED',
        `验收标准未就绪：${result.reasons.join('；')}`,
        { details: result as unknown as Record<string, unknown> },
      );
    }
  }
}
