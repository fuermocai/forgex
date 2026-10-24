/**
 * MetricsCollector：单轮运行的性能指标。
 *
 * 指标只用于观测，不参与决策；任何字段异常都不能影响 Agent 执行。
 * 说明：模型内部重试次数无法从 Provider 外部精确获取，因此 retries
 * 仅统计 Agent 层感知到的失败重试；Provider 的自动重试由其自身日志记录。
 */
import type { RunMetrics, ToolResult } from '@forgex/shared';

export interface ModelCallMetrics {
  durationMs: number;
  firstTokenMs: number | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class MetricsCollector {
  private readonly metrics: RunMetrics;

  constructor(sessionId: string) {
    this.metrics = {
      sessionId,
      modelCalls: 0,
      retries: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      firstTokenMs: null,
      modelMs: 0,
      toolMs: 0,
      totalMs: 0,
      toolCalls: 0,
      toolFailures: 0,
      approvals: 0,
      iterations: 0,
    };
  }

  recordModelCall(input: ModelCallMetrics): void {
    this.metrics.modelCalls += 1;
    this.metrics.modelMs += input.durationMs;
    this.metrics.promptTokens += input.promptTokens;
    this.metrics.completionTokens += input.completionTokens;
    this.metrics.totalTokens += input.totalTokens;
    if (input.firstTokenMs !== null) {
      // 取本会话首个 token 延迟（只记录第一次成功收到增量）
      this.metrics.firstTokenMs ??= input.firstTokenMs;
    }
  }

  recordRetry(): void {
    this.metrics.retries += 1;
  }

  recordTool(result: ToolResult): void {
    this.metrics.toolCalls += 1;
    this.metrics.toolMs += result.durationMs;
    if (!result.ok) this.metrics.toolFailures += 1;
  }

  recordApproval(): void {
    this.metrics.approvals += 1;
  }

  /** 结束本轮，补齐总耗时与迭代次数，返回快照 */
  finish(startedAt: number, iterations: number): RunMetrics {
    this.metrics.iterations = iterations;
    this.metrics.totalMs = Math.max(0, Date.now() - startedAt);
    return { ...this.metrics };
  }
}
