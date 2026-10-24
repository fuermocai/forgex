/**
 * Observability 测试（v0.4.0 Phase 5）。
 *
 * 重点验证：
 *   1. Trace 父子代理关联；
 *   2. Span 脱敏；
 *   3. Metrics P50/P95；
 *   4. 审计事件存储；
 *   5. 执行报告生成。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SpanRecorder } from '../src/tracing/span-recorder.js';
import { TraceManager } from '../src/tracing/trace-manager.js';
import { MetricsCollector } from '../src/metrics/metrics-collector.js';
import { AuditEventStore } from '../src/audit/audit-event-store.js';
import { ExecutionReporter } from '../src/reports/execution-reporter.js';

describe('TraceManager', () => {
  let recorder: SpanRecorder;
  let tm: TraceManager;

  beforeEach(() => {
    recorder = new SpanRecorder();
    tm = new TraceManager(recorder);
  });

  it('创建 trace 并记录 span', () => {
    const ctx = tm.startTrace({ sessionId: 's1', agentId: 'a1' });
    const span = tm.startSpan(ctx, 'task-1', 'task');
    tm.endSpan(span.spanId, 'completed');

    const spans = tm.getTraceSpans(ctx.traceId);
    expect(spans).toHaveLength(2); // started + completed 两个记录
    expect(spans[0]?.traceId).toBe(ctx.traceId);
  });

  it('父子代理关联（parentAgentId）', () => {
    const parentCtx = tm.startTrace({ agentId: 'parent-agent' });
    const parentSpan = tm.startSpan(parentCtx, 'parent-task', 'agent');

    // 子代理继承 traceId，设置 parentAgentId
    const childCtx = tm.startTrace({
      traceId: parentCtx.traceId,
      spanId: parentSpan.spanId,
      agentId: 'child-agent',
      parentAgentId: 'parent-agent',
    });
    const childSpan = tm.startSpan(childCtx, 'child-task', 'agent');

    expect(childSpan.parentAgentId).toBe('parent-agent');
    expect(childSpan.parentSpanId).toBe(parentSpan.spanId);

    const children = tm.getChildSpans(parentSpan.spanId);
    expect(children).toHaveLength(1);
    expect(children[0]?.spanId).toBe(childSpan.spanId);
  });

  it('endSpan 设置耗时', () => {
    const ctx = tm.startTrace();
    const span = tm.startSpan(ctx, 't', 'task');
    tm.endSpan(span.spanId, 'completed');
    const spans = tm.getTraceSpans(ctx.traceId);
    const ended = spans.find((s) => s.spanId === span.spanId && s.status === 'completed');
    expect(ended?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('SpanRecorder 脱敏', () => {
  it('脱敏敏感字符串', () => {
    const recorder = new SpanRecorder();
    recorder.record({
      traceId: 't1',
      spanId: 's1',
      name: 'test',
      type: 'tool_call',
      status: 'completed',
      startTime: new Date().toISOString(),
      attributes: {
        password: 'secret123',
        token: 'ghp_abc123',
        normal: 'hello',
        api_key: 'sk-12345',
      },
    });

    const records = recorder.getAll();
    const attrs = records[0]!.attributes;
    // 敏感字段应被脱敏
    expect(attrs.password).not.toBe('secret123');
    expect(attrs.token).not.toBe('ghp_abc123');
    expect(attrs.api_key).not.toBe('sk-12345');
    // 普通字段保留
    expect(attrs.normal).toBe('hello');
  });
});

describe('MetricsCollector', () => {
  it('P50/P95 计算正确', () => {
    const mc = new MetricsCollector();
    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      mc.record('latency', v);
    }
    expect(mc.p50('latency')).toBe(50);
    expect(mc.p95('latency')).toBe(100);
  });

  it('count/sum/average', () => {
    const mc = new MetricsCollector();
    mc.record('tokens', 100, { model: 'gpt' });
    mc.record('tokens', 200, { model: 'gpt' });
    mc.record('tokens', 300, { model: 'claude' });

    expect(mc.count('tokens')).toBe(3);
    expect(mc.sum('tokens')).toBe(600);
    expect(mc.average('tokens')).toBe(200);
    expect(mc.sum('tokens', { model: 'gpt' })).toBe(300);
  });

  it('空指标返回 0', () => {
    const mc = new MetricsCollector();
    expect(mc.p50('nonexistent')).toBe(0);
    expect(mc.count('nonexistent')).toBe(0);
  });
});

describe('AuditEventStore', () => {
  let db: DatabaseSync;
  let store: AuditEventStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    store = new AuditEventStore(db);
  });

  it('记录并查询审计事件', () => {
    store.record({
      action: 'edit_file',
      actor: 'agent-1',
      riskLevel: 'L1',
      summary: 'edit a.ts',
      result: 'success',
      traceId: 'trace-1',
    });

    const events = store.getByTrace('trace-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('edit_file');
    expect(events[0]?.actor).toBe('agent-1');
  });

  it('按 actor 查询', () => {
    store.record({ action: 'a', actor: 'agent-1', riskLevel: 'L0', summary: 's', result: 'success' });
    store.record({ action: 'b', actor: 'agent-2', riskLevel: 'L0', summary: 's', result: 'success' });

    const events = store.getByActor('agent-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toBe('agent-1');
  });

  it('getRecent 限制数量', () => {
    for (let i = 0; i < 5; i++) {
      store.record({ action: `a${i}`, actor: 'x', riskLevel: 'L0', summary: 's', result: 'success' });
    }
    const recent = store.getRecent(2);
    expect(recent).toHaveLength(2);
  });
});

describe('ExecutionReporter', () => {
  it('生成执行报告', () => {
    const recorder = new SpanRecorder();
    const tm = new TraceManager(recorder);
    const mc = new MetricsCollector();
    const db = new DatabaseSync(':memory:');
    const audit = new AuditEventStore(db);
    const reporter = new ExecutionReporter(tm, mc, audit);

    const ctx = tm.startTrace({ sessionId: 's1', agentId: 'a1' });
    const span = tm.startSpan(ctx, 'step-1', 'workflow_step', { verification: true, verificationPassed: true });
    tm.endSpan(span.spanId, 'completed');

    mc.record('tokens_used', 1500, { traceId: ctx.traceId });

    const report = reporter.generate(ctx.traceId);
    expect(report.traceId).toBe(ctx.traceId);
    expect(report.agentId).toBe('a1');
    expect(report.totalTokens).toBe(1500);
    expect(report.succeededSteps).toBeGreaterThan(0);
    expect(report.verificationResults.length).toBeGreaterThan(0);
  });
});
