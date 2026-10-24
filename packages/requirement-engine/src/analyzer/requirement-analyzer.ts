/**
 * RequirementAnalyzer：需求分析器（v0.5.0 Phase 1）。
 *
 * 职责：
 *   - 需求就绪性检查（歧义未解决？验收标准未批准？）；
 *   - 严重程度评估（低/中/高）；
 *   - 为 AutonomousRunner 准备好的执行前预检。
 *
 * 不修改需求对象本身（纯函数式）。
 */
import { ForgeError } from '@forgex/shared';
import { isRequirementReady, type StructuredRequirement } from '../types.js';

export interface RequirementAnalysisResult {
  /** 是否可进入执行 */
  ready: boolean;
  /** 就绪性失败原因 */
  reasons: string[];
  /** 综合风险级别 */
  overallRisk: 'low' | 'medium' | 'high';
  /** 歧义数量 */
  ambiguityCount: number;
  /** 未批准验收标准数量 */
  unapprovedCriteriaCount: number;
  /** 已识别的兼容性风险数量 */
  riskCount: number;
}

export class RequirementAnalyzer {
  /**
   * 分析需求，返回就绪性和风险评估。
   */
  analyze(req: StructuredRequirement): RequirementAnalysisResult {
    const readiness = isRequirementReady(req);

    const ambiguityCount = req.ambiguities.filter((a) => !a.resolved).length;
    const unapprovedCriteriaCount = req.acceptanceCriteria.filter((c) => !c.approved).length;
    const riskCount = req.compatibilityRisks.length;

    // 综合风险评估
    const criticalRisks = req.compatibilityRisks.filter((r) => r.severity === 'critical').length;
    const highRisks = req.compatibilityRisks.filter((r) => r.severity === 'high').length;
    const overallRisk: RequirementAnalysisResult['overallRisk'] =
      criticalRisks > 0 ? 'high' : highRisks > 0 ? 'medium' : riskCount > 0 ? 'medium' : 'low';

    return {
      ready: readiness.ready,
      reasons: readiness.reasons,
      overallRisk,
      ambiguityCount,
      unapprovedCriteriaCount,
      riskCount,
    };
  }

  /**
   * 断言需求已就绪，否则抛错（供下游消费前调用）。
   * 安全门禁：未经批准的需求不得进入执行。
   */
  assertReady(req: StructuredRequirement): void {
    const result = this.analyze(req);
    if (!result.ready) {
      throw new ForgeError(
        'REQUIREMENT_AMBIGUITY_UNRESOLVED',
        `需求未就绪：${result.reasons.join('；')}`,
        { details: result as unknown as Record<string, unknown> },
      );
    }
    if (result.overallRisk === 'high') {
      throw new ForgeError(
        'REQUIREMENT_CRITERIA_UNAPPROVED',
        `需求存在高风险兼容性问题，需人工审批后才能执行`,
        { details: { risks: req.compatibilityRisks } },
      );
    }
  }
}
