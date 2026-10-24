/**
 * ResourceLimiter：子代理的实时资源预算执行器（v0.3.0 Phase 2）。
 *
 * 职责：
 *   1. 跟踪 token / 工具调用 / 迭代次数 / 已耗时 四类消耗；
 *   2. 每次消耗前调用 checkXxx()，超预算立即抛 SUBAGENT_BUDGET_EXCEEDED；
 *   3. 由 SubAgentRunner 注入，在 AgentLoop 的关键节点回调；
 *   4. 提供 snapshot() 给 ResultAggregator 收集最终用量。
 *
 * 关键设计：
 *   - 预算在进入子代理前由 resolveBudget 解析并 clip 到硬上限；
 *   - 本类不做"提前预警"——超预算直接终止（避免半执行状态污染结果）；
 *   - 时间消耗基于单调时钟（monotonicNow），避免系统时间调整干扰；
 *   - 所有方法都是同步的，调用方不需要 await。
 */
import { ForgeError, monotonicNow } from '@forgex/shared';
import type { SubAgentBudget } from './types.js';

export interface BudgetSnapshot {
  /** 已消耗 token（prompt + completion 估算） */
  tokensUsed: number;
  /** 已发起工具调用次数 */
  toolCallsUsed: number;
  /** AgentLoop 迭代次数 */
  iterationsUsed: number;
  /** 已耗时毫秒 */
  durationMs: number;
  /** 是否已超预算 */
  exceeded: boolean;
  /** 超预算的原因（仅 exceeded=true 时有值） */
  exceededReason?: string;
}

export class ResourceLimiter {
  private readonly budget: Required<SubAgentBudget>;
  private readonly startTimeMs: number;

  private tokensUsed = 0;
  private toolCallsUsed = 0;
  private iterationsUsed = 0;
  private exceeded = false;
  private exceededReason: string | undefined;

  constructor(budget: Required<SubAgentBudget>) {
    this.budget = budget;
    this.startTimeMs = monotonicNow();
  }

  /** 记录一次模型调用的 token 消耗（prompt + completion 都算） */
  recordTokens(count: number): void {
    if (count < 0) return; // 防御：忽略负数
    this.tokensUsed += count;
    this.checkTokenBudget();
  }

  /** 记录一次工具调用 */
  recordToolCall(): void {
    this.toolCallsUsed += 1;
    this.checkToolCallBudget();
  }

  /** 记录一次 AgentLoop 迭代 */
  recordIteration(): void {
    this.iterationsUsed += 1;
    this.checkIterationBudget();
  }

  /** 检查时间预算（在每次消耗后都应调用） */
  checkTimeBudget(): void {
    if (this.exceeded) return; // 已超预算，无需重复抛
    const elapsed = monotonicNow() - this.startTimeMs;
    if (elapsed > this.budget.maxDurationMs) {
      this.markExceeded(`执行时间超过预算 ${this.budget.maxDurationMs}ms（实际 ${Math.round(elapsed)}ms）`);
    }
  }

  /** 是否已超预算 */
  isExceeded(): boolean {
    return this.exceeded;
  }

  /** 超预算原因（未超预算时返回 undefined） */
  getExceededReason(): string | undefined {
    return this.exceededReason;
  }

  /** 当前用量快照（结果聚合时用） */
  snapshot(): BudgetSnapshot {
    return {
      tokensUsed: this.tokensUsed,
      toolCallsUsed: this.toolCallsUsed,
      iterationsUsed: this.iterationsUsed,
      durationMs: monotonicNow() - this.startTimeMs,
      exceeded: this.exceeded,
      ...(this.exceededReason ? { exceededReason: this.exceededReason } : {}),
    };
  }

  /** 强制标记超预算（外部发现异常时使用） */
  forceExceeded(reason: string): void {
    if (this.exceeded) return;
    this.markExceeded(reason);
  }

  /** 断言未超预算，否则抛 SUBAGENT_BUDGET_EXCEEDED */
  assertWithinBudget(): void {
    this.checkTimeBudget(); // 每次断言都顺带检查时间
    if (this.exceeded) {
      throw new ForgeError('SUBAGENT_BUDGET_EXCEEDED', this.exceededReason ?? '子代理超出资源预算', {
        details: {
          snapshot: this.snapshot(),
          budget: this.budget,
        },
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 私有：各类预算检查                                                  */
  /* ---------------------------------------------------------------- */

  private checkTokenBudget(): void {
    if (this.exceeded) return;
    if (this.tokensUsed > this.budget.maxTokens) {
      this.markExceeded(`token 消耗超过预算 ${this.budget.maxTokens}（实际 ${this.tokensUsed}）`);
    }
  }

  private checkToolCallBudget(): void {
    if (this.exceeded) return;
    if (this.toolCallsUsed > this.budget.maxToolCalls) {
      this.markExceeded(`工具调用次数超过预算 ${this.budget.maxToolCalls}（实际 ${this.toolCallsUsed}）`);
    }
  }

  private checkIterationBudget(): void {
    if (this.exceeded) return;
    if (this.iterationsUsed > this.budget.maxIterations) {
      this.markExceeded(`迭代次数超过预算 ${this.budget.maxIterations}（实际 ${this.iterationsUsed}）`);
    }
  }

  private markExceeded(reason: string): void {
    this.exceeded = true;
    this.exceededReason = reason;
  }
}
