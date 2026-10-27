/**
 * ExecutionBudget：执行预算（v0.5.0 Phase 2）。
 *
 * 核心约束：
 *   - 不允许无限循环；
 *   - 不允许无限调用模型；
 *   - 每个任务有 Token、时间、工具调用上限；
 *   - 超过预算必须停止或申请追加授权（ApprovalManager L3）。
 *
 * 安全：AutonomousRunner 每步检查 remaining，耗尽立即停止。
 */
import { ForgeError } from '@forgex/shared';

export interface BudgetLimits {
  /** 最大总 Token 消耗 */
  maxTokens: number;
  /** 最大执行时间（毫秒） */
  maxTimeMs: number;
  /** 最大工具调用次数 */
  maxToolCalls: number;
  /** 最大模型调用次数（防止无限循环调 LLM） */
  maxModelCalls: number;
  /** 最大步骤数（防止任务无限循环） */
  maxSteps: number;
}

export interface BudgetUsage {
  tokens: number;
  timeMs: number;
  toolCalls: number;
  modelCalls: number;
  steps: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxTokens: 50_000,
  maxTimeMs: 30 * 60 * 1000,     // 30 分钟
  maxToolCalls: 500,
  maxModelCalls: 50,
  maxSteps: 100,
};

export const LIGHT_BUDGET_LIMITS: BudgetLimits = {
  maxTokens: 5_000,
  maxTimeMs: 5 * 60 * 1000,      // 5 分钟
  maxToolCalls: 50,
  maxModelCalls: 5,
  maxSteps: 20,
};

export const HEAVY_BUDGET_LIMITS: BudgetLimits = {
  maxTokens: 200_000,
  maxTimeMs: 2 * 60 * 60 * 1000, // 2 小时
  maxToolCalls: 2000,
  maxModelCalls: 200,
  maxSteps: 500,
};

export class BudgetTracker {
  private readonly limits: BudgetLimits;
  private readonly usage: BudgetUsage;
  private readonly startTime: number;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value <= 0 || (name !== 'maxTokens' && name !== 'maxTimeMs' && !Number.isInteger(value))) {
        throw new ForgeError('CONFIG_INVALID', `预算配置 ${name} 必须是正数${name === 'maxTokens' || name === 'maxTimeMs' ? '' : '整数'}`);
      }
    }
    this.startTime = Date.now();
    this.usage = { tokens: 0, timeMs: 0, toolCalls: 0, modelCalls: 0, steps: 0 };
  }

  /** 增加 Token 消耗 */
  addTokens(n: number): void {
    if (!Number.isFinite(n) || n < 0) {
      throw new ForgeError('INTERNAL', '模型 token 用量必须是有限的非负数');
    }
    this.usage.tokens += n;
    this.check();
  }

  /** 增加工具调用 */
  addToolCall(): void {
    this.usage.toolCalls += 1;
    this.check();
  }

  /** 增加模型调用 */
  addModelCall(): void {
    this.usage.modelCalls += 1;
    this.check();
  }

  /** 增加步骤（每步调用） */
  addStep(): void {
    this.usage.steps += 1;
    this.check();
  }

  /** 刷新时间（可选，预算检查时自动用 current time） */
  refreshTime(): void {
    this.usage.timeMs = Date.now() - this.startTime;
  }

  /**
   * 检查是否预算耗尽。
   * @throws ForgeError('BUDGET_EXCEEDED') 如果任一维度超限
   */
  check(): void {
    this.refreshTime();

    const checks: Array<[keyof BudgetLimits, keyof BudgetUsage, string]> = [
      ['maxTokens', 'tokens', 'Token 预算'],
      ['maxTimeMs', 'timeMs', '时间预算'],
      ['maxToolCalls', 'toolCalls', '工具调用预算'],
      ['maxModelCalls', 'modelCalls', '模型调用预算'],
      ['maxSteps', 'steps', '步骤预算'],
    ];

    for (const [limitKey, usageKey, label] of checks) {
      const limit = this.limits[limitKey];
      const used = this.usage[usageKey];
      if (used > limit) {
        throw new ForgeError(
          'BUDGET_EXCEEDED',
          `${label}耗尽：已用 ${used}/${limit}，请追加预算或终止任务`,
          { details: { usage: this.snapshot(), limit: this.limits } },
        );
      }
    }
  }

  /** 是否还有预算余量 */
  hasBudget(): boolean {
    this.refreshTime();
    return (
      this.usage.tokens <= this.limits.maxTokens &&
      this.usage.timeMs <= this.limits.maxTimeMs &&
      this.usage.toolCalls <= this.limits.maxToolCalls &&
      this.usage.modelCalls <= this.limits.maxModelCalls &&
      this.usage.steps <= this.limits.maxSteps
    );
  }

  /** 使用率 0-1 */
  utilization(): number {
    this.refreshTime();
    const ratios: number[] = [
      this.usage.tokens / this.limits.maxTokens,
      this.usage.timeMs / this.limits.maxTimeMs,
      this.usage.toolCalls / this.limits.maxToolCalls,
      this.usage.modelCalls / this.limits.maxModelCalls,
      this.usage.steps / this.limits.maxSteps,
    ];
    return Math.max(...ratios, 0);
  }

  snapshot(): { limits: BudgetLimits; usage: BudgetUsage } {
    this.refreshTime();
    return { limits: { ...this.limits }, usage: { ...this.usage } };
  }
}
