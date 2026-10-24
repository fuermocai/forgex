/**
 * ResultAggregator 单元测试（v0.3.0 Phase 2）。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateResults,
  filterByRole,
  filterFailed,
  filterSucceeded,
} from '../src/subagent/result-aggregator.js';
import type { SubAgentResult, SubAgentRole } from '../src/subagent/types.js';

function buildResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  const role: SubAgentRole = overrides.role ?? 'explorer';
  return {
    subagent_id: overrides.subagent_id ?? 'sub_test',
    role,
    success: overrides.success ?? true,
    status: overrides.status ?? 'completed',
    summary: overrides.summary ?? '完成',
    evidence_refs: overrides.evidence_refs ?? [],
    usage: overrides.usage ?? { tokens: 100, toolCalls: 1, durationMs: 10, iterations: 1 },
    ...(overrides.failureReason ? { failureReason: overrides.failureReason } : {}),
    ...(overrides.findings ? { findings: overrides.findings } : {}),
  };
}

describe('aggregateResults 基础统计', () => {
  it('空数组 → 全零报告', () => {
    const report = aggregateResults([]);
    expect(report.total).toBe(0);
    expect(report.succeeded).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.cancelled).toBe(0);
    expect(report.budgetExceeded).toBe(0);
    expect(report.byRole).toHaveLength(0);
    expect(report.evidence_refs).toHaveLength(0);
  });

  it('全部成功 → succeeded=total', () => {
    const results = [
      buildResult({ subagent_id: 'sub_1' }),
      buildResult({ subagent_id: 'sub_2' }),
      buildResult({ subagent_id: 'sub_3' }),
    ];
    const report = aggregateResults(results);
    expect(report.total).toBe(3);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(0);
  });

  it('混合状态正确统计', () => {
    const results = [
      buildResult({ subagent_id: 'sub_ok', success: true, status: 'completed' }),
      buildResult({ subagent_id: 'sub_fail', success: false, status: 'failed', failureReason: '失败' }),
      buildResult({ subagent_id: 'sub_cancel', success: false, status: 'cancelled' }),
      buildResult({ subagent_id: 'sub_budget', success: false, status: 'budget_exceeded' }),
    ];
    const report = aggregateResults(results);
    expect(report.total).toBe(4);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.cancelled).toBe(1);
    expect(report.budgetExceeded).toBe(1);
  });
});

describe('aggregateResults 按角色分组', () => {
  it('多角色正确分组', () => {
    const results = [
      buildResult({ subagent_id: 'sub_e1', role: 'explorer' }),
      buildResult({ subagent_id: 'sub_e2', role: 'explorer' }),
      buildResult({ subagent_id: 'sub_d1', role: 'debugger' }),
      buildResult({ subagent_id: 'sub_w1', role: 'worker' }),
    ];
    const report = aggregateResults(results);
    expect(report.byRole).toHaveLength(3);
    const explorerGroup = report.byRole.find((g) => g.role === 'explorer');
    expect(explorerGroup?.count).toBe(2);
    const debuggerGroup = report.byRole.find((g) => g.role === 'debugger');
    expect(debuggerGroup?.count).toBe(1);
  });

  it('每组内统计成功/失败', () => {
    const results = [
      buildResult({ subagent_id: 'sub_e1', role: 'explorer', success: true }),
      buildResult({ subagent_id: 'sub_e2', role: 'explorer', success: false, status: 'failed' }),
    ];
    const report = aggregateResults(results);
    const group = report.byRole.find((g) => g.role === 'explorer');
    expect(group?.succeeded).toBe(1);
    expect(group?.failed).toBe(1);
  });
});

describe('aggregateResults 证据去重', () => {
  it('同 kind+source 的证据被去重', () => {
    const results = [
      buildResult({
        subagent_id: 'sub_1',
        evidence_refs: [
          { kind: 'code_snippet', source: 'a.ts' },
          { kind: 'code_snippet', source: 'b.ts' },
        ],
      }),
      buildResult({
        subagent_id: 'sub_2',
        evidence_refs: [
          { kind: 'code_snippet', source: 'a.ts' }, // 重复
          { kind: 'code_snippet', source: 'c.ts' },
        ],
      }),
    ];
    const report = aggregateResults(results);
    expect(report.evidence_refs).toHaveLength(3);
    const sources = report.evidence_refs.map((r) => r.source);
    expect(sources).toContain('a.ts');
    expect(sources).toContain('b.ts');
    expect(sources).toContain('c.ts');
  });

  it('kind 不同即使 source 相同也保留', () => {
    const results = [
      buildResult({
        subagent_id: 'sub_1',
        evidence_refs: [
          { kind: 'code_snippet', source: 'a.ts' },
          { kind: 'log_line', source: 'a.ts' },
        ],
      }),
    ];
    const report = aggregateResults(results);
    expect(report.evidence_refs).toHaveLength(2);
  });
});

describe('aggregateResults usage 汇总', () => {
  it('token/toolCalls/durationMs/iterations 全部累加', () => {
    const results = [
      buildResult({ subagent_id: 'sub_1', usage: { tokens: 100, toolCalls: 2, durationMs: 50, iterations: 1 } }),
      buildResult({ subagent_id: 'sub_2', usage: { tokens: 200, toolCalls: 3, durationMs: 80, iterations: 2 } }),
    ];
    const report = aggregateResults(results);
    expect(report.totalUsage.tokens).toBe(300);
    expect(report.totalUsage.toolCalls).toBe(5);
    expect(report.totalUsage.durationMs).toBe(130);
    expect(report.totalUsage.iterations).toBe(3);
  });
});

describe('aggregateResults 摘要', () => {
  it('摘要包含整体统计', () => {
    const results = [
      buildResult({ subagent_id: 'sub_1' }),
      buildResult({ subagent_id: 'sub_2' }),
    ];
    const report = aggregateResults(results);
    expect(report.summary).toContain('2/2');
  });

  it('摘要包含角色分组标题', () => {
    const results = [
      buildResult({ subagent_id: 'sub_e', role: 'explorer' }),
      buildResult({ subagent_id: 'sub_d', role: 'debugger' }),
    ];
    const report = aggregateResults(results);
    expect(report.summary).toContain('[explorer]');
    expect(report.summary).toContain('[debugger]');
  });

  it('摘要包含失败警告', () => {
    const results = [
      buildResult({ subagent_id: 'sub_ok' }),
      buildResult({ subagent_id: 'sub_fail', success: false, status: 'failed', failureReason: '预期失败' }),
    ];
    const report = aggregateResults(results);
    expect(report.summary).toContain('警告');
    expect(report.summary).toContain('预期失败');
  });
});

describe('aggregateResults failedSubagentIds', () => {
  it('失败的子代理 ID 被收集', () => {
    const results = [
      buildResult({ subagent_id: 'sub_ok', success: true }),
      buildResult({ subagent_id: 'sub_f1', success: false, status: 'failed' }),
      buildResult({ subagent_id: 'sub_f2', success: false, status: 'failed' }),
    ];
    const report = aggregateResults(results);
    expect(report.failedSubagentIds).toHaveLength(2);
    expect(report.failedSubagentIds).toContain('sub_f1');
    expect(report.failedSubagentIds).toContain('sub_f2');
    expect(report.failedSubagentIds).not.toContain('sub_ok');
  });
});

describe('辅助过滤函数', () => {
  it('filterSucceeded 返回成功的', () => {
    const results = [
      buildResult({ subagent_id: 'sub_ok', success: true }),
      buildResult({ subagent_id: 'sub_f', success: false, status: 'failed' }),
    ];
    const ok = filterSucceeded(results);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.subagent_id).toBe('sub_ok');
  });

  it('filterFailed 返回失败的', () => {
    const results = [
      buildResult({ subagent_id: 'sub_ok', success: true }),
      buildResult({ subagent_id: 'sub_f', success: false, status: 'failed' }),
    ];
    const fail = filterFailed(results);
    expect(fail).toHaveLength(1);
    expect(fail[0]!.subagent_id).toBe('sub_f');
  });

  it('filterByRole 按角色过滤', () => {
    const results = [
      buildResult({ subagent_id: 'sub_e', role: 'explorer' }),
      buildResult({ subagent_id: 'sub_d', role: 'debugger' }),
      buildResult({ subagent_id: 'sub_w', role: 'worker' }),
    ];
    expect(filterByRole(results, 'explorer')).toHaveLength(1);
    expect(filterByRole(results, 'debugger')).toHaveLength(1);
    expect(filterByRole(results, 'reviewer')).toHaveLength(0);
  });
});
