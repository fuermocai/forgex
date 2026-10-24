/**
 * ExecutionReporter：执行报告生成器（v0.4.0 Phase 5）。
 *
 * 汇总 trace、metrics、审计事件，生成结构化执行报告。
 */
import type { ExecutionReport, SpanRecord } from '../types.js';
import type { TraceManager } from '../tracing/trace-manager.js';
import type { MetricsCollector } from '../metrics/metrics-collector.js';
import type { AuditEventStore } from '../audit/audit-event-store.js';

export class ExecutionReporter {
  private readonly traceManager: TraceManager;
  private readonly metrics: MetricsCollector;
  private readonly auditStore: AuditEventStore;

  constructor(
    traceManager: TraceManager,
    metrics: MetricsCollector,
    auditStore: AuditEventStore,
  ) {
    this.traceManager = traceManager;
    this.metrics = metrics;
    this.auditStore = auditStore;
  }

  /** 生成指定 trace 的执行报告 */
  generate(traceId: string): ExecutionReport {
    const spans = this.traceManager.getTraceSpans(traceId);
    const auditEvents = this.auditStore.getByTrace(traceId);

    const completedSpans = spans.filter((s) => s.status === 'completed');
    const failedSpans = spans.filter((s) => s.status === 'failed');
    const toolCallSpans = spans.filter((s) => s.type === 'tool_call');
    const approvalSpans = spans.filter((s) => s.type === 'approval');

    const startTime = spans[0]?.startTime ?? new Date().toISOString();
    const endTime = spans[spans.length - 1]?.endTime ?? new Date().toISOString();
    const durationMs = new Date(endTime).getTime() - new Date(startTime).getTime();

    const totalTokens = this.metrics.sum('tokens_used', { traceId });
    const verificationResults = spans
      .filter((s) => s.type === 'workflow_step' && s.attributes.verification)
      .map((s) => ({
        step: s.name,
        passed: s.attributes.verificationPassed === true,
        detail: typeof s.attributes.verificationDetail === 'string' ? s.attributes.verificationDetail : undefined,
      }));

    const errors = failedSpans
      .map((s) => s.error)
      .filter((e): e is string => Boolean(e));

    return {
      traceId,
      sessionId: spans[0]?.sessionId,
      agentId: spans[0]?.agentId,
      startTime,
      endTime,
      durationMs,
      totalSteps: spans.length,
      succeededSteps: completedSpans.length,
      failedSteps: failedSpans.length,
      totalTokens,
      toolCalls: toolCallSpans.length,
      approvals: approvalSpans.length,
      errors,
      verificationResults,
    };
  }

  /** 导出报告为 JSON */
  exportJson(report: ExecutionReport): string {
    return JSON.stringify(report, null, 2);
  }

  /** 导出报告为文本摘要 */
  exportText(report: ExecutionReport): string {
    const lines: string[] = [];
    lines.push(`=== 执行报告 ===`);
    lines.push(`Trace ID: ${report.traceId}`);
    lines.push(`Agent: ${report.agentId ?? 'unknown'}`);
    lines.push(`耗时: ${report.durationMs}ms`);
    lines.push(`步骤: ${report.succeededSteps}/${report.totalSteps} 成功, ${report.failedSteps} 失败`);
    lines.push(`Token 消耗: ${report.totalTokens}`);
    lines.push(`工具调用: ${report.toolCalls}`);
    lines.push(`审批次数: ${report.approvals}`);

    if (report.errors.length > 0) {
      lines.push('');
      lines.push('错误:');
      for (const err of report.errors) {
        lines.push(`  - ${err}`);
      }
    }

    if (report.verificationResults.length > 0) {
      lines.push('');
      lines.push('验证结果:');
      for (const v of report.verificationResults) {
        lines.push(`  - [${v.passed ? 'PASS' : 'FAIL'}] ${v.step}${v.detail ? `: ${v.detail}` : ''}`);
      }
    }

    return lines.join('\n');
  }
}
