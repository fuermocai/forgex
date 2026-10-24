/**
 * TraceManager：Trace 生命周期管理（v0.4.0 Phase 5）。
 *
 * 职责：
 *   - 创建/管理 trace；
 *   - 父子代理关联（parentAgentId）；
 *   - Span 嵌套。
 */
import { randomUUID } from 'node:crypto';
import type { SpanRecord, SpanType, SpanStatus, TraceContext } from '../types.js';
import { SpanRecorder } from './span-recorder.js';

export class TraceManager {
  private readonly spans = new Map<string, SpanRecord>();
  private readonly spanRecorder: SpanRecorder;

  constructor(spanRecorder: SpanRecorder) {
    this.spanRecorder = spanRecorder;
  }

  /** 创建新 trace */
  startTrace(context: Partial<TraceContext> = {}): TraceContext {
    return {
      traceId: context.traceId ?? randomUUID(),
      spanId: context.spanId ?? randomUUID(),
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      agentId: context.agentId,
      parentAgentId: context.parentAgentId,
    };
  }

  /** 开始一个 span */
  startSpan(
    context: TraceContext,
    name: string,
    type: SpanType,
    attributes: Record<string, unknown> = {},
  ): SpanRecord {
    const span: SpanRecord = {
      traceId: context.traceId,
      spanId: randomUUID(),
      parentSpanId: context.spanId,
      name,
      type,
      status: 'started',
      startTime: new Date().toISOString(),
      attributes,
      sessionId: context.sessionId,
      agentId: context.agentId,
      parentAgentId: context.parentAgentId,
    };
    this.spans.set(span.spanId, span);
    this.spanRecorder.record(span);
    return span;
  }

  /** 结束 span */
  endSpan(spanId: string, status: SpanStatus = 'completed', error?: string): void {
    const span = this.spans.get(spanId);
    if (!span) return;

    span.status = status;
    span.endTime = new Date().toISOString();
    span.durationMs = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
    if (error) span.error = error;

    this.spans.set(spanId, span);
    this.spanRecorder.record(span);
  }

  /** 获取 trace 下的所有 span（含状态变更历史） */
  getTraceSpans(traceId: string): SpanRecord[] {
    return this.spanRecorder.getByTrace(traceId);
  }

  /** 获取 span 的子 span（用于父子代理关联） */
  getChildSpans(parentSpanId: string): SpanRecord[] {
    return [...this.spans.values()].filter((s) => s.parentSpanId === parentSpanId);
  }

  /** 导出 trace 为 JSON */
  exportTrace(traceId: string): string {
    const spans = this.getTraceSpans(traceId);
    return JSON.stringify({ traceId, spans }, null, 2);
  }

  /** 清空所有 span */
  clear(): void {
    this.spans.clear();
  }
}
