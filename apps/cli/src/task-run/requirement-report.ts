import {
  AcceptanceCriteriaValidator,
  RequirementAnalyzer,
  makeCriterion,
  makeStructuredRequirement,
  type ParsedIntent,
  type StructuredRequirement,
} from '@forgex/requirement-engine';
import type { TaskPlan, StepVerification } from '@forgex/core';

export interface RequirementReport {
  requirement: StructuredRequirement;
  analysis: ReturnType<RequirementAnalyzer['analyze']>;
  criteriaValidation: ReturnType<AcceptanceCriteriaValidator['validate']>;
}

/** Builds an explicit draft acceptance checklist from an already generated task plan. */
export function createRequirementReport(prompt: string, plan: TaskPlan): RequirementReport {
  const requirement = makeStructuredRequirement({
    original: prompt,
    parsed: {
      category: inferCategory(prompt),
      summary: prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt,
      functionalReqs: [prompt],
      nonFunctionalReqs: [],
    },
    acceptanceCriteria: plan.steps.map((step) => makeCriterion({
      description: describeCriterion(step.description, step.verification),
      testable: step.verification.type !== 'custom' && step.verification.type !== 'auto',
      verificationMethod: describeVerification(step.verification),
      source: 'llm-generated',
      approved: false,
    })),
  });
  const analyzer = new RequirementAnalyzer();
  const validator = new AcceptanceCriteriaValidator();
  return {
    requirement,
    analysis: analyzer.analyze(requirement),
    criteriaValidation: validator.validate(requirement.acceptanceCriteria),
  };
}

function inferCategory(prompt: string): ParsedIntent['category'] {
  if (/\b(fix|bug|repair)\b|修复|故障/i.test(prompt)) return 'bug-fix';
  if (/\b(refactor|restructure)\b|重构/i.test(prompt)) return 'refactor';
  if (/\b(deploy|docker|kubernetes)\b|部署/i.test(prompt)) return 'devops';
  if (/\b(document|readme)\b|文档/i.test(prompt)) return 'documentation';
  return 'feature';
}

function describeCriterion(description: string, verification: StepVerification): string {
  if (verification.type === 'file_exists' && verification.target) return `验收目标文件存在：${verification.target}`;
  if (verification.type === 'file_changed' && verification.target) return `验收目标文件发生预期变更：${verification.target}`;
  if (verification.type === 'file_content' && verification.target) return `验收目标文件包含预期内容：${verification.target}`;
  if (verification.type === 'command_exit_zero') return `验收验证命令成功：${description}`;
  if (verification.type === 'git_no_conflict') return '验收 Git 工作区不存在冲突标记';
  return `验收步骤完成：${description}`;
}

function describeVerification(verification: StepVerification): string {
  const details = [verification.target, verification.expectedContent].filter(Boolean).join('；');
  return details ? `${verification.type}：${details}` : verification.type;
}
