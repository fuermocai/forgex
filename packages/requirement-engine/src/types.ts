/**
 * Requirement Engine 类型定义（v0.5.0 Phase 1）。
 *
 * 核心约束（类型级）：
 *   - AcceptanceCriterion.approved 必须显式设置为 true 才视为用户批准；
 *   - CriteriaValidator 在下游消费前强制检查 approved === true；
 *   - RequirementTrace 预留 workflowRunId 供 Phase 2 AutonomousRunner 关联。
 */
import { randomUUID } from 'node:crypto';

/** 需求分类 */
export type RequirementCategory =
  | 'feature'
  | 'bug-fix'
  | 'refactor'
  | 'devops'
  | 'documentation'
  | 'unknown';

/** 意图解析 */
export interface ParsedIntent {
  /** 分类 */
  category: RequirementCategory;
  /** 简短摘要（一句话） */
  summary: string;
  /** 功能性需求点列表 */
  functionalReqs: string[];
  /** 非功能性需求点列表（性能、安全、兼容性等） */
  nonFunctionalReqs: string[];
}

/** 歧义项 —— 必须请求用户确认 */
export interface AmbiguityItem {
  /** 模糊的字段/部分标识 */
  field: string;
  /** 为什么模糊（自然语言描述） */
  description: string;
  /** 可行选项列表（供用户选择） */
  suggestedOptions: string[];
  /** 用户确认后的选择 */
  resolved?: string;
  /** 确认时间 */
  resolvedAt?: string;
}

/** 兼容性风险项 */
export interface RiskItem {
  /** 风险类型 */
  type: 'breaking-change' | 'data-migration' | 'dependency-upgrade' | 'security' | 'performance';
  /** 风险描述 */
  description: string;
  /** 严重程度 */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** 缓解建议 */
  mitigation?: string;
}

/**
 * 验收标准（类型级强制批准）。
 *
 * @important approved 默认 false。
 * 所有 CriteriaValidator 实现都必须在下游消费前检查 approved === true。
 * 模型自行生成的标准必须明确标记为 draft，不得自动提升为 approved。
 */
export interface AcceptanceCriterion {
  /** 唯一 ID */
  id: string;
  /** 标准描述（"当执行 X 时，应产生 Y"） */
  description: string;
  /** 是否可通过自动化测试验证 */
  testable: boolean;
  /** 验证方法描述（具体怎么做） */
  verificationMethod: string;
  /** 是否经用户批准 —— 默认 false */
  approved: boolean;
  /** 批准时间 */
  approvedAt?: string;
  /** 标准来源（user=用户直接给，llm-generated=模型生成后待批准） */
  source: 'user' | 'llm-generated';
}

/** 结构化需求 */
export interface StructuredRequirement {
  /** 需求唯一 ID */
  id: string;
  /** 用户原始输入 */
  original: string;
  /** 解析出的意图 */
  parsed: ParsedIntent;
  /** 歧义列表 —— 必须全部 resolved 才能进入执行 */
  ambiguities: AmbiguityItem[];
  /** 涉及的代码模块（路径或模块名） */
  affectedModules: string[];
  /** 兼容性风险 */
  compatibilityRisks: RiskItem[];
  /** 验收标准列表 —— 必须全部 approved 才能视为用户批准的需求 */
  acceptanceCriteria: AcceptanceCriterion[];
  /** 追溯链 ID */
  traceId: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** 追溯链（需求→代码→测试 关联） */
export interface RequirementTrace {
  /** 追溯链 ID */
  traceId: string;
  /** 关联的需求 ID */
  requirementId: string;
  /** Phase 2 关联的工作流运行 ID（预留字段） */
  workflowRunId?: string;
  /** 关联的 WorkflowNode ID 列表 */
  workflowNodeIds: string[];
  /** 代码变更（file paths 或 commit hashes） */
  codeChanges: string[];
  /** 相关测试文件 */
  tests: string[];
  /** 执行状态 */
  status:
    | 'pending'
    | 'ambiguities-resolved'
    | 'criteria-approved'
    | 'in-progress'
    | 'implemented'
    | 'verified'
    | 'delivered'
    | 'abandoned';
  /** 最终交付摘要 */
  deliverySummary?: string;
  /** 创建时间 */
  createdAt: string;
  /** 更新时间 */
  updatedAt: string;
}

/** 新需求 ID */
export function newRequirementId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 新追溯链 ID */
export function newTraceId(): string {
  return `trace_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 新验收标准 ID */
export function newCriterionId(): string {
  return `ac_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 当前 UTC 时间 ISO */
export function requirementNowIso(): string {
  return new Date().toISOString();
}

/** 构造 StructuredRequirement（默认值填充） */
export function makeStructuredRequirement(params: {
  original: string;
  parsed: ParsedIntent;
  ambiguities?: AmbiguityItem[];
  affectedModules?: string[];
  compatibilityRisks?: RiskItem[];
  acceptanceCriteria?: AcceptanceCriterion[];
}): StructuredRequirement {
  const now = requirementNowIso();
  const traceId = newTraceId();
  return {
    id: newRequirementId(),
    original: params.original,
    parsed: params.parsed,
    ambiguities: params.ambiguities ?? [],
    affectedModules: params.affectedModules ?? [],
    compatibilityRisks: params.compatibilityRisks ?? [],
    acceptanceCriteria: params.acceptanceCriteria ?? [],
    traceId,
    createdAt: now,
    updatedAt: now,
  };
}

/** 构造 AcceptanceCriterion（approved 默认 false） */
export function makeCriterion(params: {
  description: string;
  testable: boolean;
  verificationMethod: string;
  source?: 'user' | 'llm-generated';
  /** 默认 false，显式传入 true 表示用户已批准 */
  approved?: boolean;
}): AcceptanceCriterion {
  return {
    id: newCriterionId(),
    description: params.description,
    testable: params.testable,
    verificationMethod: params.verificationMethod,
    approved: params.approved ?? false,
    source: params.source ?? 'user',
  };
}

/** 判断需求是否已准备好进入执行（无歧义 + 所有验收标准已批准） */
export function isRequirementReady(req: StructuredRequirement): {
  ready: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const unresolvedAmbiguities = req.ambiguities.filter((a) => !a.resolved);
  if (unresolvedAmbiguities.length > 0) {
    reasons.push(`存在 ${unresolvedAmbiguities.length} 个未解决的歧义项`);
  }
  const unapprovedCriteria = req.acceptanceCriteria.filter((c) => !c.approved);
  if (unapprovedCriteria.length > 0) {
    reasons.push(`存在 ${unapprovedCriteria.length} 个未批准的验收标准`);
  }
  return { ready: reasons.length === 0, reasons };
}
