/**
 * Observability 类型定义（v0.4.0 Phase 5）。
 */

/** Span 类型 */
export type SpanType =
  | 'task'
  | 'agent'
  | 'tool_call'
  | 'workflow_step'
  | 'approval'
  | 'verification';

/** Span 状态 */
export type SpanStatus = 'started' | 'completed' | 'failed' | 'cancelled';

/** Trace 上下文 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId?: string;
  agentId?: string;
  parentAgentId?: string;
}

/** Span 记录 */
export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  type: SpanType;
  status: SpanStatus;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  /** 属性键值对（敏感数据会被脱敏） */
  attributes: Record<string, unknown>;
  /** 错误信息 */
  error?: string;
  /** 关联 ID */
  sessionId?: string;
  agentId?: string;
  parentAgentId?: string;
  toolCallId?: string;
  workflowStepId?: string;
}

/** 指标记录 */
export interface MetricRecord {
  name: string;
  value: number;
  timestamp: string;
  tags: Record<string, string>;
}

/** 审计事件 */
export interface AuditEvent {
  id: string;
  timestamp: string;
  /** 操作类型 */
  action: string;
  /** 操作主体（Agent ID 或用户名） */
  actor: string;
  /** 风险等级 */
  riskLevel: string;
  /** 操作摘要（已脱敏） */
  summary: string;
  /** 目标 */
  target?: string;
  /** 结果 */
  result: 'success' | 'failure' | 'denied';
  /** 关联 trace */
  traceId?: string;
  /** 关联 session */
  sessionId?: string;
}

/** 执行报告 */
export interface ExecutionReport {
  traceId: string;
  sessionId?: string;
  agentId?: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  totalSteps: number;
  succeededSteps: number;
  failedSteps: number;
  totalTokens: number;
  toolCalls: number;
  approvals: number;
  errors: string[];
  verificationResults: Array<{ step: string; passed: boolean; detail?: string }>;
}
