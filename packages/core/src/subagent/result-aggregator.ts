/**
 * ResultAggregator：合并多个 Sub-Agent 的结果（v0.3.0 Phase 2）。
 *
 * 职责：
 *   1. 把 DelegationManager 返回的 SubAgentResult[] 合并成单一汇总；
 *   2. 按角色分组，便于上层看出"explorer 发现了什么 / debugger 诊断了什么"；
 *   3. 去重 evidence_refs（同 kind+source 视为重复）；
 *   4. 汇总总资源消耗（token / 工具调用 / 耗时）；
 *   5. 产出面向 LLM 的"综合摘要"——把多个子代理结论融合成可读文本。
 *
 * 不做什么：
 *   - 不调用 LLM 做语义融合（确定性拼接，可测试可审计）；
 *   - 不修改任何原始 SubAgentResult（纯函数式合并）。
 */
import type { EvidenceRef } from '../planning/types.js';
import type { SubAgentResult, SubAgentRole } from './types.js';

/** 按角色分组的结果 */
export interface RoleGroup {
  role: SubAgentRole;
  count: number;
  succeeded: number;
  failed: number;
  results: SubAgentResult[];
}

/** 汇总后的总报告 */
export interface AggregatedReport {
  /** 总任务数 */
  total: number;
  /** 成功数 */
  succeeded: number;
  /** 失败数 */
  failed: number;
  /** 被取消数 */
  cancelled: number;
  /** 超预算数 */
  budgetExceeded: number;
  /** 按角色分组 */
  byRole: RoleGroup[];
  /** 综合摘要（面向 LLM / 用户） */
  summary: string;
  /** 去重后的全部证据引用 */
  evidence_refs: EvidenceRef[];
  /** 总资源消耗 */
  totalUsage: {
    tokens: number;
    toolCalls: number;
    durationMs: number;
    iterations: number;
  };
  /** 失败的子代理 ID 列表（便于上层定位） */
  failedSubagentIds: string[];
}

/**
 * 聚合多个 SubAgentResult 为单一报告。
 *
 * 输入可以是任何顺序——内部会按角色分组，按创建时间排序。
 */
export function aggregateResults(results: ReadonlyArray<SubAgentResult>): AggregatedReport {
  // 1. 按角色分组
  const byRoleMap = new Map<SubAgentRole, SubAgentResult[]>();
  for (const result of results) {
    const list = byRoleMap.get(result.role) ?? [];
    list.push(result);
    byRoleMap.set(result.role, list);
  }

  const byRole: RoleGroup[] = [];
  for (const [role, groupResults] of byRoleMap) {
    byRole.push({
      role,
      count: groupResults.length,
      succeeded: groupResults.filter((r) => r.success).length,
      failed: groupResults.filter((r) => !r.success).length,
      results: groupResults,
    });
  }

  // 2. 去重证据
  const allEvidence: EvidenceRef[] = [];
  for (const result of results) {
    allEvidence.push(...result.evidence_refs);
  }
  const deduped = dedupeEvidence(allEvidence);

  // 3. 汇总 usage
  const totalUsage = {
    tokens: results.reduce((sum, r) => sum + r.usage.tokens, 0),
    toolCalls: results.reduce((sum, r) => sum + r.usage.toolCalls, 0),
    durationMs: results.reduce((sum, r) => sum + r.usage.durationMs, 0),
    iterations: results.reduce((sum, r) => sum + r.usage.iterations, 0),
  };

  // 4. 构造综合摘要
  const summary = buildSummary(results, byRole);

  return {
    total: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => r.status === 'failed').length,
    cancelled: results.filter((r) => r.status === 'cancelled').length,
    budgetExceeded: results.filter((r) => r.status === 'budget_exceeded').length,
    byRole,
    summary,
    evidence_refs: deduped,
    totalUsage,
    failedSubagentIds: results.filter((r) => !r.success).map((r) => r.subagent_id),
  };
}

/* ------------------------------------------------------------------ */
/* 私有：摘要构造                                                       */
/* ------------------------------------------------------------------ */

function buildSummary(results: ReadonlyArray<SubAgentResult>, byRole: ReadonlyArray<RoleGroup>): string {
  const lines: string[] = [];

  // 整体状态
  const succeeded = results.filter((r) => r.success).length;
  const total = results.length;
  lines.push(`子代理执行汇总：${succeeded}/${total} 成功`);

  // 按角色分组
  for (const group of byRole) {
    lines.push(`\n[${group.role}] ${group.succeeded}/${group.count} 成功`);
    for (const result of group.results) {
      const status = result.success ? '✓' : '✗';
      const brief = result.summary.length > 80 ? `${result.summary.slice(0, 80)}...` : result.summary;
      lines.push(`  ${status} ${brief}`);
    }
  }

  // 失败警告
  const failed = results.filter((r) => !r.success);
  if (failed.length > 0) {
    lines.push(`\n警告：${failed.length} 个子代理失败`);
    for (const f of failed.slice(0, 3)) {
      lines.push(`  - ${f.subagent_id} (${f.role}): ${f.failureReason ?? '未知原因'}`);
    }
    if (failed.length > 3) {
      lines.push(`  ... 以及另外 ${failed.length - 3} 个`);
    }
  }

  return lines.join('\n');
}

/** 证据去重（kind+source+startLine 视为同一证据） */
function dedupeEvidence(refs: ReadonlyArray<EvidenceRef>): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.source}:${ref.startLine ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 辅助：按状态过滤                                                     */
/* ------------------------------------------------------------------ */

/** 过滤出成功的结果 */
export function filterSucceeded(results: ReadonlyArray<SubAgentResult>): SubAgentResult[] {
  return results.filter((r) => r.success);
}

/** 过滤出失败的结果 */
export function filterFailed(results: ReadonlyArray<SubAgentResult>): SubAgentResult[] {
  return results.filter((r) => !r.success);
}

/** 按角色过滤 */
export function filterByRole(results: ReadonlyArray<SubAgentResult>, role: SubAgentRole): SubAgentResult[] {
  return results.filter((r) => r.role === role);
}
